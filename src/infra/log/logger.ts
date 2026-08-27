/**
 * Structured logging over pino.
 *
 * The fixed field set is what makes a finished run diagnosable: given an `idOrigem` or a
 * `partitionId`, `jq` can reconstruct everything that happened to it, in order, including which
 * worker held it and how many attempts it took. A message string cannot be queried that way.
 *
 * NDJSON by default; `npm run dev` pipes it through `pino-pretty` for a human.
 */
import { pino, type Logger as PinoLogger } from 'pino';
import type { LogFields, Logger } from '../../core/ports/logger.js';

export interface LoggerOptions {
  level?: string;
  pretty?: boolean;
  /** Fields attached to every line: runId, site, role. */
  base?: LogFields;
  destination?: NodeJS.WritableStream;
}

class PinoAdapter implements Logger {
  constructor(private readonly inner: PinoLogger) {}

  debug(fields: LogFields, msg: string): void {
    this.inner.debug(fields, msg);
  }
  info(fields: LogFields, msg: string): void {
    this.inner.info(fields, msg);
  }
  warn(fields: LogFields, msg: string): void {
    this.inner.warn(fields, msg);
  }
  error(fields: LogFields, msg: string): void {
    this.inner.error(fields, msg);
  }
  child(fields: LogFields): Logger {
    return new PinoAdapter(this.inner.child(fields));
  }
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const inner = pino(
    {
      level: options.level ?? 'info',
      base: options.base ?? {},
      // Wall-clock ISO rather than epoch millis: a log a human reads at 3 a.m. should not need
      // a converter.
      timestamp: () => `,"time":"${new Date().toISOString()}"`,
      ...(options.pretty === true
        ? {
            transport: { target: 'pino-pretty', options: { colorize: true, translateTime: false } },
          }
        : {}),
    },
    options.destination,
  );
  return new PinoAdapter(inner);
}

/** A logger that discards everything. Used by tests that assert on behaviour, not on output. */
export function silentLogger(): Logger {
  const noop = (): void => undefined;
  const logger: Logger = {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    child: () => logger,
  };
  return logger;
}
