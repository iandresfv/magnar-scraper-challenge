/**
 * An in-memory metrics registry, flushed to `juris.metric` and exposed as Prometheus text.
 *
 * Deliberately about a hundred lines and no dependency. A client library would bring a
 * registry, a text formatter and a set of conventions this project already has opinions about,
 * to serve four counters and two histograms. The exposition format is a documented text
 * protocol; writing it is less code than configuring somebody else's writer.
 *
 * Histograms keep their samples rather than pre-bucketing, because at this volume — a few
 * thousand requests per run — exact quantiles are affordable and far more useful than buckets
 * chosen in advance by someone who had not seen the latencies yet.
 */
import type { MetricLabels, MetricSample, Metrics } from '../../core/ports/metrics.js';

interface Series {
  name: string;
  labels: MetricLabels;
  kind: 'counter' | 'gauge' | 'histogram';
  value: number;
  samples: number[];
}

/** Sample cap per histogram. Beyond this, reservoir sampling keeps the distribution honest. */
const MAX_SAMPLES = 10_000;

export class MetricsRegistry implements Metrics {
  private readonly series = new Map<string, Series>();
  private readonly random: () => number;

  constructor(options: { random?: () => number } = {}) {
    this.random = options.random ?? Math.random;
  }

  increment(name: string, labels: MetricLabels = {}, by = 1): void {
    this.upsert(name, labels, 'counter').value += by;
  }

  gauge(name: string, value: number, labels: MetricLabels = {}): void {
    this.upsert(name, labels, 'gauge').value = value;
  }

  observe(name: string, value: number, labels: MetricLabels = {}): void {
    const series = this.upsert(name, labels, 'histogram');
    series.value += value;
    if (series.samples.length < MAX_SAMPLES) {
      series.samples.push(value);
    } else {
      // Reservoir sampling: a long run keeps a representative distribution rather than only
      // its first ten thousand requests, at constant memory.
      const index = Math.floor(this.random() * (series.samples.length + 1));
      if (index < series.samples.length) series.samples[index] = value;
    }
  }

  snapshot(): MetricSample[] {
    return [...this.series.values()].map((series) => {
      const base: MetricSample = {
        name: series.name,
        labels: series.labels,
        value: series.kind === 'histogram' ? series.samples.length : series.value,
        kind: series.kind,
      };
      if (series.kind !== 'histogram' || series.samples.length === 0) return base;
      return { ...base, quantiles: quantiles(series.samples) };
    });
  }

  /** Everything, in Prometheus text exposition format. */
  toPrometheus(): string {
    const lines: string[] = [];
    const seen = new Set<string>();

    for (const series of this.series.values()) {
      if (!seen.has(series.name)) {
        seen.add(series.name);
        lines.push(
          `# TYPE ${series.name} ${series.kind === 'histogram' ? 'summary' : series.kind}`,
        );
      }
      const labels = renderLabels(series.labels);

      if (series.kind === 'histogram') {
        const q = quantiles(series.samples);
        for (const [quantile, value] of Object.entries(q)) {
          lines.push(
            `${series.name}${renderLabels({ ...series.labels, quantile })} ${String(Math.round(value))}`,
          );
        }
        lines.push(`${series.name}_sum${labels} ${String(Math.round(series.value))}`);
        lines.push(`${series.name}_count${labels} ${String(series.samples.length)}`);
        continue;
      }
      lines.push(`${series.name}${labels} ${String(series.value)}`);
    }

    return `${lines.join('\n')}\n`;
  }

  /** Clears the histogram samples after a flush, keeping counters cumulative. */
  resetHistograms(): void {
    for (const series of this.series.values()) {
      if (series.kind === 'histogram') series.samples.length = 0;
    }
  }

  private upsert(name: string, labels: MetricLabels, kind: Series['kind']): Series {
    const key = `${name}${renderLabels(labels)}`;
    let series = this.series.get(key);
    if (series === undefined) {
      series = { name, labels, kind, value: 0, samples: [] };
      this.series.set(key, series);
    }
    return series;
  }
}

function renderLabels(labels: MetricLabels): string {
  const entries = Object.entries(labels).sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) return '';
  const rendered = entries
    .map(([key, value]) => `${key}="${value.replace(/["\\\n]/g, '_')}"`)
    .join(',');
  return `{${rendered}}`;
}

/** Exact quantiles over the retained samples. */
export function quantiles(samples: readonly number[]): Record<string, number> {
  if (samples.length === 0) return {};
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (q: number): number =>
    sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
  return { '0.5': at(0.5), '0.95': at(0.95), '0.99': at(0.99) };
}

/** The metric names this project emits. Named here so the report and the endpoint agree. */
export const METRICS = {
  requests: 'juris_http_requests_total',
  requestSeconds: 'juris_http_request_duration_ms',
  jobs: 'juris_jobs_total',
  jobsPending: 'juris_jobs_pending',
  jobsDead: 'juris_jobs_dead',
  cases: 'juris_cases_total',
  blobs: 'juris_blobs_total',
  partitions: 'juris_partitions_total',
  concurrency: 'juris_site_concurrency',
  retries: 'juris_retries_total',
  breakerOpens: 'juris_breaker_opens_total',
} as const;
