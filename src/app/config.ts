/**
 * Configuration, resolved once at start-up from flags and the environment.
 *
 * Flags beat environment variables beat defaults, which is the order that makes a one-off run
 * easy without editing anything. `.env` is loaded by Node itself (`node --env-file`), so there is
 * no configuration library here and nothing to learn beyond the table in the README.
 *
 * Everything is validated eagerly. A crawl that runs for an hour and then fails on a
 * misconfigured value has wasted an hour of someone's day and an hour of a tribunal's capacity.
 */
import { parseArgs } from 'node:util';
import { isValidIsoDate } from '../core/domain/dates.js';

export type Role = 'all' | 'planner' | 'worker';
export type DbDriver = 'pg' | 'pglite';
export type BlobDriver = 's3' | 'fs';

export interface Config {
  site: string;
  /**
   * Overrides the site's own base URL. Production never needs it — a court's address is part of
   * its adapter — but the fake site has no fixed address, and pointing the real adapter at a
   * staging host is exactly the kind of thing an operator should be able to do without a rebuild.
   */
  baseUrl: string | undefined;
  role: Role;
  command: string;

  db: {
    driver: DbDriver | undefined;
    url: string | undefined;
    path: string | undefined;
    autoMigrate: boolean;
  };

  blob: {
    driver: BlobDriver | undefined;
    dir: string | undefined;
    endpoint: string | undefined;
    bucket: string;
    region: string;
    accessKeyId: string | undefined;
    secretAccessKey: string | undefined;
    forcePathStyle: boolean;
  };

  crawl: {
    root: { ini: string; fim: string };
    /** How many PDFs this run may fetch. `null` means every one it finds. */
    pdfBudget: number | null;
    /** Stop after this many jobs. Used by `demo`; `null` means run to completion. */
    maxJobs: number | null;
    leaseMs: number;
    /** How long a worker waits when the queue is empty before asking again. */
    idlePollMs: number;
    workerId: string;
    anonymize: boolean;
  };

  throttle: {
    concurrency: number;
    concurrencyMin: number;
    concurrencyMax: number;
    ratePerSec: number;
    burst: number;
  };

  logLevel: string;
  /** Where the `/metrics` endpoint listens. `null` disables it. */
  metricsPort: number | null;
}

export class ConfigError extends Error {}

export interface ResolveConfigInput {
  argv?: string[];
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
}

export function resolveConfig(input: ResolveConfigInput = {}): Config {
  const env = input.env ?? process.env;
  const now = input.now ?? ((): Date => new Date());

  const { values, positionals } = parseArgs({
    args: input.argv ?? process.argv.slice(2),
    allowPositionals: true,
    strict: false,
    options: {
      site: { type: 'string' },
      'base-url': { type: 'string' },
      role: { type: 'string' },
      'root-start': { type: 'string' },
      'root-end': { type: 'string' },
      'pdf-budget': { type: 'string' },
      'max-jobs': { type: 'string' },
      'worker-id': { type: 'string' },
      anonymize: { type: 'boolean' },
      'log-level': { type: 'string' },
      'metrics-port': { type: 'string' },
      kind: { type: 'string' },
      format: { type: 'string' },
      out: { type: 'string' },
      sample: { type: 'string' },
    },
  });

  const flag = (name: string): string | undefined => {
    const value = values[name];
    return typeof value === 'string' ? value : undefined;
  };

  const role = pick(flag('role') ?? env['ROLE'] ?? 'all', ['all', 'planner', 'worker'], 'role');

  // A generous default root: an empty half costs exactly one query to prune, so the cost of
  // reaching too far back is logarithmic, while the cost of reaching too little is silent loss.
  const rootIni = flag('root-start') ?? env['ROOT_START'] ?? '1990-01-01';
  const rootFim = flag('root-end') ?? env['ROOT_END'] ?? defaultRootEnd(now());
  for (const [label, value] of [
    ['ROOT_START', rootIni],
    ['ROOT_END', rootFim],
  ] as const) {
    if (!isValidIsoDate(value)) {
      throw new ConfigError(
        `${label} must be a calendar date as YYYY-MM-DD, got ${JSON.stringify(value)}`,
      );
    }
  }
  if (rootIni > rootFim) {
    throw new ConfigError(`ROOT_START (${rootIni}) is after ROOT_END (${rootFim})`);
  }

  const concurrency = int(flag('concurrency') ?? env['CONCURRENCY'], 4, 'CONCURRENCY');
  const concurrencyMin = int(env['CONCURRENCY_MIN'], 1, 'CONCURRENCY_MIN');
  const concurrencyMax = int(env['CONCURRENCY_MAX'], 8, 'CONCURRENCY_MAX');
  if (concurrencyMin > concurrency || concurrency > concurrencyMax) {
    throw new ConfigError(
      `concurrency ${String(concurrency)} must sit between ${String(concurrencyMin)} and ${String(concurrencyMax)}`,
    );
  }

  return {
    site: flag('site') ?? env['SITE'] ?? 'br-trf5',
    baseUrl: blankToUndefined(flag('base-url') ?? env['SITE_BASE_URL']),
    role,
    command: positionals[0] ?? 'crawl',

    db: {
      driver: optionalPick(flag('db-driver') ?? env['DB_DRIVER'], ['pg', 'pglite'], 'DB_DRIVER'),
      url: blankToUndefined(env['DATABASE_URL']),
      path: blankToUndefined(env['DB_PATH']) ?? './data/pg',
      autoMigrate: env['DB_AUTO_MIGRATE'] !== 'false',
    },

    blob: {
      driver: optionalPick(env['BLOB_DRIVER'], ['s3', 'fs'], 'BLOB_DRIVER'),
      dir: blankToUndefined(env['BLOB_DIR']) ?? './data/blobs',
      endpoint: blankToUndefined(env['S3_ENDPOINT']),
      bucket: env['S3_BUCKET'] ?? 'juris',
      region: env['S3_REGION'] ?? 'us-east-1',
      accessKeyId: blankToUndefined(env['S3_ACCESS_KEY']),
      secretAccessKey: blankToUndefined(env['S3_SECRET_KEY']),
      forcePathStyle: env['S3_FORCE_PATH_STYLE'] !== 'false',
    },

    crawl: {
      root: { ini: rootIni, fim: rootFim },
      pdfBudget: budget(flag('pdf-budget') ?? env['PDF_BUDGET'] ?? '150'),
      maxJobs: flag('max-jobs') === undefined ? null : int(flag('max-jobs'), 0, 'max-jobs'),
      leaseMs: int(env['LEASE_MS'], 90_000, 'LEASE_MS'),
      idlePollMs: int(env['IDLE_POLL_MS'], 500, 'IDLE_POLL_MS'),
      workerId: flag('worker-id') ?? env['WORKER_ID'] ?? defaultWorkerId(),
      anonymize: values['anonymize'] === true || env['ANONYMIZE'] === 'true',
    },

    throttle: {
      concurrency,
      concurrencyMin,
      concurrencyMax,
      ratePerSec: number(env['RATE_PER_SEC'], 2, 'RATE_PER_SEC'),
      burst: int(env['BURST'], 4, 'BURST'),
    },

    logLevel: flag('log-level') ?? env['LOG_LEVEL'] ?? 'info',
    metricsPort:
      flag('metrics-port') === undefined && env['METRICS_PORT'] === undefined
        ? null
        : int(flag('metrics-port') ?? env['METRICS_PORT'], 0, 'METRICS_PORT'),
  };
}

/** A year ahead: cases are filed with future dates more often than one would hope. */
function defaultRootEnd(now: Date): string {
  return new Date(now.getTime() + 366 * 86_400_000).toISOString().slice(0, 10);
}

/** Identifies a worker in the queue's `leased_by`, so a stuck lease can be traced to a process. */
function defaultWorkerId(): string {
  return `${process.env['HOSTNAME'] ?? 'local'}-${String(process.pid)}`;
}

function blankToUndefined(value: string | undefined): string | undefined {
  return value === undefined || value.trim() === '' ? undefined : value;
}

function pick<T extends string>(value: string, allowed: readonly T[], label: string): T {
  if ((allowed as readonly string[]).includes(value)) return value as T;
  throw new ConfigError(
    `${label} must be one of ${allowed.join(', ')}, got ${JSON.stringify(value)}`,
  );
}

function optionalPick<T extends string>(
  value: string | undefined,
  allowed: readonly T[],
  label: string,
): T | undefined {
  const cleaned = blankToUndefined(value);
  return cleaned === undefined ? undefined : pick(cleaned, allowed, label);
}

function int(value: string | undefined, fallback: number, label: string): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new ConfigError(`${label} must be a non-negative integer, got ${JSON.stringify(value)}`);
  }
  return parsed;
}

function number(value: string | undefined, fallback: number, label: string): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new ConfigError(`${label} must be a positive number, got ${JSON.stringify(value)}`);
  }
  return parsed;
}

/** `all` means no limit; anything else must be a count. */
function budget(value: string): number | null {
  if (value === 'all') return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new ConfigError(
      `--pdf-budget must be a non-negative integer or "all", got ${JSON.stringify(value)}`,
    );
  }
  return parsed;
}
