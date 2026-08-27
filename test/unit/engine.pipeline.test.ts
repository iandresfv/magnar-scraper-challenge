import { describe, expect, it } from 'vitest';
import {
  FatalSiteChange,
  Outcome,
  Pipeline,
  type HandlerOutcome,
} from '../../src/core/engine/pipeline.js';
import type { Job } from '../../src/core/ports/jobQueue.js';

const job = (kind: Job['kind'] = 'detail'): Job => ({
  id: '1',
  site: 's',
  kind,
  key: 'k',
  payload: {},
  status: 'leased',
  priority: 50,
  attempts: 1,
  maxAttempts: 6,
  runAfter: '',
  leasedBy: 'w',
  leaseUntil: null,
  failureClass: null,
  lastError: null,
  httpStatus: null,
});

const handler = (kind: Job['kind'], fn: () => Promise<HandlerOutcome>) => ({
  kind,
  handle: fn,
});

describe('Pipeline', () => {
  it('dispatches by job kind', async () => {
    const pipeline = new Pipeline()
      .register(handler('detail', () => Promise.resolve(Outcome.done('detail ran'))))
      .register(handler('search', () => Promise.resolve(Outcome.done('search ran'))));

    expect(await pipeline.run(job('detail'))).toEqual({ kind: 'done', detail: 'detail ran' });
    expect(await pipeline.run(job('search'))).toEqual({ kind: 'done', detail: 'search ran' });
  });

  it('buries a job whose kind nobody handles, rather than retrying it forever', async () => {
    const outcome = await new Pipeline().run(job('blob'));
    expect(outcome.kind).toBe('dead');
    if (outcome.kind === 'dead') expect(outcome.error).toContain('no handler registered');
  });

  it('reports whether a kind is handled', () => {
    const pipeline = new Pipeline().register(
      handler('blob', () => Promise.resolve(Outcome.done())),
    );
    expect(pipeline.has('blob')).toBe(true);
    expect(pipeline.has('detail')).toBe(false);
  });

  it('turns an unexpected exception into a retry rather than letting it kill the worker', async () => {
    // One malformed page must not take a process down; a transient parse failure on a partial
    // response is far more common than a permanently broken page.
    const pipeline = new Pipeline().register(
      handler('detail', () => Promise.reject(new TypeError('cannot read properties of null'))),
    );
    const outcome = await pipeline.run(job());
    expect(outcome.kind).toBe('retry');
    if (outcome.kind === 'retry') {
      expect(outcome.failureClass).toBe('PARSE');
      expect(outcome.error).toContain('TypeError');
    }
  });

  it('lets a site change through as fatal, because continuing would produce wrong data', async () => {
    const pipeline = new Pipeline().register(
      handler('search', () => Promise.reject(new FatalSiteChange('C-4', 'the cap changed to 20'))),
    );
    const outcome = await pipeline.run(job('search'));
    expect(outcome.kind).toBe('fatal');
    if (outcome.kind === 'fatal') {
      expect(outcome.canaryId).toBe('C-4');
      expect(outcome.error).toContain('cap changed');
    }
  });

  it('passes a handler-chosen outcome through untouched', async () => {
    const pipeline = new Pipeline().register(
      handler('blob', () => Promise.resolve(Outcome.dead('NOT_PDF', 'body was HTML', 200))),
    );
    expect(await pipeline.run(job('blob'))).toEqual({
      kind: 'dead',
      failureClass: 'NOT_PDF',
      error: 'body was HTML',
      httpStatus: 200,
    });
  });

  it('handlers never decide delays: the outcome carries a class, not a number', () => {
    // The vocabulary is deliberately small. How long to wait is the retry policy's job, and
    // keeping it out of here is what makes both testable without the other.
    const retry = Outcome.retry('RATE_LIMITED', '429');
    expect(Object.keys(retry).sort()).toEqual(['error', 'failureClass', 'httpStatus', 'kind']);
    expect(JSON.stringify(retry)).not.toContain('delay');
  });
});
