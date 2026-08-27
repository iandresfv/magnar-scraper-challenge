import { blobInitCommand } from '../commands/blobInit.js';

const driver = process.env['BLOB_DRIVER'];
process.exitCode = await blobInitCommand({
  driver: driver === 's3' || driver === 'fs' ? driver : undefined,
  dir: process.env['BLOB_DIR'],
  endpoint: process.env['S3_ENDPOINT'],
  bucket: process.env['S3_BUCKET'],
  region: process.env['S3_REGION'],
  accessKeyId: process.env['S3_ACCESS_KEY'],
  secretAccessKey: process.env['S3_SECRET_KEY'],
  forcePathStyle: process.env['S3_FORCE_PATH_STYLE'] !== 'false',
});
