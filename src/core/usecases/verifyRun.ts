/**
 * The sanity checks: what has to be true before a run is called good.
 *
 * These exist because "the crawler finished" and "the data is right" are different claims, and
 * only the second one matters. Each check below corresponds to a way this system could produce
 * confident, plausible, wrong output — and each is expressed as a query, so the answer comes
 * from the data rather than from the code's opinion of itself.
 *
 * A check has a severity. `error` means the run should not be trusted and the command exits 4;
 * `warn` means something is worth a human's attention but does not invalidate the result. The
 * distinction is deliberate: a scraper that fails loudly for every imperfection gets ignored,
 * and one that never fails gets believed when it should not be.
 */
import type { DateRange, PartitionNode } from '../domain/types.js';
import type { Repos } from '../ports/repos.js';
import type { SqlExecutor } from '../ports/sql.js';
import { assertTiling } from '../engine/partitionTree.js';
import { parseCaseNumber } from '../domain/cnj.js';
import { detectMojibake } from '../domain/text.js';
import { compareIsoDate } from '../domain/dates.js';

export type CheckSeverity = 'error' | 'warn';

export interface CheckResult {
  id: string;
  title: string;
  severity: CheckSeverity;
  ok: boolean;
  detail: string;
  /** Numbers a reader can check, rather than a verdict they have to trust. */
  evidence: Record<string, unknown>;
}

export interface VerifyReport {
  runId: string;
  site: string;
  checks: CheckResult[];
  ok: boolean;
  errors: number;
  warnings: number;
}

export interface VerifyInput {
  db: SqlExecutor;
  repos: Repos;
  site: string;
  runId: string;
  root: DateRange;
  /** Null rate above which a field is flagged. */
  nullRateWarn?: number;
}

export async function verifyRun(input: VerifyInput): Promise<VerifyReport> {
  const { db, repos, site, runId, root } = input;
  const nullRateWarn = input.nullRateWarn ?? 0.05;
  const checks: CheckResult[] = [];

  // ── 1. The tiling ─────────────────────────────────────────────────────────
  const leaves = await repos.partitions.primaryLeaves(runId);
  const tiling = assertTiling(leaves, root);
  checks.push({
    id: 'S-1',
    title: 'the resolved partitions tile the root exactly',
    severity: 'error',
    ok: tiling.ok,
    detail: tiling.ok
      ? `${String(leaves.length)} leaves cover ${String(tiling.coveredDays)} of ${String(tiling.rootDays)} days`
      : tiling.violations
          .slice(0, 5)
          .map((v) => `${v.kind}: ${v.detail}`)
          .join('; '),
    evidence: {
      leaves: leaves.length,
      coveredDays: tiling.coveredDays,
      rootDays: tiling.rootDays,
      violations: tiling.violations.length,
    },
  });

  // ── 2. Gaps ───────────────────────────────────────────────────────────────
  const gaps = await repos.reports.gapPartitions(runId);
  checks.push({
    id: 'S-2',
    title: 'no partition was left unexhausted',
    severity: 'error',
    ok: gaps.length === 0,
    detail:
      gaps.length === 0
        ? 'every partition resolved under the cap'
        : `${String(gaps.length)} partition(s) hit the cap with no axis able to divide them: ` +
          gaps
            .slice(0, 3)
            .map((g) => g.id)
            .join(', '),
    evidence: { gaps: gaps.map(gapEvidence) },
  });

  // ── 3. Arithmetic: observed rows against stored cases ─────────────────────
  const { observed, unique } = await repos.reports.observedRowsVsUnique(runId);
  checks.push({
    id: 'S-3',
    title: 'every stored case was actually seen in a result page',
    severity: 'error',
    // Observed may exceed unique — a truncated parent's rows are seen again by its children —
    // but a unique count above observed would mean rows appeared from nowhere.
    ok: observed >= unique,
    detail: `${String(observed)} row(s) observed across partitions, ${String(unique)} distinct case(s) stored`,
    evidence: { observed, unique },
  });

  // ── 4. Case numbers ───────────────────────────────────────────────────────
  const numbers = await db.query<{ numero: string }>(
    `SELECT numero FROM juris.case_record WHERE site = $1`,
    [site],
  );
  const malformed = numbers.rows.filter((r) => parseCaseNumber(r.numero) === null);
  const badDigit = numbers.rows.filter((r) => parseCaseNumber(r.numero)?.valido === false);
  checks.push({
    id: 'S-4',
    title: 'every case number is well formed',
    severity: 'error',
    ok: malformed.length === 0,
    detail:
      malformed.length === 0
        ? `${String(numbers.rows.length)} case number(s) parse`
        : `${String(malformed.length)} case number(s) do not parse, e.g. ${String(malformed[0]?.numero)}`,
    evidence: { total: numbers.rows.length, malformed: malformed.length },
  });
  checks.push({
    id: 'S-5',
    title: 'case number check digits validate',
    // A warning, not an error: the court is the source of truth, and a scraper that discarded
    // rows it disliked would be worse than one that flags them.
    severity: 'warn',
    ok: numbers.rows.length === 0 || badDigit.length / numbers.rows.length <= 0.01,
    detail:
      badDigit.length === 0
        ? 'all check digits validate'
        : `${String(badDigit.length)} of ${String(numbers.rows.length)} fail the mod-97 check, e.g. ${String(badDigit[0]?.numero)}`,
    evidence: { total: numbers.rows.length, invalid: badDigit.length },
  });

  // ── 5. Mojibake ───────────────────────────────────────────────────────────
  const text = await db.query<{ id_origem: string; sample: string }>(
    `SELECT id_origem, classe || ' ' || assunto_resumo || ' ' || partes_resumo AS sample
     FROM juris.case_record WHERE site = $1`,
    [site],
  );
  const corrupted = text.rows.filter((r) => detectMojibake(r.sample));
  checks.push({
    id: 'S-6',
    title: 'no stored text carries a mojibake signature',
    severity: 'error',
    ok: corrupted.length === 0,
    detail:
      corrupted.length === 0
        ? `${String(text.rows.length)} case(s) checked, all clean`
        : `${String(corrupted.length)} case(s) carry corrupted text, e.g. ${String(corrupted[0]?.id_origem)}`,
    evidence: { checked: text.rows.length, corrupted: corrupted.length },
  });

  // ── 6. Null rates ─────────────────────────────────────────────────────────
  const nullRates = await repos.reports.nullRates(site);
  const suspicious = Object.entries(nullRates).filter(([, rate]) => rate > nullRateWarn);
  checks.push({
    id: 'S-7',
    title: 'fields are populated at the expected rate',
    severity: 'warn',
    ok: suspicious.length === 0,
    detail:
      suspicious.length === 0
        ? 'every field is within its expected null rate'
        : suspicious
            .map(([field, rate]) => `${field} is null in ${(rate * 100).toFixed(1)} %`)
            .join('; '),
    evidence: { nullRates, threshold: nullRateWarn },
  });

  // ── 7. Dates ──────────────────────────────────────────────────────────────
  const dates = await db.query<{ mismatched: string | number; future: string | number }>(
    `SELECT
       count(*) FILTER (
         WHERE data_distribuicao IS NOT NULL
           AND (data_distribuicao < data_autuacao_ini OR data_distribuicao > data_autuacao_fim)
       ) AS mismatched,
       (SELECT count(*) FROM juris.movement m
         WHERE m.site = $1 AND m.data_hora > now() + interval '1 day') AS future
     FROM juris.case_record WHERE site = $1`,
    [site],
  );
  const mismatched = Number(dates.rows[0]?.mismatched ?? 0);
  const future = Number(dates.rows[0]?.future ?? 0);
  checks.push({
    id: 'S-8',
    title: 'dates are internally consistent',
    severity: 'warn',
    ok: future === 0 && (numbers.rows.length === 0 || mismatched / numbers.rows.length <= 0.05),
    detail:
      `${String(mismatched)} case(s) whose distribution date falls outside the partition that ` +
      `listed them; ${String(future)} movement(s) dated in the future`,
    evidence: { mismatched, future, total: numbers.rows.length },
  });

  // ── 8. Parties ────────────────────────────────────────────────────────────
  const parties = await db.query<{ detailed: string | number; without: string | number }>(
    `SELECT
       count(*) AS detailed,
       count(*) FILTER (
         WHERE NOT EXISTS (
           SELECT 1 FROM juris.party p
            WHERE p.site = c.site AND p.id_origem = c.id_origem
         )
       ) AS without
     FROM juris.case_record c WHERE c.site = $1 AND c.estado = 'DETAILED'`,
    [site],
  );
  const detailed = Number(parties.rows[0]?.detailed ?? 0);
  const without = Number(parties.rows[0]?.without ?? 0);
  checks.push({
    id: 'S-9',
    title: 'detailed cases have parties',
    severity: 'warn',
    ok: detailed === 0 || without / detailed <= 0.02,
    detail: `${String(without)} of ${String(detailed)} detailed case(s) have no party at all`,
    evidence: { detailed, without },
  });

  // ── 9. Stored documents ───────────────────────────────────────────────────
  const blobs = await db.query<{ stored: string | number; broken: string | number }>(
    `SELECT
       count(*) FILTER (WHERE estado = 'STORED') AS stored,
       count(*) FILTER (
         WHERE estado = 'STORED'
           AND (storage_uri IS NULL OR sha256 IS NULL OR bytes IS NULL OR bytes < 1024)
       ) AS broken
     FROM juris.blob WHERE site = $1`,
    [site],
  );
  const stored = Number(blobs.rows[0]?.stored ?? 0);
  const broken = Number(blobs.rows[0]?.broken ?? 0);
  checks.push({
    id: 'S-10',
    title: 'every stored document has a location, a hash and a plausible size',
    severity: 'error',
    ok: broken === 0,
    detail:
      broken === 0
        ? `${String(stored)} document(s) stored, all with a uri, a hash and a size`
        : `${String(broken)} stored document(s) are missing a uri, a hash or are under 1 KB`,
    evidence: { stored, broken },
  });

  // ── 10. Dead jobs ─────────────────────────────────────────────────────────
  const dead = await db.query<{ n: string | number }>(
    `SELECT count(*) AS n FROM juris.job WHERE site = $1 AND status = 'dead'`,
    [site],
  );
  const deadCount = Number(dead.rows[0]?.n ?? 0);
  checks.push({
    id: 'S-11',
    title: 'nothing was abandoned',
    severity: 'warn',
    ok: deadCount === 0,
    detail:
      deadCount === 0
        ? 'the dead letter queue is empty'
        : `${String(deadCount)} job(s) exhausted their retries; see npm run dlq:list`,
    evidence: { dead: deadCount },
  });

  const errors = checks.filter((c) => !c.ok && c.severity === 'error').length;
  const warnings = checks.filter((c) => !c.ok && c.severity === 'warn').length;
  return { runId, site, checks, ok: errors === 0, errors, warnings };
}

function gapEvidence(node: PartitionNode): Record<string, unknown> {
  return {
    id: node.id,
    range: node.range,
    facets: node.facets,
    observedRows: node.observedRows,
    capSeen: node.capSeen,
    reason: node.lastError,
  };
}

/**
 * Re-queries a sample of resolved leaves and compares the counts.
 *
 * The only check that needs the network. It answers a question none of the others can: has the
 * site changed since the crawl ran? A leaf that returned 24 cases last night and returns 31
 * today is not a bug in this code, but it does mean the report describes a dataset that no
 * longer exists, and a reader deserves to know that.
 */
export interface DriftSample {
  partitionId: string;
  storedRows: number;
  observedRows: number;
  drifted: boolean;
}

export interface DriftInput {
  repos: Repos;
  runId: string;
  sampleSize: number;
  search: (range: DateRange, facets: Record<string, string>) => Promise<number>;
  /** Fractional change that counts as drift. */
  tolerance?: number;
  random?: () => number;
}

export async function sampleDrift(input: DriftInput): Promise<{
  samples: DriftSample[];
  drifted: number;
}> {
  const tolerance = input.tolerance ?? 0.1;
  const random = input.random ?? Math.random;

  const leaves = (await input.repos.partitions.listByRun(input.runId))
    .filter((node) => node.status === 'LEAF_DONE' && (node.observedRows ?? 0) > 0)
    .sort((a, b) => compareIsoDate(a.range.ini, b.range.ini));

  const chosen: PartitionNode[] = [];
  const pool = [...leaves];
  while (chosen.length < Math.min(input.sampleSize, leaves.length) && pool.length > 0) {
    const index = Math.floor(random() * pool.length);
    const [picked] = pool.splice(index, 1);
    if (picked !== undefined) chosen.push(picked);
  }

  const samples: DriftSample[] = [];
  for (const node of chosen) {
    const observedRows = await input.search(node.range, node.facets);
    const storedRows = node.observedRows ?? 0;
    const delta = storedRows === 0 ? 0 : Math.abs(observedRows - storedRows) / storedRows;
    samples.push({
      partitionId: node.id,
      storedRows,
      observedRows,
      drifted: delta > tolerance,
    });
  }

  return { samples, drifted: samples.filter((s) => s.drifted).length };
}
