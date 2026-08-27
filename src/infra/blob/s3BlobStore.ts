/**
 * `BlobStore` over the S3 API.
 *
 * The choice worth explaining is the *interface*, not the vendor. Speaking S3 means the same
 * code reaches RustFS in compose, AWS S3 in production, Google Cloud Storage through its HMAC
 * interoperability endpoint, or Garage on someone's NAS — with a URL and a key pair, not a code
 * change. MinIO would have been the obvious local choice a year ago; its community edition was
 * archived, and LocalStack now wants an account token, so RustFS is the live option. None of
 * that is visible from here, which is the point. See `docs/ADR/0002-s3-api-rustfs.md`.
 *
 * Two details that are easy to get wrong:
 *
 * `forcePathStyle` is on. Virtual-host addressing (`bucket.host/key`) needs DNS the local
 * backends do not have, and a bucket name with a dot breaks TLS even on AWS.
 *
 * `ChecksumSHA256` is sent with every upload, so the **server** verifies integrity rather than
 * the client hoping. A corrupted body is rejected at the door instead of being stored and
 * discovered later by a sanity check.
 */
import {
  CreateBucketCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';
import type { BlobHead, BlobStore, PutResult } from '../../core/ports/blobStore.js';
import { sha256Base64 } from '../../core/domain/hash.js';

export interface S3BlobStoreOptions {
  bucket: string;
  region?: string;
  /** Empty for real AWS; a URL for RustFS, GCS interop, Garage, MinIO-compatible servers. */
  endpoint?: string | undefined;
  accessKeyId?: string | undefined;
  secretAccessKey?: string | undefined;
  forcePathStyle?: boolean;
}

/** Object metadata keys are lowercased by S3; naming them here keeps `head` and `put` in step. */
const META_SHA256 = 'sha256';

export class S3BlobStore implements BlobStore {
  readonly driver = 's3' as const;
  readonly target: string;
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(options: S3BlobStoreOptions) {
    this.bucket = options.bucket;
    this.target = `${options.endpoint ?? 'aws'}/${options.bucket}`;

    const config: S3ClientConfig = {
      region: options.region ?? 'us-east-1',
      forcePathStyle: options.forcePathStyle ?? true,
    };
    if (options.endpoint !== undefined && options.endpoint !== '') {
      config.endpoint = options.endpoint;
    }
    if (options.accessKeyId !== undefined && options.secretAccessKey !== undefined) {
      config.credentials = {
        accessKeyId: options.accessKeyId,
        secretAccessKey: options.secretAccessKey,
      };
    }
    this.client = new S3Client(config);
  }

  async init(): Promise<void> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
      return;
    } catch (error) {
      if (isAuthFailure(error)) throw this.authError(error);
      if (!isNotFound(error)) throw error;
    }
    try {
      await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
    } catch (error) {
      // Another worker may have created it in the gap between head and create. That is the
      // expected outcome of `--scale`, not a failure.
      if (isAuthFailure(error)) throw this.authError(error);
      if (!isAlreadyOwned(error)) throw error;
    }
  }

  /**
   * The SDK reports a rejected signature from a non-AWS backend as `Unknown: UnknownError` with
   * the status buried in `$metadata`. That is the single most likely thing to go wrong when
   * someone points this at their own storage, so it gets a message that names the fix.
   */
  private authError(error: unknown): Error {
    return new Error(
      `object storage at ${this.target} rejected the credentials ` +
        `(HTTP ${String(statusOf(error) ?? '?')}). Check S3_ACCESS_KEY and S3_SECRET_KEY; ` +
        `with docker compose they are the RUSTFS_ACCESS_KEY / RUSTFS_SECRET_KEY of the blob service.`,
      { cause: error },
    );
  }

  uri(key: string): string {
    return `s3://${this.bucket}/${key}`;
  }

  async put(
    key: string,
    body: Uint8Array,
    meta: { contentType: string; sha256: string; tags?: Record<string, string> },
  ): Promise<PutResult> {
    const response = await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: meta.contentType,
        ContentLength: body.byteLength,
        // The server recomputes this and refuses a mismatch.
        ChecksumSHA256: sha256Base64(body),
        Metadata: { [META_SHA256]: meta.sha256, ...(meta.tags ?? {}) },
      }),
    );
    return { uri: this.uri(key), etag: response.ETag ?? null, bytes: body.byteLength };
  }

  async head(key: string): Promise<BlobHead | null> {
    try {
      const response = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return {
        bytes: response.ContentLength ?? 0,
        sha256: response.Metadata?.[META_SHA256] ?? null,
      };
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async get(key: string): Promise<Uint8Array> {
    const response = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
    );
    if (response.Body === undefined) throw new Error(`s3 object ${key} returned no body`);
    return new Uint8Array(await response.Body.transformToByteArray());
  }
}

function statusOf(error: unknown): number | undefined {
  const meta = (error as { $metadata?: { httpStatusCode?: unknown } } | null)?.$metadata;
  return typeof meta?.httpStatusCode === 'number' ? meta.httpStatusCode : undefined;
}

function nameOf(error: unknown): string {
  return (error as { name?: unknown } | null)?.name === undefined
    ? ''
    : String((error as { name: unknown }).name);
}

function isNotFound(error: unknown): boolean {
  const name = nameOf(error);
  return (
    statusOf(error) === 404 ||
    name === 'NotFound' ||
    name === 'NoSuchKey' ||
    name === 'NoSuchBucket'
  );
}

function isAuthFailure(error: unknown): boolean {
  const status = statusOf(error);
  const name = nameOf(error);
  return (
    status === 401 ||
    status === 403 ||
    name === 'AccessDenied' ||
    name === 'InvalidAccessKeyId' ||
    name === 'SignatureDoesNotMatch'
  );
}

function isAlreadyOwned(error: unknown): boolean {
  const name = nameOf(error);
  return name === 'BucketAlreadyOwnedByYou' || name === 'BucketAlreadyExists';
}
