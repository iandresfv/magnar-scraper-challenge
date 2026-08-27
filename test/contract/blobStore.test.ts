/**
 * The filesystem store runs always; the S3 store joins in stage 15 when RustFS is reachable.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FsBlobStore } from '../../src/infra/blob/fsBlobStore.js';
import { runBlobStoreContract } from './blobStore.contract.js';

const root = await mkdtemp(join(tmpdir(), 'juris-blob-'));

runBlobStoreContract({
  name: 'fs',
  create: () => Promise.resolve(new FsBlobStore({ root })),
  cleanup: () => rm(root, { recursive: true, force: true }),
});
