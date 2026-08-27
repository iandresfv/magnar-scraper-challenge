/**
 * The case repository — the one that carries the idempotency guarantee.
 *
 * Two writes matter:
 *
 * `upsertListed` runs when a search row is seen. It must not clobber a case that has already
 * been detailed: a listing knows nothing about parties or movements, and a re-listed case whose
 * detail was fetched last week would otherwise be downgraded back to `LISTED` and re-fetched
 * forever. So the update is guarded on `estado = 'LISTED'`.
 *
 * `upsertDetailed` writes the full record. Its guard is
 * `WHERE content_hash IS DISTINCT FROM EXCLUDED.content_hash`, which is what makes a second run
 * over unchanged data cost **zero writes** — no row versions, no WAL, no `updated_at` churn.
 * The children are deleted and re-inserted inside the same transaction rather than diffed:
 * replacement is exactly idempotent, and inventing a stable natural key for "the seventh
 * movement" would be a fiction the source does not support.
 */
import type {
  CaseDocument,
  CaseRecord,
  DateRange,
  Lawyer,
  ListedCase,
  Movement,
  Party,
  Polo,
  Subject,
} from '../../../core/domain/types.js';
import type { CaseRepo, Tx, UpsertOutcome } from '../../../core/ports/repos.js';
import type { SqlExecutor, SqlSession } from '../../../core/ports/sql.js';
import { normalizeCaseNumber, parseCaseNumber } from '../../../core/domain/cnj.js';
import { parsePersonId } from '../../../core/domain/personId.js';
import {
  readJson,
  readNumberOrNull,
  readString,
  readStringOrNull,
  readTimestamp,
  readTimestampOrNull,
} from './rowMapping.js';

export class PgCaseRepo implements CaseRepo {
  constructor(private readonly db: SqlExecutor) {}

  private session(tx: Tx): SqlSession {
    return tx ?? this.db;
  }

  async upsertListed(listed: ListedCase, tx?: Tx): Promise<UpsertOutcome> {
    const s = this.session(tx);
    const numeroNorm = normalizeCaseNumber(listed.numero);

    // The listing carries no detail fields, so the hash covers only what a listing can know.
    const { rows } = await s.query<{ inserted: boolean }>(
      `INSERT INTO juris.case_record (
         site, id_origem, numero, numero_norm, classe, assunto_resumo,
         data_autuacao_ini, data_autuacao_fim, partes_resumo,
         ultima_mov_descricao, ultima_mov_em,
         estado, content_hash, extra, listed_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'LISTED',$12,$13,$14)
       ON CONFLICT (site, id_origem) DO UPDATE SET
         numero = EXCLUDED.numero,
         numero_norm = EXCLUDED.numero_norm,
         classe = EXCLUDED.classe,
         assunto_resumo = EXCLUDED.assunto_resumo,
         data_autuacao_ini = EXCLUDED.data_autuacao_ini,
         data_autuacao_fim = EXCLUDED.data_autuacao_fim,
         partes_resumo = EXCLUDED.partes_resumo,
         ultima_mov_descricao = EXCLUDED.ultima_mov_descricao,
         ultima_mov_em = EXCLUDED.ultima_mov_em,
         updated_at = now()
       -- Never demote a detailed case back to a listing, and never rewrite an identical one.
       WHERE juris.case_record.estado = 'LISTED'
         AND juris.case_record.content_hash IS DISTINCT FROM EXCLUDED.content_hash
       RETURNING (xmax = 0) AS inserted`,
      [
        listed.site,
        listed.idOrigem,
        listed.numero,
        numeroNorm,
        listed.classe,
        listed.assuntoResumo,
        listed.partitionRange.ini,
        listed.partitionRange.fim,
        listed.partesResumo,
        listed.ultimaMovimentacao?.descricao ?? null,
        listed.ultimaMovimentacao?.dataHora ?? null,
        listed.contentHash,
        JSON.stringify({ partitionId: listed.partitionId, sigla: listed.sigla }),
        listed.listedAt,
      ],
    );

    if (rows.length === 0) return 'unchanged';
    return rows[0]?.inserted === true ? 'inserted' : 'updated';
  }

  async upsertDetailed(record: CaseRecord, tx?: Tx): Promise<UpsertOutcome> {
    // Children must land in the same transaction as the parent, or a crash between them leaves
    // a case whose parties belong to a previous version of it.
    const run = async (s: SqlSession): Promise<UpsertOutcome> => {
      const { rows } = await s.query<{ inserted: boolean }>(
        `INSERT INTO juris.case_record (
           site, id_origem, numero, numero_norm, classe, classe_codigo, assunto_resumo,
           data_distribuicao, data_autuacao_ini, data_autuacao_fim,
           jurisdicao, orgao_julgador, orgao_julgador_colegiado, endereco, processo_referencia,
           partes_resumo, ultima_mov_descricao, ultima_mov_em,
           estado, content_hash, extra, listed_at, detailed_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,'DETAILED',$19,$20,$21,$22)
         ON CONFLICT (site, id_origem) DO UPDATE SET
           numero = EXCLUDED.numero,
           numero_norm = EXCLUDED.numero_norm,
           classe = EXCLUDED.classe,
           classe_codigo = EXCLUDED.classe_codigo,
           assunto_resumo = EXCLUDED.assunto_resumo,
           data_distribuicao = EXCLUDED.data_distribuicao,
           data_autuacao_ini = EXCLUDED.data_autuacao_ini,
           data_autuacao_fim = EXCLUDED.data_autuacao_fim,
           jurisdicao = EXCLUDED.jurisdicao,
           orgao_julgador = EXCLUDED.orgao_julgador,
           orgao_julgador_colegiado = EXCLUDED.orgao_julgador_colegiado,
           endereco = EXCLUDED.endereco,
           processo_referencia = EXCLUDED.processo_referencia,
           partes_resumo = EXCLUDED.partes_resumo,
           ultima_mov_descricao = EXCLUDED.ultima_mov_descricao,
           ultima_mov_em = EXCLUDED.ultima_mov_em,
           estado = 'DETAILED',
           content_hash = EXCLUDED.content_hash,
           extra = EXCLUDED.extra,
           detailed_at = EXCLUDED.detailed_at,
           updated_at = now()
         -- The line that makes a re-run free.
         WHERE juris.case_record.content_hash IS DISTINCT FROM EXCLUDED.content_hash
         RETURNING (xmax = 0) AS inserted`,
        [
          record.site,
          record.idOrigem,
          record.numero,
          record.numeroNorm,
          record.classe,
          record.classeCodigo,
          record.assuntoResumo,
          record.dataDistribuicao,
          record.dataAutuacao.ini,
          record.dataAutuacao.fim,
          record.jurisdicao,
          record.orgaoJulgador,
          record.orgaoJulgadorColegiado,
          record.endereco,
          record.processoReferencia,
          record.partesResumo,
          record.ultimaMovimentacao?.descricao ?? null,
          record.ultimaMovimentacao?.dataHora ?? null,
          record.contentHash,
          JSON.stringify({ ...record.extra, sigla: record.sigla, fonte: record.fonte }),
          record.listedAt,
          record.detailedAt,
        ],
      );

      if (rows.length === 0) return 'unchanged';
      await this.replaceChildren(s, record);
      return rows[0]?.inserted === true ? 'inserted' : 'updated';
    };

    return tx === undefined ? this.db.transaction(run) : run(tx);
  }

  private async replaceChildren(s: SqlSession, record: CaseRecord): Promise<void> {
    const key = [record.site, record.idOrigem];
    for (const table of ['subject', 'party', 'lawyer', 'movement', 'document']) {
      await s.query(`DELETE FROM juris.${table} WHERE site = $1 AND id_origem = $2`, key);
    }

    for (const subject of record.assuntos) {
      await s.query(
        `INSERT INTO juris.subject (site, id_origem, nivel, codigo, descricao)
         VALUES ($1,$2,$3,$4,$5)`,
        [record.site, record.idOrigem, subject.nivel, subject.codigo, subject.descricao],
      );
    }

    for (const party of record.partes) {
      await s.query(
        `INSERT INTO juris.party
           (site, id_origem, polo, ordem, nome, tipo_participacao,
            doc_tipo, doc_digitos, doc_valido, situacao)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          record.site,
          record.idOrigem,
          party.polo,
          party.ordem,
          party.nome,
          party.tipoParticipacao,
          party.documento?.kind ?? null,
          party.documento?.digits ?? null,
          party.documento?.valid ?? null,
          party.situacao,
        ],
      );
    }

    for (const lawyer of record.advogados) {
      await s.query(
        `INSERT INTO juris.lawyer
           (site, id_origem, polo, ordem, nome, registro_uf, registro_numero,
            doc_tipo, doc_digitos, situacao)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          record.site,
          record.idOrigem,
          lawyer.polo,
          lawyer.ordem,
          lawyer.nome,
          lawyer.registro?.uf ?? null,
          lawyer.registro?.numero ?? null,
          lawyer.documento?.kind ?? null,
          lawyer.documento?.digits ?? null,
          lawyer.situacao,
        ],
      );
    }

    for (const movement of record.movimentacoes) {
      await s.query(
        `INSERT INTO juris.movement (site, id_origem, seq, data_hora, descricao)
         VALUES ($1,$2,$3,$4,$5)`,
        [record.site, record.idOrigem, movement.seq, movement.dataHora, movement.descricao],
      );
    }

    for (const document of record.documentos) {
      await s.query(
        `INSERT INTO juris.document (site, id_origem, id_doc, id_bin, tipo, juntado_em, titulo)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [
          record.site,
          record.idOrigem,
          document.idDoc,
          document.idBin,
          document.tipo,
          document.juntadoEm,
          document.titulo,
        ],
      );
    }
  }

  async markDetailFailed(site: string, idOrigem: string, reason: string, tx?: Tx): Promise<void> {
    await this.session(tx).query(
      `UPDATE juris.case_record
       SET estado = 'DETAIL_FAILED',
           extra = extra || jsonb_build_object('detailFailure', $3::text),
           updated_at = now()
       WHERE site = $1 AND id_origem = $2 AND estado <> 'DETAILED'`,
      [site, idOrigem, reason],
    );
  }

  async get(site: string, idOrigem: string): Promise<CaseRecord | null> {
    const { rows } = await this.db.query(
      `SELECT * FROM juris.case_record WHERE site = $1 AND id_origem = $2`,
      [site, idOrigem],
    );
    const row = rows[0];
    return row === undefined ? null : this.hydrate(row);
  }

  async countByState(site: string): Promise<Record<string, number>> {
    const { rows } = await this.db.query<{ estado: string; n: string | number }>(
      `SELECT estado, count(*) AS n FROM juris.case_record WHERE site = $1 GROUP BY estado`,
      [site],
    );
    const out: Record<string, number> = { LISTED: 0, DETAILED: 0, DETAIL_FAILED: 0 };
    for (const row of rows) out[row.estado] = Number(row.n);
    return out;
  }

  async *stream(filter: { site: string; state?: CaseRecord['state'] }): AsyncIterable<CaseRecord> {
    // Paged by primary key rather than OFFSET: an export must not hold a run in memory, and
    // keyset pagination stays O(1) per page while OFFSET degrades.
    const PAGE = 500;
    let after = '';
    for (;;) {
      const { rows } = await this.db.query(
        `SELECT * FROM juris.case_record
         WHERE site = $1 AND id_origem > $2
           AND ($3::text IS NULL OR estado = $3)
         ORDER BY id_origem
         LIMIT ${String(PAGE)}`,
        [filter.site, after, filter.state ?? null],
      );
      if (rows.length === 0) return;
      for (const row of rows) {
        yield this.hydrate(row);
        after = readString(row, 'id_origem');
      }
      if (rows.length < PAGE) return;
    }
  }

  /** Reads the parent row. Children are loaded on demand by the export and report paths. */
  private hydrate(row: Record<string, unknown>): CaseRecord {
    const extra = readJson<Record<string, unknown>>(row, 'extra', {});
    const numero = readString(row, 'numero');
    const range: DateRange = {
      ini: readString(row, 'data_autuacao_ini').slice(0, 10),
      fim: readString(row, 'data_autuacao_fim').slice(0, 10),
    };
    const ultimaDescricao = readStringOrNull(row, 'ultima_mov_descricao');
    const ultimaEm = readTimestampOrNull(row, 'ultima_mov_em');

    return {
      site: readString(row, 'site'),
      idOrigem: readString(row, 'id_origem'),
      numero,
      numeroNorm: readString(row, 'numero_norm'),
      numeroParts: parseCaseNumber(numero),
      classe: readString(row, 'classe'),
      classeCodigo: readNumberOrNull(row, 'classe_codigo'),
      sigla: typeof extra['sigla'] === 'string' ? extra['sigla'] : null,
      assuntos: [],
      assuntoResumo: readString(row, 'assunto_resumo'),
      dataDistribuicao: readStringOrNull(row, 'data_distribuicao')?.slice(0, 10) ?? null,
      dataAutuacao: range,
      jurisdicao: readStringOrNull(row, 'jurisdicao'),
      orgaoJulgador: readStringOrNull(row, 'orgao_julgador'),
      orgaoJulgadorColegiado: readStringOrNull(row, 'orgao_julgador_colegiado'),
      endereco: readStringOrNull(row, 'endereco'),
      processoReferencia: readStringOrNull(row, 'processo_referencia'),
      partesResumo: readString(row, 'partes_resumo'),
      ultimaMovimentacao:
        ultimaDescricao === null || ultimaEm === null
          ? null
          : { descricao: ultimaDescricao, dataHora: ultimaEm },
      partes: [],
      advogados: [],
      movimentacoes: [],
      documentos: [],
      extra,
      fonte: (extra['fonte'] as CaseRecord['fonte'] | undefined) ?? {
        listUrl: '',
        detailUrl: null,
      },
      contentHash: readString(row, 'content_hash'),
      state: readString(row, 'estado') as CaseRecord['state'],
      listedAt: readTimestamp(row, 'listed_at'),
      detailedAt: readTimestampOrNull(row, 'detailed_at'),
    };
  }

  /** Loads the children of one case. Separate from `get` so the hot path stays one query. */
  async children(
    site: string,
    idOrigem: string,
  ): Promise<{
    assuntos: Subject[];
    partes: Party[];
    advogados: Lawyer[];
    movimentacoes: Movement[];
    documentos: CaseDocument[];
  }> {
    const key = [site, idOrigem];
    const [subjects, parties, lawyers, movements, documents] = await Promise.all([
      this.db.query(
        `SELECT * FROM juris.subject WHERE site=$1 AND id_origem=$2 ORDER BY nivel`,
        key,
      ),
      this.db.query(
        `SELECT * FROM juris.party WHERE site=$1 AND id_origem=$2 ORDER BY polo, ordem`,
        key,
      ),
      this.db.query(
        `SELECT * FROM juris.lawyer WHERE site=$1 AND id_origem=$2 ORDER BY polo, ordem`,
        key,
      ),
      this.db.query(
        `SELECT * FROM juris.movement WHERE site=$1 AND id_origem=$2 ORDER BY seq`,
        key,
      ),
      this.db.query(
        `SELECT * FROM juris.document WHERE site=$1 AND id_origem=$2 ORDER BY id_doc`,
        key,
      ),
    ]);

    return {
      assuntos: subjects.rows.map((r) => ({
        nivel: Number(readString(r, 'nivel')),
        codigo: readNumberOrNull(r, 'codigo'),
        descricao: readString(r, 'descricao'),
      })),
      partes: parties.rows.map((r) => ({
        site,
        idOrigem,
        polo: readString(r, 'polo') as Polo,
        ordem: Number(readString(r, 'ordem')),
        nome: readString(r, 'nome'),
        tipoParticipacao: readString(r, 'tipo_participacao'),
        documento: hydrateDocument(r),
        situacao: readStringOrNull(r, 'situacao'),
      })),
      advogados: lawyers.rows.map((r) => {
        const uf = readStringOrNull(r, 'registro_uf');
        const numero = readStringOrNull(r, 'registro_numero');
        return {
          site,
          idOrigem,
          polo: readString(r, 'polo') as Polo,
          ordem: Number(readString(r, 'ordem')),
          nome: readString(r, 'nome'),
          registro: uf === null || numero === null ? null : { uf, numero },
          documento: hydrateDocument(r),
          situacao: readStringOrNull(r, 'situacao'),
        };
      }),
      movimentacoes: movements.rows.map((r) => ({
        site,
        idOrigem,
        seq: Number(readString(r, 'seq')),
        dataHora: readTimestamp(r, 'data_hora'),
        descricao: readString(r, 'descricao'),
      })),
      documentos: documents.rows.map((r) => ({
        site,
        idOrigem,
        idDoc: readString(r, 'id_doc'),
        idBin: readStringOrNull(r, 'id_bin'),
        tipo: readString(r, 'tipo'),
        juntadoEm: readTimestampOrNull(r, 'juntado_em'),
        titulo: readStringOrNull(r, 'titulo'),
      })),
    };
  }
}

function hydrateDocument(row: Record<string, unknown>): Party['documento'] {
  const kind = readStringOrNull(row, 'doc_tipo') as NonNullable<Party['documento']>['kind'] | null;
  const digits = readStringOrNull(row, 'doc_digitos');
  if (kind === null) return null;
  // Only the digits are stored: punctuation is derivable, and storing it would let the two
  // disagree. So it is re-derived on the way out, which is what makes a party read back equal to
  // the one that was written — including in `reports/sample.md`, which prints `formatted`.
  const reparsed = digits === null ? null : parsePersonId(kind, digits);
  return {
    kind,
    digits,
    formatted: reparsed?.formatted ?? digits ?? '***',
    valid: (row['doc_valido'] as boolean | null | undefined) ?? null,
  };
}
