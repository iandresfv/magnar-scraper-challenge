/**
 * `npm run report` — the evidence a reader needs to believe the dataset.
 *
 * Four files, each answering a different question:
 *
 *   · `coverage.md`   — did we see everything? The tiling, the gaps, the arithmetic per month.
 *   · `coverage.json` — the same, machine-readable, for anyone who wants to check the sums.
 *   · `metrics.json`  — what the run cost: requests, latencies, retries, concurrency.
 *   · `sample.md`     — ten cases rendered legibly, so a human can eyeball the parsing.
 *
 * The last one is the one people skip and shouldn't. Every automated check in this repository
 * verifies that the data is *shaped* correctly; only a person reading ten records can notice that
 * a field is shaped correctly and means the wrong thing.
 *
 * `--anonymize` masks the identifiers, and is what makes `sample.md` safe to commit to a public
 * repository. It is on by default here for exactly that reason.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CaseRecord, DateRange, PartitionNode } from '../../core/domain/types.js';
import type { Repos } from '../../core/ports/repos.js';
import type { SqlExecutor } from '../../core/ports/sql.js';
import { ExitCode } from '../../core/domain/types.js';
import { assertTiling } from '../../core/engine/partitionTree.js';
import { anonymize } from '../../core/domain/personId.js';
import { verifyRun } from '../../core/usecases/verifyRun.js';
import type { PgCaseRepo } from '../../infra/db/repos/index.js';

export interface ReportOptions {
  db: SqlExecutor;
  repos: Repos & { cases: PgCaseRepo };
  site: string;
  runId?: string;
  outDir?: string;
  /** Mask CPF/CNPJ in the sample. On by default: the sample is meant to be shareable. */
  anonymize?: boolean;
  sampleSize?: number;
  write?: (line: string) => void;
  now?: () => Date;
}

export interface CoverageJson {
  generatedAt: string;
  site: string;
  runId: string;
  root: DateRange;
  partitions: {
    total: number;
    leaves: number;
    secondaryLeaves: number;
    gaps: number;
    split: number;
  };
  tiling: { ok: boolean; coveredDays: number; rootDays: number; violations: unknown[] };
  cases: Record<string, number>;
  documents: Record<string, number>;
  byMonth: { yearMonth: string; cases: number; leaves: number }[];
  gapDetail: {
    id: string;
    range: DateRange;
    facets: Record<string, string>;
    observedRows: number | null;
    capSeen: number | null;
    reason: string | null;
  }[];
  checks: { id: string; title: string; severity: string; ok: boolean; detail: string }[];
}

export async function reportCommand(options: ReportOptions): Promise<number> {
  const write = options.write ?? ((line: string): void => void process.stdout.write(`${line}\n`));
  const outDir = options.outDir ?? 'reports';
  const now = options.now ?? ((): Date => new Date());
  const shouldAnonymize = options.anonymize ?? true;

  const run =
    options.runId === undefined
      ? await options.repos.runs.latest(options.site)
      : await options.repos.runs.get(options.runId);
  if (run === null) {
    write(`no run to report on for site ${options.site}`);
    return ExitCode.SANITY_FAILED;
  }

  const partitions = await options.repos.partitions.listByRun(run.runId);
  const leaves = await options.repos.partitions.primaryLeaves(run.runId);
  const tiling = assertTiling(leaves, run.root);
  const cases = await options.repos.cases.countByState(options.site);
  const documents = await options.repos.blobs.countByState(options.site);
  const byMonth = await options.repos.reports.casesPerMonth(options.site);
  const gaps = await options.repos.reports.gapPartitions(run.runId);
  const verification = await verifyRun({
    db: options.db,
    repos: options.repos,
    site: options.site,
    runId: run.runId,
    root: run.root,
  });

  const coverage: CoverageJson = {
    generatedAt: now().toISOString(),
    site: options.site,
    runId: run.runId,
    root: run.root,
    partitions: {
      total: partitions.length,
      leaves: partitions.filter((p) => p.status === 'LEAF_DONE').length,
      secondaryLeaves: partitions.filter((p) => p.status === 'LEAF_DONE_SECONDARY').length,
      gaps: gaps.length,
      split: partitions.filter((p) => p.status === 'SPLIT' || p.status === 'SPLIT_SECONDARY')
        .length,
    },
    tiling: {
      ok: tiling.ok,
      coveredDays: tiling.coveredDays,
      rootDays: tiling.rootDays,
      violations: tiling.violations,
    },
    cases,
    documents,
    byMonth,
    gapDetail: gaps.map(gapRow),
    checks: verification.checks.map((c) => ({
      id: c.id,
      title: c.title,
      severity: c.severity,
      ok: c.ok,
      detail: c.detail,
    })),
  };

  const metrics = await readMetrics(options.db, run.runId);
  const sample = await buildSample(options, run.runId, shouldAnonymize);

  await mkdir(outDir, { recursive: true });
  await Promise.all([
    writeFile(join(outDir, 'coverage.json'), `${JSON.stringify(coverage, null, 2)}\n`),
    writeFile(join(outDir, 'coverage.md'), renderCoverageMarkdown(coverage)),
    writeFile(join(outDir, 'metrics.json'), `${JSON.stringify(metrics, null, 2)}\n`),
    writeFile(join(outDir, 'sample.md'), sample),
  ]);

  write(`wrote ${join(outDir, 'coverage.md')} and three more files`);
  write(
    `tiling ${coverage.tiling.ok ? 'holds' : 'is BROKEN'} · ` +
      `${String(coverage.partitions.gaps)} gap(s) · ` +
      `${String((cases['LISTED'] ?? 0) + (cases['DETAILED'] ?? 0))} case(s) · ` +
      `${String(documents['STORED'] ?? 0)}/${String(
        (documents['STORED'] ?? 0) + (documents['PENDING'] ?? 0),
      )} document(s) stored`,
  );
  if (!shouldAnonymize) {
    write('sample.md contains unmasked personal identifiers; do not commit it.');
  }
  return coverage.tiling.ok && verification.errors === 0 ? ExitCode.OK : ExitCode.SANITY_FAILED;
}

function gapRow(node: PartitionNode): CoverageJson['gapDetail'][number] {
  return {
    id: node.id,
    range: node.range,
    facets: node.facets,
    observedRows: node.observedRows,
    capSeen: node.capSeen,
    reason: node.lastError,
  };
}

async function readMetrics(db: SqlExecutor, runId: string): Promise<Record<string, unknown>> {
  const { rows } = await db.query<{
    name: string;
    labels: unknown;
    value: number | string;
    ts: Date | string;
  }>(`SELECT name, labels, value, ts FROM juris.metric WHERE run_id = $1 ORDER BY name`, [runId]);

  return {
    runId,
    samples: rows.map((row) => ({
      name: row.name,
      labels: typeof row.labels === 'string' ? (JSON.parse(row.labels) as unknown) : row.labels,
      value: Number(row.value),
      at: row.ts instanceof Date ? row.ts.toISOString() : String(row.ts),
    })),
  };
}

/**
 * Ten cases, rendered for a human.
 *
 * Spread across the run rather than taken from the top, because the first ten of anything tend
 * to be the ones that were easiest to parse.
 */
async function buildSample(
  options: ReportOptions,
  runId: string,
  shouldAnonymize: boolean,
): Promise<string> {
  const size = options.sampleSize ?? 10;
  const { rows } = await options.db.query<{ id_origem: string }>(
    `SELECT id_origem FROM juris.case_record
      WHERE site = $1 AND estado = 'DETAILED'
      ORDER BY md5(id_origem)
      LIMIT $2`,
    [options.site, size],
  );

  const lines: string[] = [
    `# Muestra del run \`${runId}\``,
    '',
    `> ${String(rows.length)} proceso(s) elegidos al azar entre los detallados, renderizados para`,
    '> inspección humana. Todas las comprobaciones automáticas verifican que los datos tengan la',
    '> *forma* correcta; sólo una persona leyendo diez registros nota que un campo bien formado',
    '> significa otra cosa.',
    '',
    shouldAnonymize
      ? '> **Anonimizado.** Los CPF/CNPJ se muestran enmascarados. Los datos completos están en la base.'
      : '> **SIN anonimizar.** Contiene identificadores personales; no publicar este archivo.',
    '',
  ];

  for (const row of rows) {
    const record = await options.repos.cases.get(options.site, row.id_origem);
    if (record === null) continue;
    const children = await options.repos.cases.children(options.site, row.id_origem);
    lines.push(...renderCase(record, children, shouldAnonymize));
  }

  if (rows.length === 0) lines.push('_No hay procesos detallados en este run._');
  return `${lines.join('\n')}\n`;
}

function renderCase(
  record: CaseRecord,
  children: Awaited<ReturnType<PgCaseRepo['children']>>,
  shouldAnonymize: boolean,
): string[] {
  const identify = (documento: { kind: string; formatted: string } | null): string => {
    if (documento === null) return '';
    const shown = shouldAnonymize
      ? anonymize(documento as Parameters<typeof anonymize>[0]).formatted
      : documento.formatted;
    return ` — ${documento.kind} ${shown}`;
  };

  return [
    `## ${record.numero}`,
    '',
    `| campo | valor |`,
    `|---|---|`,
    `| clase | ${record.classe}${record.classeCodigo === null ? '' : ` (${String(record.classeCodigo)})`} |`,
    `| distribución | ${record.dataDistribuicao ?? '—'} |`,
    `| partición que lo listó | ${record.dataAutuacao.ini}..${record.dataAutuacao.fim} |`,
    `| jurisdicción | ${record.jurisdicao ?? '—'} |`,
    `| órgano juzgador | ${record.orgaoJulgador ?? '—'} |`,
    `| asunto | ${children.assuntos.map((a) => a.descricao).join(' › ') || record.assuntoResumo} |`,
    '',
    `**Partes** (${String(children.partes.length)})`,
    '',
    ...(children.partes.length === 0
      ? ['_ninguna registrada_']
      : children.partes.map(
          (p) =>
            `- ${p.polo.toLowerCase()}: ${p.nome} (${p.tipoParticipacao})${identify(p.documento)}`,
        )),
    '',
    ...(children.advogados.length === 0
      ? []
      : [
          `**Abogados** (${String(children.advogados.length)})`,
          '',
          ...children.advogados.map(
            (a) =>
              `- ${a.nome}${a.registro === null ? '' : ` — OAB ${a.registro.uf}${a.registro.numero}`}${identify(a.documento)}`,
          ),
          '',
        ]),
    `**Movimientos** (${String(children.movimentacoes.length)}, se muestran 3)`,
    '',
    ...children.movimentacoes
      .slice(0, 3)
      .map((m) => `- ${m.dataHora.slice(0, 19).replace('T', ' ')} — ${m.descricao}`),
    '',
    `**Documentos** (${String(children.documentos.length)})`,
    '',
    ...(children.documentos.length === 0
      ? ['_ninguno_']
      : children.documentos.map(
          (d) =>
            `- ${d.tipo}${d.juntadoEm === null ? '' : ` — ${d.juntadoEm.slice(0, 10)}`}` +
            ` (idDoc ${d.idDoc}${d.idBin === null ? '' : `, idBin ${d.idBin}`})`,
        )),
    '',
    '---',
    '',
  ];
}

function renderCoverageMarkdown(c: CoverageJson): string {
  const totalCases = (c.cases['LISTED'] ?? 0) + (c.cases['DETAILED'] ?? 0);
  const storedDocs = c.documents['STORED'] ?? 0;
  const knownDocs = storedDocs + (c.documents['PENDING'] ?? 0) + (c.documents['FAILED'] ?? 0);

  const lines = [
    '# Reporte de cobertura',
    '',
    `> Run \`${c.runId}\` · sitio \`${c.site}\` · raíz ${c.root.ini}..${c.root.fim}`,
    `> Generado ${c.generatedAt}`,
    '',
    '## ¿Está todo?',
    '',
    'El sitio no pagina y corta en un tope por consulta, así que la completitud no se observa: se',
    'construye. Estas son las cifras que la sostienen.',
    '',
    '| | |',
    '|---|---|',
    `| Teselado del rango raíz | ${c.tiling.ok ? '✅ sin huecos ni solapes' : '❌ ROTO'} |`,
    `| Días cubiertos | ${String(c.tiling.coveredDays)} de ${String(c.tiling.rootDays)} |`,
    `| Particiones resueltas | ${String(c.partitions.leaves)} primarias + ${String(c.partitions.secondaryLeaves)} por clase |`,
    `| Particiones divididas | ${String(c.partitions.split)} |`,
    `| **GAP declarados** | **${String(c.partitions.gaps)}** |`,
    `| Procesos únicos | ${String(totalCases)} (${String(c.cases['DETAILED'] ?? 0)} con detalle) |`,
    `| Documentos | ${String(storedDocs)} almacenados de ${String(knownDocs)} conocidos |`,
    '',
  ];

  if (c.partitions.gaps > 0) {
    lines.push(
      '### GAP: lo que no se pudo agotar',
      '',
      'Una partición marcada GAP llegó al tope y **ningún eje pudo dividirla más**. Las filas que sí',
      'se vieron están guardadas; las que quedaron detrás del corte no son alcanzables con los',
      'filtros que el sitio ofrece. Se declara con su aritmética en vez de disimularse.',
      '',
      '| partición | filas visibles | tope | motivo |',
      '|---|---|---|---|',
      ...c.gapDetail.map(
        (g) =>
          `| \`${g.id}\` | ${String(g.observedRows ?? '—')} | ${String(g.capSeen ?? '—')} | ${g.reason ?? '—'} |`,
      ),
      '',
    );
  } else {
    lines.push('**No hay GAP:** cada partición resolvió por debajo del tope.', '');
  }

  if (!c.tiling.ok) {
    lines.push(
      '### Violaciones del teselado',
      '',
      ...c.tiling.violations.slice(0, 20).map((v) => `- \`${JSON.stringify(v)}\``),
      '',
    );
  }

  lines.push(
    '## Distribución por mes',
    '',
    '| año-mes | procesos | días con datos |',
    '|---|---|---|',
    ...c.byMonth.map((m) => `| ${m.yearMonth} | ${String(m.cases)} | ${String(m.leaves)} |`),
    '',
    '## Comprobaciones de sanidad',
    '',
    '| | id | comprobación | resultado |',
    '|---|---|---|---|',
    ...c.checks.map(
      (check) =>
        `| ${check.ok ? '✅' : check.severity === 'error' ? '❌' : '⚠️'} | ${check.id} | ${check.title} | ${check.detail} |`,
    ),
    '',
    '## Documentos pendientes',
    '',
    knownDocs === storedDocs ? 'Todos los documentos conocidos están almacenados.' : '',
  );

  if (knownDocs > storedDocs) {
    lines.push(
      `Quedan ${String(knownDocs - storedDocs)} documento(s) conocidos sin descargar, porque el`,
      'presupuesto de la corrida se agotó. Están registrados en `juris.blob` con estado `PENDING`;',
      'para completarlos:',
      '',
      '```',
      'npm start -- --pdf-budget all',
      '```',
      '',
    );
  }

  // Blank lines are meaningful in Markdown — a table with none before it does not render — so
  // they are kept, and only the trailing run is trimmed.
  return `${lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd()}\n`;
}
