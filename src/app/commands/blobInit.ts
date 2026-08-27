/**
 * `npm run blob:init` — creates the bucket (or the directory) if it is missing, and reports
 * which backend actually answered. Idempotent, so it is safe to run from `npm run up`.
 */
import { createBlobStore, type BlobConfig } from '../../infra/blob/factory.js';

export async function blobInitCommand(
  config: BlobConfig,
  write: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
): Promise<number> {
  const { store, fallbackNotice } = await createBlobStore(config);
  if (fallbackNotice !== null) write(fallbackNotice);
  await store.init();
  write(`blob store ready: driver=${store.driver} target=${store.target}`);
  return 0;
}
