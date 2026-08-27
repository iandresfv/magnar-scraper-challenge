/**
 * A five-request check that the real site still behaves the way this code believes it does.
 *
 * This is the thing to run before a real crawl, and the thing to run first when something looks
 * wrong. It exercises the whole vertical slice — session, search, detail, PDF — through the
 * production code path, not a reimplementation of it, so a green smoke means the adapter is
 * genuinely aligned with the live site.
 *
 * The budget is five requests and it is enforced, not merely intended. Nothing is written to
 * disk and nothing is stored: the PDF is validated in memory and discarded. It is a public court
 * server, and a health check has no business leaving a footprint on one.
 *
 * Exit codes match the crawler's own, so this can gate a deployment:
 *   0 everything matched · 3 a canary tripped · 4 a value was outside tolerance · 1 anything else
 *
 * Usage: `npm run smoke` or `npx tsx scripts/smoke.ts [--site br-trf5]`
 */
import { parseArgs } from 'node:util';
import { ExitCode } from '../src/core/domain/types.js';
import { SiteChangedError } from '../src/core/ports/siteAdapter.js';
import type { HttpPort, HttpRequest } from '../src/core/ports/http.js';
import type { CookieJarPort, HttpResponse } from '../src/core/ports/http.js';
import { FetchHttpClient } from '../src/infra/http/fetchHttpClient.js';
import { validatePdf } from '../src/infra/blob/pdfValidate.js';
import { detectMojibake } from '../src/core/domain/text.js';
import { createSite } from '../src/app/registry.js';

const MAX_REQUESTS = 5;

/** Wraps the real client and refuses to exceed the budget. A limit that is not enforced is a wish. */
class BudgetedHttp implements HttpPort {
  used = 0;
  constructor(
    private readonly inner: HttpPort,
    private readonly max: number,
  ) {}

  newJar(): CookieJarPort {
    return this.inner.newJar();
  }

  async send(req: HttpRequest, jar: CookieJarPort): Promise<HttpResponse> {
    if (this.used >= this.max) {
      throw new Error(`smoke budget of ${String(this.max)} requests exhausted at ${req.url}`);
    }
    this.used++;
    // One second between requests. Five requests are nothing, but the habit is the point.
    if (this.used > 1) await new Promise((resolve) => setTimeout(resolve, 1_000));
    return this.inner.send(req, jar);
  }
}

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

async function main(): Promise<number> {
  const { values } = parseArgs({ options: { site: { type: 'string', default: 'br-trf5' } } });
  const siteId = values.site ?? 'br-trf5';
  const write = (line: string): void => {
    process.stdout.write(`${line}\n`);
  };

  const adapter = createSite(siteId);
  const http = new BudgetedHttp(new FetchHttpClient({ defaultTimeoutMs: 45_000 }), MAX_REQUESTS);
  const checks: Check[] = [];

  write(`smoke: ${adapter.descriptor.name}`);
  write(`budget: ${String(MAX_REQUESTS)} requests, sequential, 1 s apart`);
  write('');

  // 1. Session. Every start-up canary fires inside bootstrap.
  const started = Date.now();
  const session = await adapter.bootstrap(http);
  checks.push({
    name: 'bootstrap',
    ok: true,
    detail: `session ${session.id} in ${String(Date.now() - started)} ms; canaries C-1, C-2, C-3, C-10 passed`,
  });

  // 2. The golden probe: the one measurement the site is checked against.
  const probe = adapter.goldenProbe;
  if (probe === undefined) {
    checks.push({ name: 'golden probe', ok: true, detail: 'this site declares none' });
  } else {
    const page = await adapter.search(http, session, probe.query);
    const low = probe.expectedRows * (1 - probe.tolerance);
    const high = probe.expectedRows * (1 + probe.tolerance);
    const withinTolerance = page.rows.length >= low && page.rows.length <= high;
    checks.push({
      name: 'golden probe',
      ok: withinTolerance && !page.truncated,
      detail:
        `${String(page.rows.length)} rows (expected ${String(probe.expectedRows)} ±${String(Math.round(probe.tolerance * 100))} %), ` +
        `truncated=${String(page.truncated)}`,
    });

    const mojibake = page.rows.filter((r) => detectMojibake(`${r.classe} ${r.partesResumo}`));
    checks.push({
      name: 'encoding',
      ok: mojibake.length === 0,
      detail:
        mojibake.length === 0
          ? 'no mojibake in any parsed field'
          : `${String(mojibake.length)} rows carry a mojibake signature`,
    });

    // 3. One detail, to prove the token and the detail parser still work together.
    const listed = page.rows[0];
    if (listed !== undefined) {
      const record = await adapter.fetchDetail(http, session, listed);
      const fields = [record.classe, record.jurisdicao, record.orgaoJulgador].filter(
        (v) => v !== null && v !== '',
      );
      checks.push({
        name: 'detail',
        ok: fields.length >= 2 && record.numeroParts?.valido === true,
        detail:
          `${record.numero} · ${record.classe} · ${String(record.partes.length)} parties · ` +
          `${String(record.movimentacoes.length)} movements · ${String(record.documentos.length)} documents`,
      });

      // 4. One PDF, validated in memory and thrown away.
      const request = adapter.documentsOf(record)[0];
      if (request !== undefined) {
        const bytes = await adapter.fetchBlob(http, session, request);
        const verdict = validatePdf({ bytes, declaredLength: bytes.byteLength });
        checks.push({
          name: 'pdf',
          ok: verdict.ok,
          detail: verdict.ok
            ? `${request.key}: ${String(verdict.bytes)} bytes, PDF ${verdict.version}, not stored`
            : `${request.key}: ${verdict.reason} — ${verdict.detail}`,
        });
      }
    }
  }

  for (const check of checks) {
    write(`${check.ok ? 'ok  ' : 'FAIL'} ${check.name.padEnd(14)} ${check.detail}`);
  }
  write('');
  write(`requests used: ${String(http.used)}/${String(MAX_REQUESTS)}`);

  const failed = checks.filter((c) => !c.ok);
  if (failed.length > 0) {
    write(
      `\n${String(failed.length)} check(s) outside tolerance: ${failed.map((c) => c.name).join(', ')}`,
    );
    return ExitCode.SANITY_FAILED;
  }
  write('\nthe site still behaves as this code expects');
  return ExitCode.OK;
}

try {
  process.exitCode = await main();
} catch (error) {
  if (error instanceof SiteChangedError) {
    process.stderr.write(`\ncanary ${error.canaryId} tripped: ${error.message}\n`);
    process.stderr.write(`${JSON.stringify(error.details)}\n`);
    process.exitCode = ExitCode.CANARY_FATAL;
  } else {
    process.stderr.write(
      `\nsmoke failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = ExitCode.DEAD_JOBS_REMAIN;
  }
}
