/**
 * Object storage, behind one interface that S3, GCS (through its HMAC interop), RustFS, Garage
 * and the local disk all satisfy.
 *
 * Invariant enforced by the caller, not by this port: nothing is ever put here that has not
 * first been validated as a real PDF and hashed. `head` exists so a re-run can prove an object
 * is already stored without downloading it again.
 */
export interface PutResult {
  uri: string;
  etag: string | null;
  bytes: number;
}

export interface BlobHead {
  bytes: number;
  sha256: string | null;
}

export interface BlobStore {
  put(
    key: string,
    body: Uint8Array,
    meta: { contentType: string; sha256: string; tags?: Record<string, string> },
  ): Promise<PutResult>;
  head(key: string): Promise<BlobHead | null>;
  get(key: string): Promise<Uint8Array>;
  /** The address this key would have. Pure; does not touch the network. */
  uri(key: string): string;
  /** Creates the bucket or directory if missing. Idempotent. */
  init(): Promise<void>;
  readonly driver: 's3' | 'fs';
  readonly target: string;
}
