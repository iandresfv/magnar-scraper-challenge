import { describe, expect, it } from 'vitest';
import { METRICS, MetricsRegistry, quantiles } from '../../src/infra/metrics/registry.js';
import { startMetricsServer } from '../../src/infra/metrics/server.js';
import { createLogger, silentLogger } from '../../src/infra/log/logger.js';
import { Writable } from 'node:stream';

describe('the registry', () => {
  it('counts', () => {
    const registry = new MetricsRegistry();
    registry.increment(METRICS.requests, { kind: 'search' });
    registry.increment(METRICS.requests, { kind: 'search' }, 4);
    registry.increment(METRICS.requests, { kind: 'detail' });

    const samples = registry.snapshot();
    expect(samples.find((s) => s.labels['kind'] === 'search')?.value).toBe(5);
    expect(samples.find((s) => s.labels['kind'] === 'detail')?.value).toBe(1);
  });

  it('keeps series with different labels apart', () => {
    const registry = new MetricsRegistry();
    registry.increment('x', { a: '1' });
    registry.increment('x', { a: '2' });
    expect(registry.snapshot()).toHaveLength(2);
  });

  it('treats label order as irrelevant, so the same series is not counted twice', () => {
    const registry = new MetricsRegistry();
    registry.increment('x', { a: '1', b: '2' });
    registry.increment('x', { b: '2', a: '1' });
    expect(registry.snapshot()).toHaveLength(1);
    expect(registry.snapshot()[0]?.value).toBe(2);
  });

  it('gauges overwrite rather than accumulate', () => {
    const registry = new MetricsRegistry();
    registry.gauge(METRICS.concurrency, 4);
    registry.gauge(METRICS.concurrency, 2);
    expect(registry.snapshot()[0]?.value).toBe(2);
  });

  it('computes exact quantiles over the observations', () => {
    const registry = new MetricsRegistry();
    for (let ms = 1; ms <= 100; ms++) registry.observe(METRICS.requestSeconds, ms);
    const sample = registry.snapshot()[0];
    expect(sample?.kind).toBe('histogram');
    expect(sample?.value).toBe(100);
    expect(sample?.quantiles?.['0.5']).toBeGreaterThanOrEqual(50);
    expect(sample?.quantiles?.['0.95']).toBeGreaterThanOrEqual(95);
  });

  it('keeps a representative sample of a long run at constant memory', () => {
    // Reservoir sampling: ten thousand kept out of fifty thousand, still spanning the range.
    const registry = new MetricsRegistry({ random: () => 0.5 });
    for (let i = 0; i < 50_000; i++) registry.observe('x', i);
    const sample = registry.snapshot()[0];
    expect(sample?.value).toBe(10_000);
    expect(sample?.quantiles?.['0.99']).toBeGreaterThan(0);
  });

  it('handles an empty histogram without inventing numbers', () => {
    expect(quantiles([])).toEqual({});
  });
});

describe('prometheus exposition', () => {
  it('renders counters and gauges with their labels', () => {
    const registry = new MetricsRegistry();
    registry.increment(METRICS.jobs, { kind: 'detail', outcome: 'done' }, 7);
    registry.gauge(METRICS.jobsPending, 12);

    const text = registry.toPrometheus();
    expect(text).toContain(`# TYPE ${METRICS.jobs} counter`);
    expect(text).toContain(`${METRICS.jobs}{kind="detail",outcome="done"} 7`);
    expect(text).toContain(`# TYPE ${METRICS.jobsPending} gauge`);
    expect(text).toContain(`${METRICS.jobsPending} 12`);
  });

  it('renders a histogram as a summary with sum and count', () => {
    const registry = new MetricsRegistry();
    registry.observe(METRICS.requestSeconds, 100, { kind: 'search' });
    registry.observe(METRICS.requestSeconds, 300, { kind: 'search' });

    const text = registry.toPrometheus();
    expect(text).toContain(`# TYPE ${METRICS.requestSeconds} summary`);
    expect(text).toContain('quantile="0.5"');
    expect(text).toContain(`${METRICS.requestSeconds}_sum{kind="search"} 400`);
    expect(text).toContain(`${METRICS.requestSeconds}_count{kind="search"} 2`);
  });

  it('escapes label values so a stray quote cannot corrupt the output', () => {
    const registry = new MetricsRegistry();
    registry.increment('x', { error: 'he said "no"\nthen left' });
    const text = registry.toPrometheus();
    expect(text).not.toContain('"no"');
    expect(text.split('\n').filter((l) => l.startsWith('x'))).toHaveLength(1);
  });

  it('emits one TYPE line per metric, not per series', () => {
    const registry = new MetricsRegistry();
    registry.increment('x', { a: '1' });
    registry.increment('x', { a: '2' });
    expect(
      registry
        .toPrometheus()
        .split('\n')
        .filter((l) => l.startsWith('# TYPE')),
    ).toHaveLength(1);
  });

  it('clears histogram samples on flush but keeps counters cumulative', () => {
    const registry = new MetricsRegistry();
    registry.increment('c');
    registry.observe('h', 5);
    registry.resetHistograms();
    const samples = registry.snapshot();
    expect(samples.find((s) => s.name === 'c')?.value).toBe(1);
    expect(samples.find((s) => s.name === 'h')?.value).toBe(0);
  });
});

describe('the metrics endpoint', () => {
  it('serves the exposition format and a health probe', async () => {
    const registry = new MetricsRegistry();
    registry.gauge(METRICS.jobsPending, 3);
    const server = await startMetricsServer(registry);

    try {
      const metrics = await fetch(`http://127.0.0.1:${String(server.port)}/metrics`);
      expect(metrics.status).toBe(200);
      expect(metrics.headers.get('content-type')).toContain('text/plain');
      expect(await metrics.text()).toContain(`${METRICS.jobsPending} 3`);

      const health = await fetch(`http://127.0.0.1:${String(server.port)}/healthz`);
      expect(health.status).toBe(200);

      const missing = await fetch(`http://127.0.0.1:${String(server.port)}/nope`);
      expect(missing.status).toBe(404);
    } finally {
      await server.close();
    }
  });

  it('reports unhealthy when the process says so, so a probe can restart it', async () => {
    const server = await startMetricsServer(new MetricsRegistry(), { healthy: () => false });
    try {
      const health = await fetch(`http://127.0.0.1:${String(server.port)}/healthz`);
      expect(health.status).toBe(503);
    } finally {
      await server.close();
    }
  });
});

describe('the logger', () => {
  it('emits NDJSON with the fixed fields a run is diagnosed by', async () => {
    const lines: string[] = [];
    const destination = new Writable({
      write(chunk, _encoding, callback) {
        lines.push(String(chunk));
        callback();
      },
    });

    const logger = createLogger({
      destination,
      base: { runId: 'r-1', site: 'br-trf5' },
    });
    logger.info({ partitionId: '2024-05-15..2024-05-15', idOrigem: '16730', attempt: 2 }, 'listed');
    await new Promise((resolve) => setImmediate(resolve));

    const entry = JSON.parse(lines.join('')) as Record<string, unknown>;
    expect(entry['runId']).toBe('r-1');
    expect(entry['site']).toBe('br-trf5');
    expect(entry['partitionId']).toBe('2024-05-15..2024-05-15');
    expect(entry['idOrigem']).toBe('16730');
    expect(entry['msg']).toBe('listed');
    // A human-readable timestamp, not epoch millis.
    expect(String(entry['time'])).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('carries the parent fields into a child', async () => {
    const lines: string[] = [];
    const destination = new Writable({
      write(chunk, _encoding, callback) {
        lines.push(String(chunk));
        callback();
      },
    });
    const logger = createLogger({ destination, base: { runId: 'r-1' } });
    logger.child({ component: 'search' }).warn({ failureClass: 'RATE_LIMITED' }, 'backing off');
    await new Promise((resolve) => setImmediate(resolve));

    const entry = JSON.parse(lines.join('')) as Record<string, unknown>;
    expect(entry['runId']).toBe('r-1');
    expect(entry['component']).toBe('search');
    expect(entry['failureClass']).toBe('RATE_LIMITED');
  });

  it('has a silent variant for tests that assert on behaviour rather than output', () => {
    const logger = silentLogger();
    expect(() => {
      logger.info({}, 'x');
      logger.child({ a: 'b' }).error({}, 'y');
    }).not.toThrow();
  });
});
