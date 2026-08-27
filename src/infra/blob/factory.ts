/**
 * Picks a blob backend, with the same automatic fallback as the database.
 *
 * The rule matches `infra/db/factory.ts` deliberately: an explicit `BLOB_DRIVER` always wins,
 * otherwise an `S3_ENDPOINT` is probed and, if it does not answer, the run continues on local
 * disk **and says so in one line**. Silence here would be worse than failure — someone would
 * finish a crawl believing the PDFs went to object storage.
 */
import type { BlobStore } from '../../core/ports/blobStore.js';
import { FsBlobStore } from './fsBlobStore.js';
import { S3BlobStore } from './s3BlobStore.js';

export interface BlobConfig {
  driver?: 's3' | 'fs' | undefined;
  dir?: string | undefined;
  endpoint?: string | undefined;
  bucket?: string | undefined;
  region?: string | undefined;
  accessKeyId?: string | undefined;
  secretAccessKey?: string | undefined;
  forcePathStyle?: boolean | undefined;
  probeTimeoutMs?: number;
}

export interface BlobSelection {
  store: BlobStore;
  fallbackNotice: string | null;
}

/** A cheap liveness check that does not need credentials or a bucket to exist. */
export async function probeS3(endpoint: string, timeoutMs = 2_000): Promise<string | null> {
  try {
    const response = await fetch(endpoint, {
      method: 'GET',
      signal: AbortSignal.timeout(timeoutMs),
    });
    // Any HTTP answer means something is listening and speaking HTTP; 403 from an
    // unauthenticated ListBuckets is a perfectly healthy S3 endpoint.
    return response.status >= 200 && response.status < 500
      ? null
      : `endpoint answered ${String(response.status)}`;
  } catch (error) {
    return error instanceof Error
      ? error.message === ''
        ? error.name
        : error.message
      : String(error);
  }
}

function s3From(config: BlobConfig): S3BlobStore {
  return new S3BlobStore({
    bucket: config.bucket ?? 'juris',
    region: config.region ?? 'us-east-1',
    endpoint: config.endpoint,
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    forcePathStyle: config.forcePathStyle ?? true,
  });
}

export async function createBlobStore(config: BlobConfig): Promise<BlobSelection> {
  const dir = config.dir ?? './data/blobs';

  if (config.driver === 's3') return { store: s3From(config), fallbackNotice: null };
  if (config.driver === 'fs')
    return { store: new FsBlobStore({ root: dir }), fallbackNotice: null };

  if (config.endpoint !== undefined && config.endpoint !== '') {
    const failure = await probeS3(config.endpoint, config.probeTimeoutMs ?? 2_000);
    if (failure === null) return { store: s3From(config), fallbackNotice: null };
    return {
      store: new FsBlobStore({ root: dir }),
      fallbackNotice:
        `Object storage at ${config.endpoint} did not answer (${failure}); storing PDFs on disk ` +
        `at ${dir}. Run "npm run up:infra" for the Docker path, or set BLOB_DRIVER=fs to silence this.`,
    };
  }

  return {
    store: new FsBlobStore({ root: dir }),
    fallbackNotice: `No S3_ENDPOINT configured; storing PDFs on disk at ${dir}.`,
  };
}
