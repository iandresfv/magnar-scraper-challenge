# Añadir un tribunal

Un tribunal nuevo es **un directorio bajo `src/sites/` y una línea en `src/app/registry.ts`**. El
motor —particionar, detectar truncamiento, dividir, reintentar, verificar— no cambia, porque no
sabe qué es un expediente peruano: sólo conoce el puerto
[`src/core/ports/siteAdapter.ts`](../src/core/ports/siteAdapter.ts).

Esta guía usa como ejemplo `pe-cej`, la Consulta de Expedientes Judiciales del Poder Judicial del
Perú. El esqueleto que aparece abajo **se creó de verdad, pasó `npm run typecheck` y se borró**:
es código compilable, no pseudocódigo. Lo que no está medido son los datos concretos del sitio
—URLs, selectores, tope de filas, formato del token— porque eso sale del reconocimiento, que es
el trabajo previo a escribir la primera línea.

## 0. Antes del código: el reconocimiento

Nada de lo que sigue se puede escribir sin haber contestado antes, con capturas en la mano:

- ¿El sitio **pagina** o **corta en un tope**? Si corta, ¿lo declara en algún banner, o hay que
  inferirlo del número de filas? Ese número va a `expectedCap` y se contrasta en cada respuesta.
- ¿Qué campo ordena el espacio de búsqueda (una fecha, normalmente) y qué otro sirve de **eje
  secundario** cuando un solo día ya excede el tope?
- ¿Qué charset declara cada respuesta, y coincide con el real? ¿Y el del formulario, que puede
  ser otro?
- ¿Cómo se abre y cómo se pierde una sesión? ¿Hay captcha, aunque hoy esté inerte?
- ¿Cómo se llama un expediente y qué estructura tiene su número?
- ¿Qué binarios publica, con qué URL y bajo qué identidad estable?

El modelo de este trabajo son [`recon-trf5.md`](recon-trf5.md) y
[`spike-fase0.md`](spike-fase0.md). Cada respuesta capturada se versiona en `fixtures/`; los
parsers se prueban contra ella y nunca contra HTML inventado.

## 1. El esqueleto

```
src/sites/pe-cej/
├── adapter.ts            implementa SiteAdapter: sesión, búsqueda, detalle, binarios
├── axes.ts               los Axis de partición, en orden de prioridad
├── canaries.ts           los SanityCheck: qué tiene que seguir siendo verdad del sitio
├── parsers/
│   ├── search.ts         HTML → ListedCase[] + señales de truncamiento
│   └── detail.ts         HTML → CaseRecord
└── fixtures/
    ├── README.md         qué es cada archivo, de qué petición salió, en qué fecha
    └── *.html, *.pdf     respuestas reales del servidor
```

No hay `index.ts`: el registro importa la factoría directamente, y un barrel sólo añadiría un
nodo más al grafo de imports que el test de arquitectura recorre.

### `axes.ts`

El array **es** la estrategia de partición: el motor pregunta a cada eje en orden y usa el primero
que puede dividir. Si ninguno puede y la respuesta sigue truncada, la partición se declara `GAP`
con su aritmética, no se disimula.

```ts
/**
 * Cómo se corta una partición truncada en este sitio.
 *
 * El motor pregunta a cada eje en orden y usa el primero que puede dividir, así que este array
 * *es* la estrategia de partición: `[dateAxis, especialidadAxis]`.
 */
import type { DateRange, PartitionNode } from '../../core/domain/types.js';
import type { Axis, AxisContext, SearchPage } from '../../core/ports/siteAdapter.js';
import { daysInRange, splitByMidDay } from '../../core/domain/dates.js';
import { foldForComparison } from '../../core/domain/text.js';

/** El nombre de la faceta viaja en `PartitionNode.facets` y en `SearchQuery.facets`. */
export const ESPECIALIDAD_FACET = 'especialidad';

export const dateAxis: Axis = {
  name: 'date',

  canSplit(node) {
    return daysInRange(node.range) > 1;
  },

  split(node, _page, ctx) {
    const halves = splitByMidDay(node.range);
    if (halves === null) return [];
    return halves.map((range) => childNode(node, range, node.facets, ctx));
  },
};

/**
 * Toma el relevo cuando el rango ya es un solo día: re-consulta el día una vez por especialidad
 * conocida. El vocabulario lo alimenta el motor a partir de `ListedCase.classe`, así que el
 * parser tiene que poner ahí exactamente el valor por el que este eje filtra.
 */
export const especialidadAxis: Axis = {
  name: ESPECIALIDAD_FACET,

  canSplit(node, page, ctx) {
    if (daysInRange(node.range) > 1) return false;
    if (node.facets[ESPECIALIDAD_FACET] !== undefined) return false;
    return valuesFor(page, ctx).length > 0;
  },

  split(node, page, ctx) {
    return valuesFor(page, ctx).map((value) =>
      childNode(node, node.range, { ...node.facets, [ESPECIALIDAD_FACET]: value }, ctx),
    );
  },
};

/** El vocabulario acumulado más lo que esta página acaba de revelar, plegado sin acentos. */
function valuesFor(page: SearchPage, ctx: AxisContext): string[] {
  const seen = new Map<string, string>();
  for (const value of [...ctx.vocabulary(ESPECIALIDAD_FACET), ...page.rows.map((r) => r.classe)]) {
    const key = foldForComparison(value);
    if (key !== '' && !seen.has(key)) seen.set(key, value);
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b));
}

function childNode(
  parent: PartitionNode,
  range: DateRange,
  facets: Record<string, string>,
  ctx: AxisContext,
): PartitionNode {
  return {
    site: parent.site,
    id: ctx.childId(range, facets),
    runId: parent.runId,
    parentId: parent.id,
    range,
    facets,
    status: 'PENDING',
    observedRows: null,
    truncated: null,
    capSeen: null,
    attempts: 0,
    lastError: null,
    updatedAt: parent.updatedAt,
  };
}

export const PE_CEJ_AXES: readonly Axis[] = [dateAxis, especialidadAxis];
```

Dos detalles que no se ven en la interfaz y cuestan una tarde si se descubren tarde:

- **El vocabulario lo cosecha el motor de `ListedCase.classe`**, no de un campo arbitrario
  (`SearchHandler`, en `src/core/engine/handlers/search.ts`). El parser tiene que poner en
  `classe` exactamente el valor por el que filtra el eje secundario.
- El nombre de la faceta con el que el motor guarda ese vocabulario es `facetName`, y hoy
  `src/app/commands/crawl.ts` no lo pasa, así que vale `'classe'` por defecto. Un sitio cuya
  faceta se llame de otro modo necesita esa línea en la composición del `SearchHandler`
  (`facetName: ESPECIALIDAD_FACET`) o `ctx.vocabulary('especialidad')` devolverá siempre vacío y
  el eje secundario nunca podrá dividir.

### `canaries.ts`

Un canario vigila un supuesto del sitio, comprobado donde es más barato comprobarlo. Existen para
que el día que el tribunal cambie la corrida **se detenga** (código de salida 3) en vez de seguir
produciendo datos que parecen bien y no lo están. La regla que los ordena es una sola frase: un
scraper nunca debe devolver cero resultados en silencio.

```ts
/**
 * Los canarios de PE-CEJ: lo que tiene que seguir siendo verdad del sitio.
 *
 * Cada uno vigila un cambio que dejaría al crawler corriendo feliz y produciendo nada. Cuando
 * uno salta, la corrida se detiene con código 3: es un problema humano, no algo que reintentar.
 */
import type { SanityCheck } from '../../core/ports/siteAdapter.js';

export const PE_CEJ_CANARIES: readonly SanityCheck[] = [
  {
    id: 'PE-1',
    severity: 'error',
    description:
      'La respuesta de búsqueda sigue trayendo el contenedor de resultados. Si no está, la ' +
      'consulta no se ejecutó y leerla como "cero resultados" daría un día por cubierto sin ' +
      'haber mirado nada.',
  },
  {
    id: 'PE-2',
    severity: 'error',
    description:
      'El formulario de búsqueda no exige captcha. El sitio carga uno para otras consultas; si ' +
      'aparece un campo obligatorio en este flujo, cada búsqueda devolvería vacío en silencio.',
  },
  {
    id: 'PE-3',
    severity: 'error',
    description:
      'El tope de filas que el sitio declara sigue siendo el que el árbol de particiones asumió. ' +
      'Un tope distinto invalida cada hoja ya resuelta.',
  },
  {
    id: 'PE-4',
    severity: 'error',
    description:
      'Ningún texto extraído lleva firma de mojibake. Diez apariciones en una corrida son ' +
      'fatales: significa que la detección de charset es incorrecta para este despliegue.',
  },
];
```

El `id` es la referencia cruzada: lo levanta el parser (`throw new SiteChangedError('PE-4', …)`),
lo nombra el mensaje de la corrida abortada y lo documenta esta lista.

### `parsers/search.ts`

Aquí se decide la completitud, así que lo interesante no es extraer filas sino distinguir tres
estados que de lejos se parecen: vacío de verdad, truncado, y una respuesta que nunca ejecutó la
búsqueda. Confundir el tercero con el primero daría un día por cubierto sin haber mirado nada.

```ts
/**
 * Lee la respuesta de búsqueda del CEJ.
 *
 * Lo interesante no es extraer las filas, sino distinguir tres estados que de lejos se parecen:
 * un resultado vacío de verdad, un resultado truncado (hay más de lo que se ve, hay que partir)
 * y una respuesta que nunca ejecutó la búsqueda. Confundir el tercero con el primero daría un
 * día por cubierto sin haber mirado nada — el peor fallo posible en este sistema.
 */
import { load } from 'cheerio';
import type { DateRange, IsoDateTime, ListedCase } from '../../../core/domain/types.js';
import { SiteChangedError } from '../../../core/ports/siteAdapter.js';
import { brDateToIso, isoDateToStartOfDay } from '../../../core/domain/dates.js';
import { contentHashOf } from '../../../core/domain/hash.js';
import { cleanText, cleanTextOrNull, detectMojibake } from '../../../core/domain/text.js';

export interface SearchParseContext {
  site: string;
  partitionId: string;
  partitionRange: DateRange;
  /** Instante de la observación, inyectado: un parser no lee el reloj. */
  now: IsoDateTime;
  utcOffset: string;
  /** El tope contra el que se construyó el árbol. Uno distinto es fatal (PE-3). */
  expectedCap: number | null;
}

export interface SearchParseResult {
  rows: ListedCase[];
  truncated: boolean;
  capSeen: number | null;
  emptyMarker: boolean;
  /** Especialidades distintas vistas, que el motor cosecha hacia el vocabulario. */
  especialidades: string[];
}

/** El contenedor que una búsqueda real siempre re-renderiza. */
const RESULTS_CONTAINER = '#divDetalles';
const EMPTY_MARKER = /No se encontraron expedientes/i;
const CAP_BANNER = /se muestran (?:s[oó]lo )?los primeros (\d+)/i;

export function parseSearchResponse(html: string, ctx: SearchParseContext): SearchParseResult {
  const $ = load(html);

  if ($(RESULTS_CONTAINER).length === 0) {
    throw new SiteChangedError(
      'PE-1',
      'la respuesta no trae el contenedor de resultados: la búsqueda no llegó a ejecutarse',
      { bytes: html.length },
    );
  }

  const capMatch = CAP_BANNER.exec(html);
  const capSeen = capMatch?.[1] === undefined ? null : Number(capMatch[1]);
  if (capSeen !== null && ctx.expectedCap !== null && capSeen !== ctx.expectedCap) {
    throw new SiteChangedError('PE-3', `el sitio declara un tope de ${String(capSeen)} filas`, {
      capSeen,
      expectedCap: ctx.expectedCap,
    });
  }

  const rows: ListedCase[] = [];
  const especialidades = new Set<string>();

  $(`${RESULTS_CONTAINER} div.divRow`).each((_index, element) => {
    const row = $(element);
    const field = (name: string): string | null =>
      cleanTextOrNull(row.find(`[data-campo="${name}"]`).first().text());

    const idOrigem = cleanTextOrNull(row.attr('data-nroreg') ?? null);
    const numero = field('expediente');
    if (idOrigem === null || numero === null) return;

    const classe = field('proceso') ?? '';
    if (classe !== '') especialidades.add(classe);

    const estado = field('estado');
    const fechaInicio = field('fechaInicio');
    const iso = fechaInicio === null ? null : brDateToIso(fechaInicio);

    const listed: ListedCase = {
      site: ctx.site,
      idOrigem,
      // El CEJ no usa token de sesión por fila: el detalle se abre con el mismo `nroReg`.
      ca: idOrigem,
      numero,
      classe,
      sigla: field('instancia'),
      assuntoResumo: field('sumilla') ?? '',
      partesResumo: field('partes') ?? '',
      ultimaMovimentacao:
        estado === null || iso === null
          ? null
          : { descricao: estado, dataHora: isoDateToStartOfDay(iso, ctx.utcOffset) },
      partitionId: ctx.partitionId,
      partitionRange: ctx.partitionRange,
      contentHash: '',
      listedAt: ctx.now,
    };
    listed.contentHash = contentHashOf(listed);

    for (const value of [listed.classe, listed.assuntoResumo, listed.partesResumo]) {
      if (detectMojibake(value)) {
        throw new SiteChangedError('PE-4', `mojibake en ${cleanText(value).slice(0, 40)}`, {
          idOrigem,
        });
      }
    }

    rows.push(listed);
  });

  return {
    rows,
    // Cinturón y tirantes: el banner **o** una página llena. Si el banner desaparece, una página
    // al tope sigue forzando la división en vez de perder la cola en silencio.
    truncated: capSeen !== null || (ctx.expectedCap !== null && rows.length >= ctx.expectedCap),
    capSeen,
    emptyMarker: rows.length === 0 && EMPTY_MARKER.test(html),
    especialidades: [...especialidades],
  };
}
```

### `parsers/detail.ts`

El mapeo al dominio canónico. Los campos con nombre portugués (`polo`, `classe`, `assunto`) se
conservan tal cual: son la columna en la base, compartida por todos los sitios; lo que un tribunal
peruano llama distinto se traduce aquí, y lo que no tiene equivalente va a `extra`.

```ts
/**
 * Convierte la ficha del expediente en un `CaseRecord` canónico.
 *
 * Todo lo que sale de aquí ya está limpio: sin escapes HTML, en NFC, con espacios colapsados y
 * comprobado contra mojibake. Nada aguas abajo vuelve a hacer ese trabajo.
 */
import { load } from 'cheerio';
import type {
  CaseDocument,
  CaseRecord,
  IsoDateTime,
  Lawyer,
  ListedCase,
  Movement,
  Party,
  Polo,
} from '../../../core/domain/types.js';
import { SiteChangedError } from '../../../core/ports/siteAdapter.js';
import { brDateToIso, isoDateToStartOfDay } from '../../../core/domain/dates.js';
import { normalizeCaseNumber, parseCaseNumber } from '../../../core/domain/cnj.js';
import { contentHashOf } from '../../../core/domain/hash.js';
import { cleanText, cleanTextOrNull, detectMojibake } from '../../../core/domain/text.js';

export interface DetailParseContext {
  site: string;
  utcOffset: string;
  now: IsoDateTime;
  detailUrl: string;
  listUrl: string;
}

export function parseDetail(html: string, listed: ListedCase, ctx: DetailParseContext): CaseRecord {
  const $ = load(html);

  if ($('#divDetalleExpediente').length === 0) {
    throw new SiteChangedError('PE-1', 'la ficha del expediente no trae su contenedor principal', {
      idOrigem: listed.idOrigem,
    });
  }

  const field = (name: string): string | null =>
    cleanTextOrNull($(`[data-campo="${name}"]`).first().text());

  const partes: Party[] = [];
  $('#divPartes tr').each((ordem, element) => {
    const nome = cleanTextOrNull($(element).find('td.nombre').text());
    if (nome === null) return;
    partes.push({
      site: ctx.site,
      idOrigem: listed.idOrigem,
      polo: poloOf(cleanText($(element).find('td.tipo').text())),
      ordem,
      nome,
      tipoParticipacao: cleanText($(element).find('td.tipo').text()),
      // El CEJ no publica DNI ni RUC de las partes: no hay documento que normalizar.
      documento: null,
      situacao: cleanTextOrNull($(element).find('td.situacion').text()),
    });
  });

  const advogados: Lawyer[] = [];
  const movimentacoes: Movement[] = [];
  $('#divSeguimiento tr').each((seq, element) => {
    const descricao = cleanTextOrNull($(element).find('td.detalle').text());
    const fecha = cleanTextOrNull($(element).find('td.fecha').text());
    const iso = fecha === null ? null : brDateToIso(fecha);
    if (descricao === null || iso === null) return;
    movimentacoes.push({
      site: ctx.site,
      idOrigem: listed.idOrigem,
      seq,
      dataHora: isoDateToStartOfDay(iso, ctx.utcOffset),
      descricao,
    });
  });

  const documentos: CaseDocument[] = [];
  $('#divSeguimiento a.descargaPDF').each((index, element) => {
    const idDoc = cleanTextOrNull($(element).attr('data-iddoc') ?? null);
    if (idDoc === null) return;
    documentos.push({
      site: ctx.site,
      idOrigem: listed.idOrigem,
      idDoc,
      // El CEJ direcciona el binario sólo por `idDoc`; no hay un segundo identificador.
      idBin: null,
      tipo: cleanText($(element).attr('data-tipo') ?? 'resolucion'),
      juntadoEm: movimentacoes[index]?.dataHora ?? null,
      titulo: cleanTextOrNull($(element).text()),
    });
  });

  const distribuicao = field('fechaInicio');
  const record: CaseRecord = {
    site: ctx.site,
    idOrigem: listed.idOrigem,
    numero: listed.numero,
    numeroNorm: normalizeCaseNumber(listed.numero),
    // `parseCaseNumber` implementa la Resolución 65 del CNJ brasileño; un expediente peruano no
    // encaja y se guarda sin descomponer, con sus partes en `extra`.
    numeroParts: parseCaseNumber(listed.numero),
    classe: listed.classe,
    classeCodigo: null,
    sigla: listed.sigla,
    assuntos: [],
    assuntoResumo: field('sumilla') ?? listed.assuntoResumo,
    dataDistribuicao: distribuicao === null ? null : brDateToIso(distribuicao),
    // La única verdad sobre la fecha es el rango de la hoja que lo listó.
    dataAutuacao: listed.partitionRange,
    jurisdicao: field('distritoJudicial'),
    orgaoJulgador: field('organoJurisdiccional'),
    orgaoJulgadorColegiado: null,
    endereco: null,
    processoReferencia: null,
    partesResumo: listed.partesResumo,
    ultimaMovimentacao: listed.ultimaMovimentacao,
    partes,
    advogados,
    movimentacoes,
    documentos,
    extra: {
      juez: field('juez'),
      especialidad: field('especialidad'),
      instancia: field('instancia'),
    },
    fonte: { listUrl: ctx.listUrl, detailUrl: ctx.detailUrl },
    contentHash: '',
    state: 'DETAILED',
    listedAt: listed.listedAt,
    detailedAt: ctx.now,
  };
  record.contentHash = contentHashOf(record);

  if (detectMojibake(JSON.stringify(record))) {
    throw new SiteChangedError('PE-4', 'la ficha trae texto con firma de mojibake', {
      idOrigem: listed.idOrigem,
    });
  }

  return record;
}

function poloOf(tipo: string): Polo {
  const folded = tipo.toUpperCase();
  if (folded.includes('DEMANDANTE')) return 'ATIVO';
  if (folded.includes('DEMANDADO')) return 'PASSIVO';
  return 'OUTROS';
}
```

### `adapter.ts`

Todo lo que el tribunal tiene de peculiar, detrás de la interfaz genérica. Nótese que el
adaptador no duerme, no cuenta intentos y no decide si algo merece reintentarse: **clasifica**, y
devolver `null` en `classify` significa «sin opinión, usa la respuesta genérica».

```ts
/**
 * El adaptador de PE-CEJ: todo lo que este tribunal tiene de peculiar, detrás de la interfaz
 * genérica.
 *
 * El motor que lo conduce no sabe qué es una especialidad ni un `nroReg`. Pide una sesión, pide
 * una búsqueda y pregunta cómo partir una partición que volvió truncada. Esa separación es la
 * que hace que añadir un tribunal sea un directorio y no una refactorización.
 */
import type { BlobRequest, CaseRecord, FailureClass, ListedCase } from '../../core/domain/types.js';
import type { HttpPort, HttpResponse } from '../../core/ports/http.js';
import type {
  GoldenProbe,
  SearchPage,
  SearchQuery,
  SiteAdapter,
  SiteDescriptor,
  SiteSession,
} from '../../core/ports/siteAdapter.js';
import { SiteChangedError } from '../../core/ports/siteAdapter.js';
import { blobLogicalKey } from '../../core/domain/blobKey.js';
import { isoToBrDate } from '../../core/domain/dates.js';
import { formBodyBytes, urlencodeForm } from '../../shared/form.js';
import { PE_CEJ_AXES, ESPECIALIDAD_FACET } from './axes.js';
import { PE_CEJ_CANARIES } from './canaries.js';
import { parseSearchResponse } from './parsers/search.js';
import { parseDetail } from './parsers/detail.js';

export const PE_CEJ_DESCRIPTOR: SiteDescriptor = {
  id: 'pe-cej',
  country: 'PE',
  name: 'Poder Judicial del Perú — Consulta de Expedientes Judiciales',
  baseUrl: 'https://cej.pj.gob.pe',
  timezone: 'America/Lima',
  // Perú no aplica horario de verano desde 1994, así que el offset es una constante.
  utcOffset: '-05:00',
};

/** La medición contra la que se contrasta la corrida al arrancar. Sale del reconocimiento. */
export const PE_CEJ_GOLDEN_PROBE: GoldenProbe = {
  query: { range: { ini: '2024-05-15', fim: '2024-05-15' }, facets: {} },
  expectedRows: 18,
  tolerance: 0.2,
};

/** El tope que impone el sitio. Se lee de su propio banner en cada corrida; esto es la expectativa. */
export const PE_CEJ_EXPECTED_CAP = 200;

const APP = '/cej/forms';

export interface PeCejAdapterOptions {
  baseUrl?: string;
  now?: () => Date;
}

interface PeCejSessionState extends Record<string, unknown> {
  /** Token de formulario que el sitio renueva en cada visita a la página de búsqueda. */
  token: string;
}

export class PeCejAdapter implements SiteAdapter {
  readonly descriptor: SiteDescriptor;
  readonly axes = PE_CEJ_AXES;
  readonly expectedCap = PE_CEJ_EXPECTED_CAP;
  readonly canaries = PE_CEJ_CANARIES;
  readonly goldenProbe = PE_CEJ_GOLDEN_PROBE;

  private readonly baseUrl: string;
  private readonly now: () => Date;
  private sessionCounter = 0;

  constructor(options: PeCejAdapterOptions = {}) {
    this.baseUrl = options.baseUrl ?? PE_CEJ_DESCRIPTOR.baseUrl;
    this.descriptor = { ...PE_CEJ_DESCRIPTOR, baseUrl: this.baseUrl };
    this.now = options.now ?? (() => new Date());
  }

  private get searchFormUrl(): string {
    return `${this.baseUrl}${APP}/busquedaform.html`;
  }

  async bootstrap(http: HttpPort): Promise<SiteSession> {
    const jar = http.newJar();
    const response = await http.send({ method: 'GET', url: this.searchFormUrl }, jar);
    if (response.status !== 200) {
      // Un rechazo no es un rediseño. Un 429 o un 5xx es exactamente para lo que existe la
      // política de reintentos; llamarlo cambio de sitio pararía la corrida por un mal minuto.
      throw new PeCejFetchError(
        `la página de búsqueda respondió ${String(response.status)} en vez de 200`,
        response.status === 429
          ? 'RATE_LIMITED'
          : response.status >= 500
            ? 'SERVER_ERROR'
            : 'CLIENT_ERROR',
      );
    }

    const html = response.text();
    if (/name="codigoCaptcha"/i.test(html)) {
      throw new SiteChangedError('PE-2', 'el formulario de búsqueda ahora exige captcha', {});
    }
    const token = /name="_token"\s+value="([^"]+)"/i.exec(html)?.[1];
    if (token === undefined) {
      throw new SiteChangedError('PE-1', 'el formulario de búsqueda ya no publica su token', {});
    }

    return {
      id: `pe-cej-${String(++this.sessionCounter)}`,
      jar,
      state: { token } satisfies PeCejSessionState,
      createdAt: this.now().getTime(),
      requests: 1,
    };
  }

  async renew(http: HttpPort, _session: SiteSession, _reason: FailureClass): Promise<SiteSession> {
    // Una sesión muerta no se repara, se reemplaza: tarro de galletas nuevo y token nuevo.
    return this.bootstrap(http);
  }

  async search(http: HttpPort, session: SiteSession, query: SearchQuery): Promise<SearchPage> {
    const form = urlencodeForm({
      _token: tokenOf(session),
      fechaInicio: isoToBrDate(query.range.ini),
      fechaFin: isoToBrDate(query.range.fim),
      especialidad: query.facets[ESPECIALIDAD_FACET] ?? '',
    });

    const response = await http.send(
      {
        method: 'POST',
        url: `${this.baseUrl}${APP}/filtrarExpedientes.html`,
        headers: { 'Content-Type': form.contentType, Referer: this.searchFormUrl },
        body: formBodyBytes(form),
        expect: 'html',
      },
      session.jar,
    );
    session.requests++;

    if (response.status !== 200) {
      throw new PeCejFetchError(
        `la búsqueda respondió ${String(response.status)}`,
        this.classify(response) ?? 'SERVER_ERROR',
      );
    }

    const parsed = parseSearchResponse(response.text(), {
      site: this.descriptor.id,
      partitionId: partitionIdOf(query),
      partitionRange: query.range,
      now: this.now().toISOString(),
      utcOffset: this.descriptor.utcOffset,
      expectedCap: this.expectedCap,
    });

    return {
      rows: parsed.rows,
      truncated: parsed.truncated,
      capSeen: parsed.capSeen,
      emptyMarker: parsed.emptyMarker,
    };
  }

  async fetchDetail(http: HttpPort, session: SiteSession, listed: ListedCase): Promise<CaseRecord> {
    const url = `${this.baseUrl}${APP}/detalleform.html?nroReg=${listed.ca}`;
    const response = await http.send({ method: 'GET', url, expect: 'html' }, session.jar);
    session.requests++;

    if (response.status !== 200) {
      throw new PeCejFetchError(
        `el detalle de ${listed.idOrigem} respondió ${String(response.status)}`,
        this.classify(response) ?? 'SERVER_ERROR',
      );
    }

    return parseDetail(response.text(), listed, {
      site: this.descriptor.id,
      utcOffset: this.descriptor.utcOffset,
      now: this.now().toISOString(),
      detailUrl: url,
      listUrl: this.searchFormUrl,
    });
  }

  /** Qué binarios tiene este expediente y cómo pedirlos. Puro: sin red y sin sesión. */
  documentsOf(record: CaseRecord): BlobRequest[] {
    return record.documentos.map((doc) => ({
      site: record.site,
      key: blobLogicalKey(doc.tipo, record.idOrigem, doc.idDoc),
      idOrigem: record.idOrigem,
      idDoc: doc.idDoc,
      tipo: doc.tipo,
      url: `${this.baseUrl}${APP}/descargaPDF.html?idDoc=${doc.idDoc}`,
      needsSession: true,
    }));
  }

  async fetchBlob(http: HttpPort, session: SiteSession, req: BlobRequest): Promise<Uint8Array> {
    const response = await http.send({ method: 'GET', url: req.url, expect: 'pdf' }, session.jar);
    session.requests++;

    if (response.redirectedTo?.includes('busquedaform.html') === true) {
      throw new PeCejFetchError(`bajando ${req.key} se perdió la sesión`, 'SESSION_LOST');
    }
    if (response.status !== 200) {
      throw new PeCejFetchError(
        `bajando ${req.key} el sitio respondió ${String(response.status)}`,
        this.classify(response) ?? 'SERVER_ERROR',
      );
    }
    return response.bodyBytes;
  }

  /**
   * Clasificación propia del sitio, encadenada después de la genérica. Devolver `null` significa
   * «sin opinión, usa la respuesta genérica»: esto es una cadena, no una sobreescritura.
   */
  classify(subject: HttpResponse | Error): FailureClass | null {
    if (subject instanceof PeCejFetchError) return subject.failureClass;
    if (subject instanceof SiteChangedError) return 'FATAL_SITE_CHANGED';
    if (subject instanceof Error) return null;

    // El CEJ devuelve la pantalla de búsqueda con 200 cuando la sesión caducó.
    if (subject.status === 200 && /id="frmBusquedaForm"/.test(subject.text())) {
      return 'SESSION_LOST';
    }
    return null;
  }
}

export class PeCejFetchError extends Error {
  constructor(
    message: string,
    readonly failureClass: FailureClass,
  ) {
    super(message);
    this.name = 'PeCejFetchError';
  }
}

function tokenOf(session: SiteSession): string {
  const token = (session.state as { token?: string }).token;
  if (token === undefined) throw new Error('la sesión no tiene token; hay que hacer bootstrap');
  return token;
}

/** Determinista y legible: forma parte de la identidad de la partición. */
function partitionIdOf(query: SearchQuery): string {
  const base = `${query.range.ini}..${query.range.fim}`;
  const facets = Object.entries(query.facets)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join(',');
  return facets === '' ? base : `${base}|${facets}`;
}

export function createPeCejAdapter(options: PeCejAdapterOptions = {}): PeCejAdapter {
  return new PeCejAdapter(options);
}
```

### `fixtures/`

Las respuestas reales, con un `README.md` que diga de qué petición salió cada una, en qué fecha,
qué charset declaraba y qué reparación se le aplicó (con el script que la hace y el test que la
comprueba). El modelo es
[`src/sites/br-trf5/fixtures/README.md`](../src/sites/br-trf5/fixtures/README.md), que documenta
una doble codificación real y por qué el criterio correcto no era «cero caracteres `Ã`».

## 2. El contrato que hay que cumplir

[`test/contract/siteAdapter.contract.ts`](../test/contract/siteAdapter.contract.ts) es una suite
parametrizada que no sabe nada de PJe, de JSF ni de un tope de treinta: sólo sabe lo que promete
el puerto. Es lo que convierte «la arquitectura es multi-sitio» de afirmación en comprobación.
Hoy la corren dos adaptadores por dos transportes distintos —`br-trf5` contra fixtures
versionados, `fake-pje` contra un servidor HTTP real sobre un socket real— y el tercero se
engancha igual.

### Cómo engancharse

Se añade un bloque a [`test/contract/siteAdapter.test.ts`](../test/contract/siteAdapter.test.ts):

```ts
runSiteAdapterContract({
  name: 'pe-cej (fixtures)',
  create: () => ({
    adapter: createSite('pe-cej', { now: () => new Date('2026-08-27T13:00:00Z') }),
    http: new FixtureHttp({ routes: peCejFixtureRoutes() }),
  }),
  // Un día que el reconocimiento midió con filas y con documentos.
  populatedQuery: { range: { ini: '2024-05-15', fim: '2024-05-15' }, facets: {} },
  // Un rango lo bastante ancho como para topar.
  truncatedQuery: { range: { ini: '2024-01-01', fim: '2024-12-31' }, facets: {} },
  // Un rango del que se sabe que no tiene nada.
  emptyQuery: { range: { ini: '1901-01-01', fim: '1901-12-31' }, facets: {} },
});
```

`peCejFixtureRoutes()` se escribe junto a `trf5FixtureRoutes()` en
[`test/support/fixtureHttp.ts`](../test/support/fixtureHttp.ts): es un `HttpPort` de verdad que
responde desde los archivos de `fixtures/`, no un mock. El camino del adaptador se ejecuta entero,
incluidos el tarro de galletas que pide al puerto y los redirects que gestiona él mismo.

Hay además una aserción final en ese archivo:

```ts
expect(siteIds().sort()).toEqual(['br-trf5', 'fake-pje']);
```

Registrar un sitio y no añadirlo a la suite **rompe el build**. Es deliberado: es exactamente la
omisión de la que depende todo el argumento abierto-cerrado.

### Qué prueba

| Grupo            | Lo que exige                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `descriptor`     | `id` en minúsculas y guiones, `country` ISO de dos letras, `baseUrl` absoluta, zona IANA, offset `±HH:MM`; al menos un eje con nombre; `expectedCap` positivo o `null`; al menos un canario, con severidad válida.                                                                                                                                                                                                                                |
| `bootstrap`      | La sesión tiene id, `requests > 0`, `createdAt > 0` y un tarro de galletas que el adaptador **no** construyó; `renew` devuelve otra sesión que sirve para buscar.                                                                                                                                                                                                                                                                                 |
| `search`         | Un rango poblado devuelve filas; cada fila trae `site`, `idOrigem`, `numero` y un `contentHash` de 64 hex; los `idOrigem` no se repiten; el texto no tiene mojibake; un rango vacío es `emptyMarker: true` y `truncated: false`, no un error; un rango ancho es `truncated: true` con exactamente `expectedCap` filas; el `capSeen` que se reporta es el que dijo el sitio; dos búsquedas iguales dan las mismas identidades y los mismos hashes. |
| `detail`         | La ficha produce un `CaseRecord` con `state: 'DETAILED'`, `detailedAt` no nulo, hash canónico, y `dataAutuacao` **igual al `partitionRange` de la fila** — la completitud se argumenta sobre la hoja que listó el caso, no sobre una fecha del detalle.                                                                                                                                                                                           |
| `documents`      | `documentsOf` es puro y determinista (dos llamadas, el mismo resultado), da al menos una petición, con clave única que contiene el `idOrigem` y URL absoluta; `fetchBlob` devuelve bytes que empiezan por `%PDF-`.                                                                                                                                                                                                                                |
| `classification` | `classify` devuelve `null` ante un error ajeno, en vez de opinar de todo.                                                                                                                                                                                                                                                                                                                                                                         |

### Una salvedad medida

El test `produces case numbers that parse` llama a `parseCaseNumber`, que implementa la
Resolución 65 del CNJ **brasileño**. Comprobado: para un expediente peruano
(`00871-2024-0-1801-JR-CI-05`) devuelve `null`, así que el primer tribunal no brasileño hará
fallar ese caso aunque el adaptador sea correcto.

El arreglo es del test, no del puerto: `AdapterSubject` gana un campo opcional
—`parseNumber?: (numero: string) => unknown | null`, con `parseCaseNumber` por defecto— y el
sitio pasa el suyo. `CaseRecord.numeroParts` ya admite `null` para ese caso, y las piezas del
número peruano viven en `extra`.

## 3. Dónde se registra

En [`src/app/registry.ts`](../src/app/registry.ts), que es la raíz de composición de los sitios:

```ts
import { createPeCejAdapter } from '../sites/pe-cej/adapter.js';

const REGISTRY = new Map<string, SiteFactory>([
  ['br-trf5', (o) => createTrf5Adapter(o ?? {})],
  ['pe-cej', (o) => createPeCejAdapter(o ?? {})],
  // …
]);
```

Hay además `registerSite(id, factory)` para dar de alta un sitio desde un test sin tocar el mapa.

**Si no se registra**, el directorio compila, ESLint lo revisa y el test de arquitectura lo
recorre —los tres trabajan sobre los archivos de `src/`, no sobre el registro—, pero:

- `createSite('pe-cej')` lanza `unknown site "pe-cej". Known sites: br-trf5, fake-pje`, que es lo
  que verá quien ejecute `crawl --site pe-cej` — ese mensaje lo fija un test, en
  `test/unit/trf5.adapter.test.ts`;
- `siteIds()` no lo lista, así que no aparece en ningún mensaje de ayuda ni de error;
- la suite de contrato **nunca lo ejecuta**: sigue en verde, y el sitio queda como código muerto
  que nadie comprueba.

Registrar es lo que lo pone bajo vigilancia.

## 4. Lo que un sitio no debe hacer

### No importar de `infra/` ni de `app/`

Lo prohíben dos cosas. ESLint, con `@typescript-eslint/no-restricted-imports` sobre
`src/sites/**/*.ts`, que da el aviso mientras se escribe; y
[`test/arch/imports.test.ts`](../test/arch/imports.test.ts), que construye el grafo de imports de
`src/` y lo recorre **transitivamente**: un archivo de `sites/` que importa otro de `sites/` que
importa `infra/` rompe igual la arquitectura, y una regla por archivo no lo vería. El test también
comprueba que no hay ciclos y que cada import relativo resuelve a un archivo real.

En la práctica esto se nota en dos sitios concretos:

- ¿Hace falta un tarro de galletas? Se pide al puerto: `http.newJar()`. Instanciar el de `infra/`
  sería decidir desde un tribunal qué implementación de cookies usa el proceso.
- ¿Hace falta codificar un formulario en un charset que no es UTF-8? Está en
  [`src/shared/form.ts`](../src/shared/form.ts), que existe precisamente porque el charset del
  formulario lo decide el **sitio** y `sites/` no puede alcanzar el transporte.

Lo mismo vale para el reloj y la configuración: el adaptador recibe `now` por opciones y no lee
`process.env`; los parsers reciben el instante en su contexto y no llaman a `new Date()`.

### No ejecutar JavaScript del sitio

Se parsea HTML con `cheerio`. Nada de navegador sin cabeza. Un scraper que ejecuta el JavaScript
del tribunal hereda su reCAPTCHA, su temporización y su capacidad de cambiar de comportamiento sin
que se note; uno que habla HTTP puro tiene fixtures reproducibles y una superficie que se puede
vigilar con canarios. Si el sitio esconde un valor en un `onclick`, se extrae con una expresión
regular y se le deshacen los escapes (`unescapeJsString`), como hace `br-trf5`.

### No decidir reintentos, esperas ni backoff

El adaptador **clasifica**; el motor decide. Un `FailureClass` (`RATE_LIMITED`, `SERVER_ERROR`,
`NETWORK`, `TIMEOUT`, `SESSION_LOST`, `NOT_PDF`, `PARSE`, `FATAL_SITE_CHANGED`…) es todo lo que un
sitio dice sobre un fallo; cuántos intentos, con qué backoff y si merece la pena reintentar lo
responde una tabla única en `core/engine/retryPolicy.ts`. En un adaptador no hay ni un `sleep`, ni
un contador de intentos, ni un `Retry-After` interpretado.

Dos corolarios que se ven en el código de arriba:

- Un 429 o un 5xx en `bootstrap` **no** es un cambio de sitio: es un mal minuto del servidor y se
  clasifica como tal. Sólo un 200 que ya no contiene el formulario es evidencia de rediseño.
- `classify` devuelve `null` cuando no tiene nada que aportar. Es una cadena, no una
  sobreescritura: la clasificación genérica sigue detrás.

### No dar por supuesto el tope

`expectedCap` es la expectativa contra la que se construyó el árbol de particiones, no la verdad.
La verdad se lee del banner del sitio en cada respuesta (`capSeen`) y se contrasta; un tope
distinto invalida todas las hojas ya resueltas, así que es un canario fatal y no una adaptación
silenciosa. Y `truncated` se calcula con cinturón y tirantes: el banner **o** una página llena.

### No tocar la base, el almacenamiento ni el log

Un sitio devuelve valores. Persistir, subir binarios, medir y registrar son trabajo del motor y de
`infra/`; por eso `documentsOf` es puro y no descarga nada, y por eso `fetchBlob` devuelve bytes
en vez de escribirlos.

## 5. Lista de comprobación

```sh
npm run lint        # ESLint con reglas con tipos, incluida la de capas sobre sites/
npm run typecheck   # tsc --noEmit, con strict, exactOptionalPropertyTypes y noUncheckedIndexedAccess
npm test            # vitest: unidad, contratos, arquitectura y extremo a extremo
npx prettier --check .
```

Los tres primeros tienen que estar en verde antes del commit. Dentro de `npm test`, los dos que
fallan primero cuando algo del sitio nuevo está mal son:

```sh
npx vitest run test/arch/imports.test.ts       # el sitio importó infra/ o app/, directa o transitivamente
npx vitest run test/contract/siteAdapter.test.ts # el adaptador no cumple el puerto, o no se enganchó a la suite
```

Y, antes de darlo por terminado, lo que ninguna herramienta comprueba: que el `README.md` de
`fixtures/` diga de dónde salió cada archivo, que cada canario tenga un parser que lo levante, y
que el `goldenProbe` sea una medición real del reconocimiento y no un número plausible.
