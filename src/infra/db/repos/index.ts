/**
 * The remaining repositories, and the factory that assembles them.
 *
 * These are smaller than `caseRepo` and share one shape: explicit SQL, `$n` placeholders only,
 * an optional `SqlSession` so a caller can pull them into its own transaction, and no behaviour
 * beyond translating between rows and domain values. Anything that decides something belongs in
 * `core/`, not here.
 */
import type {
  BlobRecord,
  CrawlRun,
  DateRange,
  PartitionNode,
  PartitionStatus,
} from '../../../core/domain/types.js';
import type {
  BlobRepo,
  MetricRepo,
  PartitionRepo,
  ReportRepo,
  Repos,
  RunRepo,
  SiteRepo,
  Tx,
  VocabularyRepo,
} from '../../../core/ports/repos.js';
import type { SqlExecutor, SqlSession } from '../../../core/ports/sql.js';
import {
  readBooleanOrNull,
  readJson,
  readNumber,
  readNumberOrNull,
  readString,
  readStringOrNull,
  readTimestamp,
  readTimestampOrNull,
} from './rowMapping.js';
import { PgCaseRepo } from './caseRepo.js';

const use = (db: SqlExecutor, tx: Tx): SqlSession => tx ?? db;

export class PgSiteRepo implements SiteRepo {
  constructor(private readonly db: SqlExecutor) {}

  async ensure(descriptor: {
    id: string;
    country: string;
    name: string;
    baseUrl: string;
    timezone: string;
  }): Promise<void> {
    await this.db.query(
      `INSERT INTO juris.site (id, country, name, base_url, timezone)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (id) DO UPDATE SET
         country = EXCLUDED.country, name = EXCLUDED.name,
         base_url = EXCLUDED.base_url, timezone = EXCLUDED.timezone`,
      [descriptor.id, descriptor.country, descriptor.name, descriptor.baseUrl, descriptor.timezone],
    );
  }
}

export class PgPartitionRepo implements PartitionRepo {
  constructor(private readonly db: SqlExecutor) {}

  async save(node: PartitionNode, tx?: Tx): Promise<void> {
    await use(this.db, tx).query(
      `INSERT INTO juris.partition
         (site, id, run_id, parent_id, data_ini, data_fim, facets, status,
          observed_rows, truncated, cap_seen, attempts, last_error, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,now())
       ON CONFLICT (site, id) DO UPDATE SET
         run_id = EXCLUDED.run_id,
         parent_id = EXCLUDED.parent_id,
         status = EXCLUDED.status,
         facets = EXCLUDED.facets,
         observed_rows = EXCLUDED.observed_rows,
         truncated = EXCLUDED.truncated,
         cap_seen = EXCLUDED.cap_seen,
         attempts = EXCLUDED.attempts,
         last_error = EXCLUDED.last_error,
         updated_at = now()`,
      [
        node.site,
        node.id,
        node.runId,
        node.parentId,
        node.range.ini,
        node.range.fim,
        JSON.stringify(node.facets),
        node.status,
        node.observedRows,
        node.truncated,
        node.capSeen,
        node.attempts,
        node.lastError,
      ],
    );
  }

  async get(site: string, id: string): Promise<PartitionNode | null> {
    const { rows } = await this.db.query(
      `SELECT * FROM juris.partition WHERE site = $1 AND id = $2`,
      [site, id],
    );
    const row = rows[0];
    return row === undefined ? null : hydratePartition(row);
  }

  async listByRun(runId: string): Promise<PartitionNode[]> {
    const { rows } = await this.db.query(
      `SELECT * FROM juris.partition WHERE run_id = $1 ORDER BY data_ini, id`,
      [runId],
    );
    return rows.map(hydratePartition);
  }

  async listByStatus(site: string, status: PartitionStatus): Promise<PartitionNode[]> {
    const { rows } = await this.db.query(
      `SELECT * FROM juris.partition WHERE site = $1 AND status = $2 ORDER BY data_ini, id`,
      [site, status],
    );
    return rows.map(hydratePartition);
  }

  async primaryLeaves(runId: string): Promise<PartitionNode[]> {
    // The nodes that account for their whole date range: resolved leaves, declared gaps, and
    // days that were subdivided by class (those are still covered once, by themselves). Must
    // match COVERING_STATUSES in the engine, or the tiling check and the database would be
    // arguing about different sets.
    const { rows } = await this.db.query(
      `SELECT * FROM juris.partition
       WHERE run_id = $1
         AND status IN ('LEAF_DONE','GAP','SPLIT_SECONDARY')
         AND facets = '{}'::jsonb
       ORDER BY data_ini`,
      [runId],
    );
    return rows.map(hydratePartition);
  }
}

function hydratePartition(row: Record<string, unknown>): PartitionNode {
  return {
    site: readString(row, 'site'),
    id: readString(row, 'id'),
    runId: readString(row, 'run_id'),
    parentId: readStringOrNull(row, 'parent_id'),
    range: {
      ini: readString(row, 'data_ini').slice(0, 10),
      fim: readString(row, 'data_fim').slice(0, 10),
    },
    facets: readJson<Record<string, string>>(row, 'facets', {}),
    status: readString(row, 'status') as PartitionStatus,
    observedRows: readNumberOrNull(row, 'observed_rows'),
    truncated: readBooleanOrNull(row, 'truncated'),
    capSeen: readNumberOrNull(row, 'cap_seen'),
    attempts: readNumber(row, 'attempts'),
    lastError: readStringOrNull(row, 'last_error'),
    updatedAt: readTimestamp(row, 'updated_at'),
  };
}

export class PgBlobRepo implements BlobRepo {
  constructor(private readonly db: SqlExecutor) {}

  async register(record: BlobRecord, tx?: Tx): Promise<void> {
    // Registering a known blob must never reset a stored one back to PENDING: the detail job
    // re-runs on resume and would otherwise schedule every PDF for re-download.
    await use(this.db, tx).query(
      `INSERT INTO juris.blob
         (site, key, id_origem, id_doc, tipo, source_url, storage_uri, estado,
          bytes, sha256, content_type, stored_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (site, key) DO UPDATE SET
         source_url = EXCLUDED.source_url
       WHERE juris.blob.estado = 'PENDING'`,
      [
        record.site,
        record.key,
        record.idOrigem,
        record.idDoc,
        record.tipo,
        record.sourceUrl,
        record.storageUri,
        record.state,
        record.bytes,
        record.sha256,
        record.contentType,
        record.storedAt,
      ],
    );
  }

  async markStored(
    site: string,
    key: string,
    info: { storageUri: string; bytes: number; sha256: string; contentType: string },
    tx?: Tx,
  ): Promise<void> {
    await use(this.db, tx).query(
      `UPDATE juris.blob
       SET estado='STORED', storage_uri=$3, bytes=$4, sha256=$5, content_type=$6, stored_at=now()
       WHERE site=$1 AND key=$2`,
      [site, key, info.storageUri, info.bytes, info.sha256, info.contentType],
    );
  }

  async markFailed(site: string, key: string, reason: string, tx?: Tx): Promise<void> {
    await use(this.db, tx).query(
      `UPDATE juris.blob SET estado='FAILED', content_type=$3 WHERE site=$1 AND key=$2`,
      [site, key, reason.slice(0, 200)],
    );
  }

  async get(site: string, key: string): Promise<BlobRecord | null> {
    const { rows } = await this.db.query(`SELECT * FROM juris.blob WHERE site=$1 AND key=$2`, [
      site,
      key,
    ]);
    const row = rows[0];
    return row === undefined ? null : hydrateBlob(row);
  }

  async countByState(site: string): Promise<Record<string, number>> {
    const { rows } = await this.db.query<{ estado: string; n: string | number }>(
      `SELECT estado, count(*) AS n FROM juris.blob WHERE site=$1 GROUP BY estado`,
      [site],
    );
    const out: Record<string, number> = { PENDING: 0, STORED: 0, FAILED: 0, SKIPPED: 0 };
    for (const row of rows) out[row.estado] = Number(row.n);
    return out;
  }

  async *stream(filter: { site: string; state?: BlobRecord['state'] }): AsyncIterable<BlobRecord> {
    const PAGE = 500;
    let after = '';
    for (;;) {
      const { rows } = await this.db.query(
        `SELECT * FROM juris.blob
         WHERE site=$1 AND key > $2 AND ($3::text IS NULL OR estado = $3)
         ORDER BY key LIMIT ${String(PAGE)}`,
        [filter.site, after, filter.state ?? null],
      );
      if (rows.length === 0) return;
      for (const row of rows) {
        yield hydrateBlob(row);
        after = readString(row, 'key');
      }
      if (rows.length < PAGE) return;
    }
  }
}

function hydrateBlob(row: Record<string, unknown>): BlobRecord {
  return {
    site: readString(row, 'site'),
    key: readString(row, 'key'),
    idOrigem: readString(row, 'id_origem'),
    idDoc: readStringOrNull(row, 'id_doc'),
    tipo: readString(row, 'tipo'),
    sourceUrl: readString(row, 'source_url'),
    storageUri: readStringOrNull(row, 'storage_uri'),
    state: readString(row, 'estado') as BlobRecord['state'],
    bytes: readNumberOrNull(row, 'bytes'),
    sha256: readStringOrNull(row, 'sha256'),
    contentType: readStringOrNull(row, 'content_type'),
    storedAt: readTimestampOrNull(row, 'stored_at'),
  };
}

export class PgVocabularyRepo implements VocabularyRepo {
  constructor(private readonly db: SqlExecutor) {}

  async observe(site: string, facet: string, values: readonly string[], tx?: Tx): Promise<number> {
    if (values.length === 0) return 0;
    const s = use(this.db, tx);
    let added = 0;
    for (const value of new Set(values)) {
      const { rows } = await s.query(
        `INSERT INTO juris.class_vocabulary (site, facet, value) VALUES ($1,$2,$3)
         ON CONFLICT (site, facet, value) DO NOTHING
         RETURNING value`,
        [site, facet, value],
      );
      if (rows.length > 0) added++;
    }
    return added;
  }

  async values(site: string, facet: string): Promise<string[]> {
    const { rows } = await this.db.query(
      `SELECT value FROM juris.class_vocabulary WHERE site=$1 AND facet=$2 ORDER BY value`,
      [site, facet],
    );
    return rows.map((r) => readString(r, 'value'));
  }
}

export class PgRunRepo implements RunRepo {
  constructor(private readonly db: SqlExecutor) {}

  async start(run: CrawlRun): Promise<void> {
    await this.db.query(
      `INSERT INTO juris.crawl_run (run_id, site, started_at, root_ini, root_fim, config, version)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (run_id) DO NOTHING`,
      [
        run.runId,
        run.site,
        run.startedAt,
        run.root.ini,
        run.root.fim,
        JSON.stringify(run.config),
        run.version,
      ],
    );
  }

  async finish(
    runId: string,
    result: { exitCode: number; summary: Record<string, unknown> },
  ): Promise<void> {
    await this.db.query(
      `UPDATE juris.crawl_run SET finished_at=now(), exit_code=$2, summary=$3 WHERE run_id=$1`,
      [runId, result.exitCode, JSON.stringify(result.summary)],
    );
  }

  async get(runId: string): Promise<CrawlRun | null> {
    const { rows } = await this.db.query(`SELECT * FROM juris.crawl_run WHERE run_id=$1`, [runId]);
    const row = rows[0];
    return row === undefined ? null : hydrateRun(row);
  }

  async latest(site: string): Promise<CrawlRun | null> {
    const { rows } = await this.db.query(
      `SELECT * FROM juris.crawl_run WHERE site=$1 ORDER BY started_at DESC LIMIT 1`,
      [site],
    );
    const row = rows[0];
    return row === undefined ? null : hydrateRun(row);
  }
}

function hydrateRun(row: Record<string, unknown>): CrawlRun {
  return {
    runId: readString(row, 'run_id'),
    site: readString(row, 'site'),
    startedAt: readTimestamp(row, 'started_at'),
    finishedAt: readTimestampOrNull(row, 'finished_at'),
    root: {
      ini: readString(row, 'root_ini').slice(0, 10),
      fim: readString(row, 'root_fim').slice(0, 10),
    },
    config: readJson<Record<string, unknown>>(row, 'config', {}),
    version: readString(row, 'version'),
    exitCode: readNumberOrNull(row, 'exit_code'),
    summary: readJson<Record<string, unknown> | null>(row, 'summary', null),
  };
}

export class PgMetricRepo implements MetricRepo {
  constructor(private readonly db: SqlExecutor) {}

  async write(
    samples: readonly {
      runId: string | null;
      site: string;
      name: string;
      labels: Record<string, string>;
      value: number;
    }[],
  ): Promise<void> {
    if (samples.length === 0) return;
    // One multi-row INSERT rather than N round trips: this runs every 30 s during a crawl.
    const values: unknown[] = [];
    const tuples = samples.map((sample, i) => {
      const base = i * 5;
      values.push(
        sample.runId,
        sample.site,
        sample.name,
        JSON.stringify(sample.labels),
        sample.value,
      );
      return `($${String(base + 1)},$${String(base + 2)},$${String(base + 3)},$${String(base + 4)},$${String(base + 5)})`;
    });
    await this.db.query(
      `INSERT INTO juris.metric (run_id, site, name, labels, value) VALUES ${tuples.join(',')}`,
      values,
    );
  }
}

export class PgReportRepo implements ReportRepo {
  constructor(private readonly db: SqlExecutor) {}

  async casesPerMonth(
    site: string,
  ): Promise<{ yearMonth: string; cases: number; leaves: number }[]> {
    const { rows } = await this.db.query(
      `SELECT to_char(data_autuacao_ini, 'YYYY-MM') AS ym,
              count(*) AS cases,
              count(DISTINCT data_autuacao_ini) AS leaves
       FROM juris.case_record WHERE site = $1
       GROUP BY ym ORDER BY ym`,
      [site],
    );
    return rows.map((r) => ({
      yearMonth: readString(r, 'ym'),
      cases: readNumber(r, 'cases'),
      leaves: readNumber(r, 'leaves'),
    }));
  }

  async observedRowsVsUnique(runId: string): Promise<{ observed: number; unique: number }> {
    // The arithmetic behind the completeness claim: what the site said it returned, against
    // what actually landed in the database.
    const { rows } = await this.db.query(
      `SELECT
         (SELECT COALESCE(sum(observed_rows), 0) FROM juris.partition
          WHERE run_id = $1 AND status IN ('LEAF_DONE','LEAF_DONE_SECONDARY','GAP')) AS observed,
         (SELECT count(*) FROM juris.case_record c
          WHERE c.site = (SELECT site FROM juris.crawl_run WHERE run_id = $1)) AS uniq`,
      [runId],
    );
    const row = rows[0];
    return {
      observed: row === undefined ? 0 : readNumber(row, 'observed'),
      unique: row === undefined ? 0 : readNumber(row, 'uniq'),
    };
  }

  async gapPartitions(runId: string): Promise<PartitionNode[]> {
    const { rows } = await this.db.query(
      `SELECT * FROM juris.partition WHERE run_id = $1 AND status = 'GAP' ORDER BY data_ini`,
      [runId],
    );
    return rows.map(hydratePartition);
  }

  async nullRates(site: string): Promise<Record<string, number>> {
    const { rows } = await this.db.query(
      `SELECT
         count(*) AS total,
         count(*) FILTER (WHERE data_distribuicao IS NULL) AS data_distribuicao,
         count(*) FILTER (WHERE orgao_julgador IS NULL) AS orgao_julgador,
         count(*) FILTER (WHERE jurisdicao IS NULL) AS jurisdicao,
         count(*) FILTER (WHERE numero IS NULL OR numero = '') AS numero,
         count(*) FILTER (WHERE classe IS NULL OR classe = '') AS classe
       FROM juris.case_record WHERE site = $1 AND estado = 'DETAILED'`,
      [site],
    );
    const row = rows[0];
    if (row === undefined) return {};
    const total = readNumber(row, 'total');
    if (total === 0) return {};
    const out: Record<string, number> = {};
    for (const field of ['data_distribuicao', 'orgao_julgador', 'jurisdicao', 'numero', 'classe']) {
      out[field] = readNumber(row, field) / total;
    }
    return out;
  }

  async rootRange(runId: string): Promise<DateRange | null> {
    const { rows } = await this.db.query(
      `SELECT root_ini, root_fim FROM juris.crawl_run WHERE run_id = $1`,
      [runId],
    );
    const row = rows[0];
    return row === undefined
      ? null
      : {
          ini: readString(row, 'root_ini').slice(0, 10),
          fim: readString(row, 'root_fim').slice(0, 10),
        };
  }
}

export function createRepos(db: SqlExecutor): Repos & { cases: PgCaseRepo } {
  return {
    site: new PgSiteRepo(db),
    cases: new PgCaseRepo(db),
    partitions: new PgPartitionRepo(db),
    blobs: new PgBlobRepo(db),
    vocabulary: new PgVocabularyRepo(db),
    runs: new PgRunRepo(db),
    metrics: new PgMetricRepo(db),
    reports: new PgReportRepo(db),
  };
}

export { PgCaseRepo };
