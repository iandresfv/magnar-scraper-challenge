/**
 * The filesystem store always runs. The S3 store runs against RustFS when `S3_ENDPOINT`
 * answers — locally after `npm run up:infra`, and in CI as a service container — and is skipped
 * with a visible notice otherwise, so a green run never quietly means "only the easy backend".
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'vitest';
import { FsBlobStore } from '../../src/infra/blob/fsBlobStore.js';
import { S3BlobStore } from '../../src/infra/blob/s3BlobStore.js';
import { probeS3 } from '../../src/infra/blob/factory.js';
import { runBlobStoreContract } from './blobStore.contract.js';

const root = await mkdtemp(join(tmpdir(), 'juris-blob-'));

runBlobStoreContract({
  name: 'fs',
  create: () => Promise.resolve(new FsBlobStore({ root })),
  cleanup: () => rm(root, { recursive: true, force: true }),
});

const endpoint = process.env['S3_ENDPOINT'] ?? 'http://localhost:59000';
const reachable = (await probeS3(endpoint)) === null;

if (reachable) {
  runBlobStoreContract({
    name: `s3 (${endpoint})`,
    create: () =>
      Promise.resolve(
        new S3BlobStore({
          // Its own bucket, so a parallel suite cannot see or clobber its objects.
          bucket: 'juris-test-contract',
          endpoint,
          region: process.env['S3_REGION'] ?? 'us-east-1',
          accessKeyId: process.env['S3_ACCESS_KEY'] ?? 'juris',
          secretAccessKey: process.env['S3_SECRET_KEY'] ?? 'jurisjuris',
          forcePathStyle: true,
        }),
      ),
  });
} else {
  describe('BlobStore contract: s3', () => {
    it.skip(`skipped: nothing answered at ${endpoint} — run "npm run up:infra" to exercise this backend`, () =>
      undefined);
  });
}
