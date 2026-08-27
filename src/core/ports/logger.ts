/**
 * Structured logging. NDJSON in production, pretty in `npm run dev`.
 *
 * The fixed field set is what makes a run diagnosable after the fact: given a `partitionId` or
 * an `idOrigem` you can reconstruct everything that happened to it.
 */
export interface LogFields {
  runId?: string;
  site?: string;
  component?: string;
  partitionId?: string;
  idOrigem?: string;
  jobId?: string;
  jobKind?: string;
  attempt?: number;
  failureClass?: string;
  status?: number;
  elapsedMs?: number;
  [key: string]: unknown;
}

export interface Logger {
  debug(fields: LogFields, msg: string): void;
  info(fields: LogFields, msg: string): void;
  warn(fields: LogFields, msg: string): void;
  error(fields: LogFields, msg: string): void;
  child(fields: LogFields): Logger;
}
