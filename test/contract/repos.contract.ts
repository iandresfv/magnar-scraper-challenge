/**
 * The repository contract, run against both drivers.
 *
 * The assertions that earn their place are the ones about **idempotency**, because that is the
 * property the whole resume story rests on: a second identical write must report `unchanged` and
 * touch nothing, a re-listing must not demote a detailed case, and replacing children must not
 * leave orphans from a previous version.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { CaseRecord, ListedCase, PartitionNode } from '../../src/core/domain/types.js';
import type { SqlExecutor } from '../../src/core/ports/sql.js';
import { contentHashOf } from '../../src/core/domain/hash.js';
import { migrate } from '../../src/infra/db/migrator.js';
import { createRepos } from '../../src/infra/db/repos/index.js';

export interface ReposSubject {
  name: string;
  create: () => Promise<SqlExecutor>;
}

const SITE = 'br-trf5';
const RUN_ID = '00000000-0000-4000-8000-0000000000aa';

/**
 * `(site, numero)` is unique, so a helper that returned a fixed case number would make every
 * multi-case test collide. The number is derived from the id, the way the real data relates
 * them, so that overriding one thing produces a coherent case rather than a constraint error.
 */
function caseNumberFor(idOrigem: string): string {
  return `${idOrigem.replace(/\D/g, '').padStart(7, '0').slice(-7)}-07.1985.8.20.0124`;
}

function listedCase(overrides: Partial<ListedCase> = {}): ListedCase {
  const id = overrides.idOrigem ?? '16730';
  const base: Omit<ListedCase, 'contentHash'> = {
    site: SITE,
    idOrigem: id,
    ca: 'b22ef4ac',
    numero: caseNumberFor(id),
    classe: 'APELAÇÃO CÍVEL',
    sigla: 'ApCiv',
    assuntoResumo: 'Multas e demais Sanções',
    partesResumo: 'EMPRESA X FAZENDA NACIONAL',
    ultimaMovimentacao: {
      descricao: 'Conclusos para decisão',
      dataHora: '2026-06-20T11:18:14-03:00',
    },
    partitionId: '2024-05-15..2024-05-15',
    partitionRange: { ini: '2024-05-15', fim: '2024-05-15' },
    listedAt: '2026-08-27T10:00:00-03:00',
    ...overrides,
  };
  return { ...base, contentHash: overrides.contentHash ?? contentHashOf(base) };
}

/**
 * `document` has primary key `(site, id_doc)`: a document id is unique per site, which is true
 * of TRF5's `idProcessoDoc`. The helper therefore derives child ids from `idOrigem`, so that
 * overriding the case id produces a coherent case rather than a collision the real site cannot
 * produce.
 */
function caseRecord(overrides: Partial<CaseRecord> = {}): CaseRecord {
  const id = overrides.idOrigem ?? '16730';
  const base: Omit<CaseRecord, 'contentHash'> = {
    site: SITE,
    idOrigem: id,
    numero: caseNumberFor(id),
    numeroNorm: caseNumberFor(id).replace(/\D/g, ''),
    numeroParts: null,
    classe: 'APELAÇÃO CÍVEL',
    classeCodigo: 198,
    sigla: 'ApCiv',
    assuntos: [
      { nivel: 0, codigo: 14, descricao: 'DIREITO TRIBUTÁRIO' },
      { nivel: 1, codigo: 5986, descricao: 'Crédito Tributário' },
    ],
    assuntoResumo: 'DIREITO TRIBUTÁRIO - Crédito Tributário',
    dataDistribuicao: '2024-05-15',
    dataAutuacao: { ini: '2024-05-15', fim: '2024-05-15' },
    jurisdicao: 'TRF5',
    orgaoJulgador: 'Gab VICE-PRESIDÊNCIA',
    orgaoJulgadorColegiado: 'Pleno',
    endereco: 'Cais do Apolo, s/n, Recife',
    processoReferencia: '0000007-07.1985.8.20.0124',
    partesResumo: 'EMPRESA X FAZENDA NACIONAL',
    ultimaMovimentacao: {
      descricao: 'Conclusos para decisão',
      dataHora: '2026-06-20T11:18:14-03:00',
    },
    partes: [
      {
        site: SITE,
        idOrigem: '16730',
        polo: 'ATIVO',
        ordem: 0,
        nome: 'EMPRESA NOSSA SENHORA APARECIDA LTDA',
        tipoParticipacao: 'APELANTE',
        documento: {
          kind: 'CNPJ',
          digits: '08409021000177',
          formatted: '08.409.021/0001-77',
          valid: true,
        },
        situacao: 'Ativo',
      },
      {
        site: SITE,
        idOrigem: '16730',
        polo: 'PASSIVO',
        ordem: 0,
        nome: 'FAZENDA NACIONAL',
        tipoParticipacao: 'APELADO',
        documento: null,
        situacao: 'Ativo',
      },
    ],
    advogados: [
      {
        site: SITE,
        idOrigem: '16730',
        polo: 'ATIVO',
        ordem: 0,
        nome: 'ADVOGADO EXEMPLO',
        registro: { uf: 'RN', numero: '1966' },
        documento: { kind: 'CPF', digits: '47422548487', formatted: '474.225.484-87', valid: true },
        situacao: 'Ativo',
      },
    ],
    movimentacoes: [
      {
        site: SITE,
        idOrigem: '16730',
        seq: 0,
        dataHora: '2026-06-20T11:18:14-03:00',
        descricao: 'Conclusos para decisão',
      },
      {
        site: SITE,
        idOrigem: '16730',
        seq: 1,
        dataHora: '2026-05-11T00:36:17-03:00',
        descricao: 'Juntada de Acórdão',
      },
    ],
    documentos: [
      {
        site: SITE,
        idOrigem: id,
        idDoc: `722299-${id}`,
        idBin: `712769-${id}`,
        tipo: 'Acórdão',
        juntadoEm: '2026-05-11T00:36:17-03:00',
        titulo: null,
      },
    ],
    extra: { spike: true },
    fonte: { listUrl: 'https://example/list', detailUrl: 'https://example/detail' },
    state: 'DETAILED',
    listedAt: '2026-08-27T10:00:00-03:00',
    detailedAt: '2026-08-27T10:05:00-03:00',
    ...overrides,
  };
  return { ...base, contentHash: overrides.contentHash ?? contentHashOf(base) };
}

function partition(overrides: Partial<PartitionNode> = {}): PartitionNode {
  return {
    site: SITE,
    id: '2024-05-15..2024-05-15',
    runId: RUN_ID,
    parentId: null,
    range: { ini: '2024-05-15', fim: '2024-05-15' },
    facets: {},
    status: 'LEAF_DONE',
    observedRows: 24,
    truncated: false,
    capSeen: null,
    attempts: 1,
    lastError: null,
    updatedAt: '2026-08-27T10:00:00-03:00',
    ...overrides,
  };
}

export function runReposContract(subject: ReposSubject): void {
  describe(`repositories: ${subject.name}`, () => {
    let db: SqlExecutor;
    let repos: ReturnType<typeof createRepos>;

    beforeAll(async () => {
      db = await subject.create();
      await db.query('DROP SCHEMA IF EXISTS juris CASCADE');
      await migrate(db);
      repos = createRepos(db);
    });

    afterAll(async () => {
      await db.query('DROP SCHEMA IF EXISTS juris CASCADE').catch(() => undefined);
      await db.close();
    });

    beforeEach(async () => {
      await db.query('DELETE FROM juris.blob');
      await db.query('DELETE FROM juris.case_record');
      await db.query('DELETE FROM juris.partition');
      await db.query('DELETE FROM juris.class_vocabulary');
      await db.query('DELETE FROM juris.crawl_run');
      await db.query('DELETE FROM juris.site');
      await repos.site.ensure({
        id: SITE,
        country: 'BR',
        name: 'TRF5',
        baseUrl: 'https://pjett.trf5.jus.br',
        timezone: 'America/Recife',
      });
      await repos.runs.start({
        runId: RUN_ID,
        site: SITE,
        startedAt: '2026-08-27T10:00:00-03:00',
        finishedAt: null,
        root: { ini: '2024-01-01', fim: '2024-12-31' },
        config: {},
        version: 'test',
        exitCode: null,
        summary: null,
      });
    });

    describe('site', () => {
      it('is idempotent and updates metadata in place', async () => {
        await repos.site.ensure({
          id: SITE,
          country: 'BR',
          name: 'TRF5 renamed',
          baseUrl: 'https://x',
          timezone: 'America/Recife',
        });
        const { rows } = await db.query(`SELECT name FROM juris.site WHERE id = $1`, [SITE]);
        expect(rows).toHaveLength(1);
        expect(rows[0]?.['name']).toBe('TRF5 renamed');
      });
    });

    describe('cases', () => {
      it('inserts a listing, then reports unchanged for an identical one', async () => {
        expect(await repos.cases.upsertListed(listedCase())).toBe('inserted');
        expect(await repos.cases.upsertListed(listedCase())).toBe('unchanged');
      });

      it('updates a listing whose content really changed', async () => {
        await repos.cases.upsertListed(listedCase());
        const moved = listedCase({
          ultimaMovimentacao: {
            descricao: 'Remetidos os autos',
            dataHora: '2026-07-01T09:00:00-03:00',
          },
        });
        expect(await repos.cases.upsertListed(moved)).toBe('updated');
      });

      it('never demotes a detailed case back to a listing', async () => {
        await repos.cases.upsertListed(listedCase());
        await repos.cases.upsertDetailed(caseRecord());

        // A later run lists the same case again with different listing content.
        const relisted = listedCase({
          ultimaMovimentacao: { descricao: 'Outro', dataHora: '2026-07-01T09:00:00-03:00' },
        });
        expect(await repos.cases.upsertListed(relisted)).toBe('unchanged');

        const stored = await repos.cases.get(SITE, '16730');
        expect(stored?.state).toBe('DETAILED');
        expect(stored?.orgaoJulgador).toBe('Gab VICE-PRESIDÊNCIA');
      });

      it('writes the full record with all its children', async () => {
        await repos.cases.upsertDetailed(caseRecord());
        const children = await repos.cases.children(SITE, '16730');
        expect(children.assuntos).toHaveLength(2);
        expect(children.partes).toHaveLength(2);
        expect(children.advogados).toHaveLength(1);
        expect(children.movimentacoes).toHaveLength(2);
        expect(children.documentos).toHaveLength(1);
        expect(children.advogados[0]?.registro).toEqual({ uf: 'RN', numero: '1966' });
        expect(children.partes[0]?.documento?.valid).toBe(true);
        // Punctuation is not a column; it is re-derived, so what comes back equals what went in.
        expect(children.partes[0]?.documento).toEqual(caseRecord().partes[0]?.documento);
        expect(children.advogados[0]?.documento?.formatted).toBe('474.225.484-87');
      });

      it('reports unchanged on an identical detailed write — the reason a re-run is free', async () => {
        expect(await repos.cases.upsertDetailed(caseRecord())).toBe('inserted');
        expect(await repos.cases.upsertDetailed(caseRecord())).toBe('unchanged');
      });

      it('leaves updated_at alone when nothing changed', async () => {
        await repos.cases.upsertDetailed(caseRecord());
        const before = await db.query<{ updated_at: Date }>(
          `SELECT updated_at FROM juris.case_record WHERE site=$1 AND id_origem=$2`,
          [SITE, '16730'],
        );
        await repos.cases.upsertDetailed(caseRecord());
        const after = await db.query<{ updated_at: Date }>(
          `SELECT updated_at FROM juris.case_record WHERE site=$1 AND id_origem=$2`,
          [SITE, '16730'],
        );
        expect(String(after.rows[0]?.updated_at)).toBe(String(before.rows[0]?.updated_at));
      });

      it('replaces children wholesale, leaving no orphans from the previous version', async () => {
        await repos.cases.upsertDetailed(caseRecord());
        const trimmed = caseRecord({
          movimentacoes: [
            {
              site: SITE,
              idOrigem: '16730',
              seq: 0,
              dataHora: '2026-06-20T11:18:14-03:00',
              descricao: 'Único movimento',
            },
          ],
          partes: [],
        });
        expect(await repos.cases.upsertDetailed(trimmed)).toBe('updated');
        const children = await repos.cases.children(SITE, '16730');
        expect(children.movimentacoes).toHaveLength(1);
        expect(children.partes).toHaveLength(0);
      });

      it('rolls the whole write back when a child insert fails', async () => {
        await repos.cases.upsertDetailed(caseRecord());
        // Two movements sharing a seq violate the primary key mid-transaction.
        const broken = caseRecord({
          orgaoJulgador: 'Something new so the hash differs',
          movimentacoes: [
            {
              site: SITE,
              idOrigem: '16730',
              seq: 0,
              dataHora: '2026-01-01T00:00:00-03:00',
              descricao: 'a',
            },
            {
              site: SITE,
              idOrigem: '16730',
              seq: 0,
              dataHora: '2026-01-02T00:00:00-03:00',
              descricao: 'b',
            },
          ],
        });
        await expect(repos.cases.upsertDetailed(broken)).rejects.toThrow();

        const stored = await repos.cases.get(SITE, '16730');
        expect(stored?.orgaoJulgador).toBe('Gab VICE-PRESIDÊNCIA');
        expect((await repos.cases.children(SITE, '16730')).movimentacoes).toHaveLength(2);
      });

      it('preserves non-ascii text through a round trip', async () => {
        await repos.cases.upsertDetailed(caseRecord());
        const stored = await repos.cases.get(SITE, '16730');
        expect(stored?.classe).toBe('APELAÇÃO CÍVEL');
        expect(stored?.orgaoJulgador).toBe('Gab VICE-PRESIDÊNCIA');
      });

      it('keeps a date as a calendar day, with no timezone shift', async () => {
        await repos.cases.upsertDetailed(caseRecord());
        const stored = await repos.cases.get(SITE, '16730');
        expect(stored?.dataDistribuicao).toBe('2024-05-15');
        expect(stored?.dataAutuacao).toEqual({ ini: '2024-05-15', fim: '2024-05-15' });
      });

      it('marks a detail failure without losing the listing', async () => {
        await repos.cases.upsertListed(listedCase());
        await repos.cases.markDetailFailed(SITE, '16730', 'CLIENT_ERROR');
        const stored = await repos.cases.get(SITE, '16730');
        expect(stored?.state).toBe('DETAIL_FAILED');
        expect(stored?.numero).toBe(caseNumberFor('16730'));
      });

      it('refuses to mark a detailed case as failed', async () => {
        await repos.cases.upsertDetailed(caseRecord());
        await repos.cases.markDetailFailed(SITE, '16730', 'CLIENT_ERROR');
        expect((await repos.cases.get(SITE, '16730'))?.state).toBe('DETAILED');
      });

      it('counts by state', async () => {
        await repos.cases.upsertListed(listedCase({ idOrigem: '1' }));
        await repos.cases.upsertListed(listedCase({ idOrigem: '2' }));
        await repos.cases.upsertDetailed(caseRecord({ idOrigem: '3' }));
        expect(await repos.cases.countByState(SITE)).toEqual({
          LISTED: 2,
          DETAILED: 1,
          DETAIL_FAILED: 0,
        });
      });

      it('streams every row across page boundaries', async () => {
        for (let i = 0; i < 12; i++) {
          await repos.cases.upsertListed(listedCase({ idOrigem: String(i).padStart(4, '0') }));
        }
        const seen: string[] = [];
        for await (const record of repos.cases.stream({ site: SITE })) seen.push(record.idOrigem);
        expect(seen).toHaveLength(12);
        expect(new Set(seen).size).toBe(12);
      });

      it('rejects a second case claiming the same numero', async () => {
        const numero = '0000007-07.1985.8.20.0124';
        await repos.cases.upsertListed(listedCase({ idOrigem: '1', numero }));
        await expect(
          repos.cases.upsertListed(listedCase({ idOrigem: '2', numero })),
        ).rejects.toThrow();
      });
    });

    describe('partitions', () => {
      it('saves and reloads a node with its facets', async () => {
        await repos.partitions.save(partition({ facets: { classe: 'APELAÇÃO CÍVEL' }, id: 'x' }));
        const node = await repos.partitions.get(SITE, 'x');
        expect(node?.facets).toEqual({ classe: 'APELAÇÃO CÍVEL' });
        expect(node?.observedRows).toBe(24);
        expect(node?.range).toEqual({ ini: '2024-05-15', fim: '2024-05-15' });
      });

      it('updates in place on a second save', async () => {
        await repos.partitions.save(partition());
        await repos.partitions.save(
          partition({ status: 'GAP', observedRows: 30, truncated: true }),
        );
        const node = await repos.partitions.get(SITE, '2024-05-15..2024-05-15');
        expect(node?.status).toBe('GAP');
        expect(node?.truncated).toBe(true);
      });

      it('refuses two overlapping primary leaves — the tiling invariant, enforced by the database', async () => {
        await repos.partitions.save(
          partition({ id: 'a', range: { ini: '2024-01-01', fim: '2024-01-31' } }),
        );
        await expect(
          repos.partitions.save(
            partition({ id: 'b', range: { ini: '2024-01-15', fim: '2024-02-15' } }),
          ),
        ).rejects.toThrow();
      });

      it('allows two secondary leaves on the same day', async () => {
        await repos.partitions.save(partition({ id: 'c1', facets: { classe: 'A' } }));
        await repos.partitions.save(partition({ id: 'c2', facets: { classe: 'B' } }));
        expect(await repos.partitions.listByRun(RUN_ID)).toHaveLength(2);
      });

      it('lists primary leaves in date order for the tiling check', async () => {
        await repos.partitions.save(
          partition({ id: 'b', range: { ini: '2024-02-01', fim: '2024-02-29' } }),
        );
        await repos.partitions.save(
          partition({ id: 'a', range: { ini: '2024-01-01', fim: '2024-01-31' } }),
        );
        await repos.partitions.save(partition({ id: 'sec', facets: { classe: 'A' } }));
        const leaves = await repos.partitions.primaryLeaves(RUN_ID);
        expect(leaves.map((l) => l.id)).toEqual(['a', 'b']);
      });

      it('filters by status', async () => {
        await repos.partitions.save(partition({ id: 'g', status: 'GAP' }));
        await repos.partitions.save(
          partition({
            id: 'p',
            status: 'PENDING',
            range: { ini: '2024-06-01', fim: '2024-06-01' },
          }),
        );
        expect((await repos.partitions.listByStatus(SITE, 'GAP')).map((n) => n.id)).toEqual(['g']);
      });
    });

    describe('blobs', () => {
      beforeEach(async () => {
        await repos.cases.upsertListed(listedCase());
      });

      const pending = {
        site: SITE,
        key: 'relatorio:16730',
        idOrigem: '16730',
        idDoc: null,
        tipo: 'relatorio',
        sourceUrl: 'https://example/reportPDF.seam?idProcessoTrf=16730',
        storageUri: null,
        state: 'PENDING' as const,
        bytes: null,
        sha256: null,
        contentType: null,
        storedAt: null,
      };

      it('registers and stores', async () => {
        await repos.blobs.register(pending);
        await repos.blobs.markStored(SITE, 'relatorio:16730', {
          storageUri: 's3://juris/br-trf5/2024/x.pdf',
          bytes: 23_340,
          sha256: 'a'.repeat(64),
          contentType: 'application/pdf',
        });
        const blob = await repos.blobs.get(SITE, 'relatorio:16730');
        expect(blob?.state).toBe('STORED');
        expect(blob?.bytes).toBe(23_340);
      });

      it('never resets a stored blob back to pending on re-registration', async () => {
        await repos.blobs.register(pending);
        await repos.blobs.markStored(SITE, 'relatorio:16730', {
          storageUri: 's3://juris/x.pdf',
          bytes: 100,
          sha256: 'b'.repeat(64),
          contentType: 'application/pdf',
        });
        await repos.blobs.register(pending);
        const blob = await repos.blobs.get(SITE, 'relatorio:16730');
        expect(blob?.state).toBe('STORED');
        expect(blob?.storageUri).toBe('s3://juris/x.pdf');
      });

      it('refuses two blobs at the same storage uri', async () => {
        await repos.blobs.register(pending);
        await repos.blobs.register({ ...pending, key: 'recibo:16730:1', idDoc: '1' });
        await repos.blobs.markStored(SITE, 'relatorio:16730', {
          storageUri: 's3://juris/same.pdf',
          bytes: 1,
          sha256: 'c'.repeat(64),
          contentType: 'application/pdf',
        });
        await expect(
          repos.blobs.markStored(SITE, 'recibo:16730:1', {
            storageUri: 's3://juris/same.pdf',
            bytes: 1,
            sha256: 'd'.repeat(64),
            contentType: 'application/pdf',
          }),
        ).rejects.toThrow();
      });

      it('counts by state and streams', async () => {
        await repos.blobs.register(pending);
        await repos.blobs.register({ ...pending, key: 'recibo:16730:1', idDoc: '1' });
        expect((await repos.blobs.countByState(SITE))['PENDING']).toBe(2);
        const seen: string[] = [];
        for await (const blob of repos.blobs.stream({ site: SITE })) seen.push(blob.key);
        expect(seen.sort()).toEqual(['recibo:16730:1', 'relatorio:16730']);
      });

      it('cascades when its case is deleted', async () => {
        await repos.blobs.register(pending);
        await db.query(`DELETE FROM juris.case_record WHERE site=$1 AND id_origem=$2`, [
          SITE,
          '16730',
        ]);
        expect(await repos.blobs.get(SITE, 'relatorio:16730')).toBeNull();
      });
    });

    describe('vocabulary', () => {
      it('counts only genuinely new values', async () => {
        expect(await repos.vocabulary.observe(SITE, 'classe', ['A', 'B'])).toBe(2);
        expect(await repos.vocabulary.observe(SITE, 'classe', ['A', 'B'])).toBe(0);
        expect(await repos.vocabulary.observe(SITE, 'classe', ['B', 'C'])).toBe(1);
        expect(await repos.vocabulary.values(SITE, 'classe')).toEqual(['A', 'B', 'C']);
      });

      it('deduplicates within a single call', async () => {
        expect(await repos.vocabulary.observe(SITE, 'classe', ['X', 'X', 'X'])).toBe(1);
      });

      it('keeps facets apart', async () => {
        await repos.vocabulary.observe(SITE, 'classe', ['A']);
        await repos.vocabulary.observe(SITE, 'orgao', ['A']);
        expect(await repos.vocabulary.values(SITE, 'orgao')).toEqual(['A']);
      });
    });

    describe('runs and reports', () => {
      it('finishes a run with its exit code and summary', async () => {
        await repos.runs.finish(RUN_ID, { exitCode: 0, summary: { cases: 24 } });
        const run = await repos.runs.get(RUN_ID);
        expect(run?.exitCode).toBe(0);
        expect(run?.summary).toEqual({ cases: 24 });
        expect(run?.finishedAt).not.toBeNull();
        expect(run?.root).toEqual({ ini: '2024-01-01', fim: '2024-12-31' });
      });

      it('finds the latest run for a site', async () => {
        expect((await repos.runs.latest(SITE))?.runId).toBe(RUN_ID);
      });

      it('aggregates cases per month', async () => {
        await repos.cases.upsertListed(listedCase({ idOrigem: '1' }));
        await repos.cases.upsertListed(
          listedCase({
            idOrigem: '2',
            numero: '0000008-07.1985.8.20.0124',
            partitionRange: { ini: '2024-06-01', fim: '2024-06-01' },
          }),
        );
        const months = await repos.reports.casesPerMonth(SITE);
        expect(months).toEqual([
          { yearMonth: '2024-05', cases: 1, leaves: 1 },
          { yearMonth: '2024-06', cases: 1, leaves: 1 },
        ]);
      });

      it('compares observed rows against unique cases', async () => {
        await repos.partitions.save(partition({ observedRows: 2 }));
        await repos.cases.upsertListed(listedCase({ idOrigem: '1' }));
        await repos.cases.upsertListed(
          listedCase({ idOrigem: '2', numero: '0000008-07.1985.8.20.0124' }),
        );
        expect(await repos.reports.observedRowsVsUnique(RUN_ID)).toEqual({
          observed: 2,
          unique: 2,
        });
      });

      it('lists gaps', async () => {
        await repos.partitions.save(partition({ id: 'gap', status: 'GAP' }));
        expect(await repos.reports.gapPartitions(RUN_ID)).toHaveLength(1);
      });

      it('computes null rates over detailed cases only', async () => {
        await repos.cases.upsertDetailed(caseRecord({ idOrigem: '1' }));
        await repos.cases.upsertDetailed(
          caseRecord({
            idOrigem: '2',
            numero: '0000008-07.1985.8.20.0124',
            numeroNorm: '00000080719858200124',
            dataDistribuicao: null,
          }),
        );
        const rates = await repos.reports.nullRates(SITE);
        expect(rates['data_distribuicao']).toBeCloseTo(0.5);
        expect(rates['numero']).toBe(0);
      });

      it('returns the root range of a run', async () => {
        expect(await repos.reports.rootRange(RUN_ID)).toEqual({
          ini: '2024-01-01',
          fim: '2024-12-31',
        });
      });
    });

    describe('metrics', () => {
      it('writes a batch in one statement', async () => {
        await repos.metrics.write([
          { runId: RUN_ID, site: SITE, name: 'requests', labels: { kind: 'search' }, value: 3 },
          { runId: RUN_ID, site: SITE, name: 'requests', labels: { kind: 'detail' }, value: 5 },
        ]);
        const { rows } = await db.query(`SELECT name, value FROM juris.metric ORDER BY value`);
        expect(rows).toHaveLength(2);
      });

      it('tolerates an empty batch', async () => {
        await expect(repos.metrics.write([])).resolves.toBeUndefined();
      });
    });
  });
}
