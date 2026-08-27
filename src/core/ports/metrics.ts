/**
 * Counters and histograms, flushed to `juris.metric` and exposed as Prometheus text.
 *
 * Deliberately tiny: a registry, four verbs, no client library. The exposition format is a few
 * lines of string building, and a dependency here would buy nothing.
 */
export type MetricLabels = Record<string, string>;

export interface Metrics {
  increment(name: string, labels?: MetricLabels, by?: number): void;
  gauge(name: string, value: number, labels?: MetricLabels): void;
  observe(name: string, value: number, labels?: MetricLabels): void;
  snapshot(): MetricSample[];
}

export interface MetricSample {
  name: string;
  labels: MetricLabels;
  value: number;
  kind: 'counter' | 'gauge' | 'histogram';
  /** Only for histograms: the quantiles the reporter prints. */
  quantiles?: Record<string, number>;
}
