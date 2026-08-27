# Guía de lectura — cómo funciona este scraper y por qué está hecho así

> **Para quién es.** Para quien va a evaluar o mantener este repositorio y quiere entender la
> solución antes de (o en vez de) leer el código. Es un documento semi-técnico: explica los
> hallazgos sobre el sitio, los problemas que plantean, la estrategia elegida y cómo comprobar
> que funciona. El `README.md` dice cómo ejecutarlo; esta guía dice cómo pensarlo.
>
> **Tiempo de lectura.** 15–20 minutos de corrido. Las secciones 2, 4 y 6 son las que más
> explican las decisiones; la 8 es un recorrido de verificación de 10 minutos.

---

## 0. El mapa mental en 60 segundos

El objetivo es extraer **todos** los procesos judiciales publicados en la Consulta Pública del
PJe del TRF5, con todos sus datos y sus PDFs, usando sólo HTTP (sin automatizar un navegador).

La intuición dice "recorre las páginas 1, 2, 3…". **No hay páginas.** El sitio devuelve como
máximo 30 resultados por búsqueda y no ofrece paginación: si la consulta abarca más, muestra los
primeros 30 y pide "refinar la búsqueda".

Así que el problema real no es *paginar*, es **cubrir**: construir un conjunto de búsquedas lo
bastante pequeñas para que ninguna se trunque y que, juntas, toquen todos los procesos sin dejar
huecos. Todo lo demás —cookies, encoding, reintentos, base de datos— es la plomería alrededor
de esa idea.

```
┌────────────────────────────────────────────────────────────────────────┐
│ 1. Abrir la página de búsqueda  → cookies + identificadores del form   │
│ 2. Buscar por rango de fechas    → hasta 30 procesos                   │
│    └─ ¿truncado? → partir el rango en dos y repetir (recursivo)        │
│ 3. Por cada proceso: abrir el detalle → partes, movimientos, documentos│
│ 4. Por cada proceso/documento: descargar el PDF → validar → almacenar  │
│    └─ ¿429? → esperar y reintentar; si insiste, anotarlo y seguir      │
│ 5. Antes de dar la corrida por buena: verificar que no falta nada      │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 1. El sitio: qué es y qué vocabulario aparece en los datos

**PJe** (*Processo Judicial eletrônico*) es el sistema de expediente electrónico de la justicia
brasileña; cada tribunal opera su instancia. **TRF5** es el Tribunal Regional Federal de la 5.ª
Región (Recife), segunda instancia federal del nordeste. La **Consulta Pública** es la parte
accesible sin usuario, obligatoria por la Resolución 121 del CNJ; los procesos bajo *segredo de
justiça* simplemente no aparecen.

La instancia objetivo es `pjett.trf5.jus.br` (nótese la doble *t*): un ambiente de
**treinamento/homologación**, no producción. Eso explica algunas particularidades que veremos.

Términos que aparecen en cada registro:

| Portugués | Qué es |
|---|---|
| `dataAutuação` | Fecha en que el proceso ingresó al sistema. Es el eje sobre el que se particiona todo. |
| `classe judicial` | Tipo de proceso (`APELAÇÃO CÍVEL`, …). Eje secundario de partición. |
| `assunto` | Materia, en jerarquía (`DIREITO TRIBUTÁRIO › Crédito Tributário › …`). |
| `polo ativo / passivo` | Las partes de cada lado, con sus abogados (OAB = colegio de abogados). |
| `movimentações` | Historial de actos del proceso, con fecha y hora. |
| `documentos juntados` | Documentos anexados (acórdãos, certidões…), cada uno con su PDF. |
| `órgão julgador` | Sala o gabinete que decide. |

### El número CNJ

Todo proceso tiene un identificador con formato nacional obligatorio. El scraper lo valida
(incluido el dígito verificador) y lo descompone:

```
0000007-07.1985.8.20.0124
│       │  │    │ │  └── unidad de origen
│       │  │    │ └───── tribunal
│       │  │    └─────── segmento de justicia (8 = estadual, 4 = federal, …)
│       │  └──────────── año de ingreso
│       └─────────────── dígito verificador
└─────────────────────── número secuencial
```

---

## 2. Los hallazgos que dictan el diseño

El reconocimiento del sitio se hizo con peticiones HTTP reales antes de escribir código. Cinco
hechos cambiaron la arquitectura; cada uno es un problema y tiene una respuesta concreta.

| # | Hallazgo | Problema que plantea | Cómo se aborda |
|---|---|---|---|
| 1 | **No hay captcha.** La página carga reCAPTCHA, pero el gancho de envío es literalmente `if (false) { grecaptcha.execute() }`. | Ninguno hoy. Pero es una condición del ambiente de treinamento: podría activarse. | Un **canario** comprueba en cada arranque que la bandera sigue en `false`. Si cambia, el scraper se detiene con un error explícito en vez de devolver cero resultados en silencio. |
| 2 | **Tope duro de 30 resultados, sin paginación.** Un rango de 10 años y uno de 6 meses devuelven ambos exactamente 30 filas; un solo día devolvió 24 sin truncar. | "Recorrer todo el sitio" es imposible con una consulta. Hay que inventar la completitud. | **Partición recursiva por fecha** (sección 4). Es el núcleo de la solución. |
| 3 | **El identificador interno viene gratis en el HTML.** Cada fila del listado tiene un `id` como `fPP:processosTable:16730:j_id255`; ese `16730` es el `idProcessoTrf`, la clave del proceso. | — (es una oportunidad) | Es la **clave de deduplicación** y permite construir la URL del PDF principal **sin abrir el detalle**, lo que desacopla la descarga de PDFs del resto. |
| 4 | **El botón visible no busca.** La búsqueda real la dispara un identificador autogenerado por JSF (`fPP:j_id244` hoy); enviar el formulario con el botón visible sólo re-renderiza un panel vacío. | Ese `j_id244` puede cambiar en cualquier despliegue. Hardcodearlo es una bomba de tiempo. | Se **extrae con una expresión regular** del `<script>` que define `executarPesquisa` en cada corrida. Si la regex no encuentra nada, canario y parada ruidosa. |
| 5 | **Encoding traicionero.** El servidor declara un juego de caracteres y el cuerpo puede venir en otro; decodificar mal produce `APELAÃÃO` en vez de `APELAÇÃO` de forma silenciosa. | Datos corruptos que *parecen* válidos. | El cliente HTTP **detecta** el charset (cabecera → declaración del documento → intento estricto UTF-8 → fallback Latin-1) y un canario rechaza cualquier cadena con secuencias de *mojibake* (`Ã`, `Â`). |

Y un hallazgo negativo, igual de importante:

| 6 | **El 429 no se pudo reproducir.** 15 peticiones secuenciales y 20 concurrentes devolvieron 200. El enunciado lo declara, así que existe; probablemente lo dispara el volumen sostenido o el balanceador. | El manejo de 429 es criterio de evaluación y no se puede validar contra el sitio real sin abusar de un servidor público. | Se implementa completo y se **prueba contra un servidor PJe falso** que inyecta 429 (con y sin `Retry-After`), 5xx, cortes de sesión, HTML donde debía venir un PDF, y PDFs truncados (sección 7). |

Dos detalles más del sitio que condicionan el código: las cookies fijan **afinidad a un nodo**
del clúster (perderlas provoca redirecciones al inicio), y el detalle de cada proceso se abre
con un **token `ca`** emitido por el listado, que se asume caducable.

---

## 3. Flujo completo, de punta a punta

```
─ BOOTSTRAP ───────────────────────────────────────────────────────────────
  GET /pjeconsulta/ConsultaPublica/listView.seam
    → guardar cookies (JSESSIONID, ROUTER_ID, trf501*) en el jar
    → extraer: action del form, id de acción (fPP:j_idNNN), ViewState
    → canarios: captcha apagado, id de acción encontrado, campos esperados
                              ↓
─ COBERTURA (recursiva, planificador) ─────────────────────────────────────
  POST listView.seam con dataAutuação inicio/fin [+ clase judicial]
    → respuesta = fragmento XHTML (A4J)
    → ¿"muitos processos" o 30 filas?  ─sí→ partir el rango y encolar hijos
                                        └no→ hoja resuelta: parsear filas
    → por fila: idProcessoTrf, token ca, número CNJ, clase, partes, última mov.
    → guardar en Postgres (dedup por idProcessoTrf) y encolar job "detail"
                              ↓
─ DETALLE (job por proceso, workers) ──────────────────────────────────────
  GET DetalheProcessoConsultaPublica/listView.seam?ca=<token>
    → ¿302 al listado? ⇒ sesión o token vencido ⇒ renovar y re-buscar la hoja
    → parsear: datos, polo ativo/passivo, movimentações, documentos
    → guardar (transacción) y encolar jobs "blob" (uno por PDF)
                              ↓
─ DESCARGA (job por PDF, workers) ─────────────────────────────────────────
  GET reportPDF.seam?idProcessoTrf=…            (carátula del proceso)
  GET reportReciboPDF.seam?idBin=…&idProcessoDoc=…  (uno por documento)
    → seguir el 302 → docstore con las mismas cookies
    → validar: empieza con %PDF-, termina con %%EOF, tamaño coherente
    → sha256 → subir al object storage con nombre descriptivo → registrar
    → 429 ⇒ esperar (Retry-After o backoff con jitter) ⇒ si persiste ⇒ "dead"
                              ↓
─ VERIFICACIÓN (antes de declarar la corrida buena) ───────────────────────
  · las hojas de partición cubren el rango raíz sin huecos ni solapes
  · ninguna hoja quedó truncada sin explicación (GAP = 0)
  · 0 cadenas con mojibake · 100 % de números CNJ válidos
  · tasa de nulos por campo dentro de lo esperado
  · cada PDF registrado existe, pesa > 1 KB y su hash coincide
  · re-muestreo: N hojas al azar se vuelven a consultar y los conteos coinciden
```

Una diferencia importante respecto a un scraper "de guion": los pasos no son un bucle en
memoria. Cada trabajo (buscar una partición, abrir un detalle, bajar un PDF) es una **fila en una
tabla de jobs** en Postgres. El planificador crea jobs; uno o varios workers los toman. Eso da
gratis tres propiedades que normalmente cuestan mucho: reanudación tras un corte, varios
procesos en paralelo sin duplicar trabajo, y una cola de fallidos consultable.

---

## 4. La estrategia de cobertura: cómo se vence el tope de 30

### La idea

Pensemos en todos los procesos ordenados por su `dataAutuação` en una línea de tiempo. Una
búsqueda por rango de fechas es "cuántos hay entre A y B, hasta 30". Si la respuesta viene
truncada, partimos el rango por la mitad y preguntamos por cada mitad. Repetimos hasta que
ninguna pregunta se trunque. El resultado es un **árbol binario** cuyas hojas son rangos que
caben enteros en una respuesta.

```
[1990 ─────────────────────────── 2027]   → truncado
       ├─ [1990 ── 2008]                  → 0 filas (se poda con una sola consulta)
       └─ [2009 ── 2027]                  → truncado
             ├─ [2009 ── 2018]            → 0 filas
             └─ [2019 ── 2027]            → truncado
                    ├─ …
                    └─ [2024-05-15]       → 24 filas, no truncado ⇒ HOJA
```

Preguntas naturales y sus respuestas:

- **¿Cómo sé el rango inicial si no conozco los datos?** No hace falta conocerlo: se usa una
  raíz amplia (configurable, por defecto desde 1990 hasta un año en el futuro). Cada mitad vacía
  cuesta **una** consulta y se descarta; el sobrecosto de una raíz generosa es logarítmico. Dos
  "sondas de borde" fuera de la raíz avisan si hubiera datos antes o después.
- **¿Y si un solo día tiene más de 30 procesos?** Se activa un **eje secundario**: la clase
  judicial. El día se vuelve a consultar una vez por cada clase conocida (el vocabulario de
  clases se cosecha de todas las filas vistas y se persiste). Si la suma de resultados por clase
  no alcanza a explicar los 30 visibles, hay clases desconocidas y el día se marca como **GAP**
  con la evidencia numérica. **Nunca se declara completo un día que la aritmética no respalda.**
- **¿Cómo se garantiza que no hay huecos?** Las hojas se persisten con su rango. Al final, se
  ordenan y se comprueba que cada una empieza exactamente donde terminó la anterior, desde el
  inicio de la raíz hasta su fin. En Postgres, además, una restricción de exclusión (`EXCLUDE
  USING gist` sobre `daterange`) hace **imposible** guardar dos hojas primarias que se solapen.
- **¿Cuánto cuesta?** Del orden de `2 × (días con datos) + podas`. Para unos miles de procesos
  repartidos en cientos de días, son ~1 500 consultas de ~3 s: minutos, no horas.
- **¿Y si el tope cambia de 30 a otro número?** No está hardcodeado: se lee del propio mensaje
  del sitio y se contrasta con el esperado; una diferencia detiene la corrida (el árbol ya
  construido no sería válido).

### Cómo se demuestra la completitud

`reports/coverage.md` (generado en cada corrida) muestra: el rango raíz, cuántas búsquedas se
hicieron, cuántas hojas hay, cuántas necesitaron el eje secundario, cuántos GAP quedaron (objetivo:
cero) y con qué evidencia, una tabla por año-mes con `Σ filas observadas` vs. `procesos únicos`
(deben coincidir), el resultado de la comprobación de teselado, y el estado de los PDFs
(conocidos / almacenados / pendientes / fallidos). El comando `verify --sample N` vuelve a
consultar N hojas al azar y compara conteos, para detectar deriva del sitio.

---

## 5. Los datos: qué se guarda y cómo se normaliza

El modelo es relacional porque el dominio lo es: un proceso tiene N partes, N abogados, N
movimientos, N documentos y N PDFs, y las consultas útiles cruzan esas entidades (¿qué procesos
tiene este CNPJ?, ¿qué movió esta semana este gabinete?).

```
site ─┬─ case_record (proceso) ─┬─ subject      (asuntos, jerarquía)
      │                         ├─ party        (partes, polo ativo/passivo)
      │                         ├─ lawyer       (abogados, OAB)
      │                         ├─ movement     (movimentações)
      │                         ├─ document     (documentos juntados)
      │                         └─ blob         (PDFs: URI de almacenamiento, sha256, estado)
      ├─ partition    (el árbol de cobertura)
      ├─ job          (la cola de trabajo; DLQ = status 'dead')
      ├─ site_throttle(limitador compartido por sitio)
      └─ crawl_run / metric
```

Toda clave primaria lleva el `site`: el modelo está pensado para consolidar varios tribunales, y
una columna `extra` (JSON) absorbe campos específicos de cada uno sin alterar el esquema.

Normalizaciones aplicadas antes de guardar: fechas `dd/MM/yyyy HH:mm:ss` → ISO-8601 con zona
(`-03:00`, América/Recife); CPF y CNPJ validados por dígito verificador y guardados como dígitos
(hay una opción `--anonymize` para exportes y muestras); número CNJ validado y descompuesto;
asuntos partidos en niveles; texto des-escapado de entidades HTML, normalizado (NFC) y libre de
mojibake. Un `content_hash` por proceso hace que volver a correr **no** genere escrituras si nada
cambió.

JSON y CSV existen como **formato de exportación** (`export --format jsonl|csv`), no como
almacenamiento: se generan directamente desde SQL.

---

## 6. Robustez: qué pasa cuando algo falla

### Clasificar antes de reaccionar

No todos los errores merecen reintento. Cada respuesta o excepción se clasifica primero, y la
clase decide la política:

| Clase | Ejemplo | Política |
|---|---|---|
| Limitación de tasa | HTTP 429 | Respetar `Retry-After` si viene; si no, backoff exponencial con *jitter*; bajar la concurrencia global; tras agotar intentos, marcar como `dead` y **seguir con el siguiente**. |
| Error del servidor | 500/502/503/504 | Reintentar pocas veces con backoff; alimenta el cortacircuitos. |
| Red / tiempo agotado | `ECONNRESET`, timeout | Igual que el anterior. |
| Sesión perdida | 302 al inicio, HTML donde debía venir un PDF | **No** es un reintento del mismo request: se renueva la sesión y se vuelve a buscar la hoja para refrescar el token; luego un reintento. |
| PDF inválido | sin `%PDF-`, sin `%%EOF`, tamaño incoherente | Nunca se escribe; dos reintentos; luego `dead`. |
| Error de cliente | 403/404 | Sin reintento (tres 403 seguidos abren el cortacircuitos: posible bloqueo). |
| **El sitio cambió** | captcha activado, id de acción no encontrado, tope distinto de 30 | **Sin reintento. Parada inmediata y ruidosa** con código de salida propio. |

### Por qué backoff *con jitter*

Un backoff exponencial puro (1 s, 2 s, 4 s…) hace que todos los workers que recibieron un 429 a
la vez vuelvan a golpear **a la vez**. El *jitter* (aleatoriedad en la espera) los dispersa. Se
usa la variante *decorrelated* (`espera = min(techo, aleatorio(base, espera_anterior × 3))`), que
dispersa mejor cuando los fallos se repiten.

### Cortesía proactiva, no sólo reactiva

Es un servidor público de un tribunal. El limitador arranca con 4 peticiones concurrentes (el
sitio toleró 20 en pruebas), sube de una en una tras rachas de éxito hasta un techo de 8, y se
reduce a la mitad ante cada 429 (esquema AIMD, el mismo principio que usa TCP). El estado del
limitador vive en Postgres, **compartido por todos los workers**: escalar a más procesos no
multiplica la presión sobre el tribunal, porque el límite es por sitio, no por proceso.

Un **cortacircuitos** detiene todo cuando la tasa de fallos en ventana supera el 50 % o el sitio
responde 403 repetidamente; espera, sondea con una petición y reabre. Cinco aperturas seguidas
sin recuperación abortan la corrida dejando el estado intacto para reanudar.

### La cola de fallidos (DLQ) y el reproceso

Un trabajo que agota sus reintentos no se pierde: queda en la tabla de jobs con estado `dead`,
su clase de fallo, el número de intentos, el último error y las marcas de tiempo. `dlq:list` los
muestra; `retry-dlq` los devuelve a `pending` para reprocesarlos con la misma política. Una
corrida que termina con jobs `dead` sale con código 1: es visible, no se maquilla.

### Reanudación e idempotencia

Como todo el estado (árbol, jobs, procesos, PDFs) vive en Postgres y cada job se toma con un
*lease* con vencimiento, matar el proceso en cualquier punto y volver a arrancar continúa donde
iba: los leases vencidos se liberan y otro worker los toma. Correr dos veces no duplica filas
(claves naturales + `content_hash`) ni vuelve a subir PDFs ya almacenados (se comprueba
existencia y hash antes de subir).

---

## 7. Cómo se probó lo que no se puede probar contra el sitio real

Provocar 429 deliberadamente contra un tribunal sería abusivo. La solución es un **servidor PJe
falso** incluido en el repositorio (`test/fake-pje-server/`): implementa el mismo contrato que el
sitio real —cookies con afinidad, formulario con identificador autogenerado, tope de 30 con el
mismo mensaje, detalle, redirección a *docstore*, PDFs válidos— sobre un **dataset sintético**
determinista (miles de procesos con días de 0, 1, 29, 30, 31 y 120 procesos, y un día diseñado
para desbordar el eje secundario). Además expone un panel de inyección de fallos: 429 con y sin
`Retry-After`, 5xx, latencia, corte de conexión, caducidad de sesión, HTML en vez de PDF, PDF
truncado, cambio del tope, captcha activado, identificador renombrado.

Sobre él corren las pruebas de extremo a extremo: completitud exacta (N sintéticos ⇒ N
guardados), respeto de `Retry-After`, paso a `dead` y continuación con el siguiente documento,
reproceso, renovación de sesión sin duplicados, `SIGKILL` a mitad de corrida y reanudación,
idempotencia (dos corridas ⇒ cero escrituras), y cada canario provocando su código de salida.

El servidor falso es, además, el **segundo "sitio"** del sistema: se registra como un adaptador
más, lo que obliga a que la abstracción multi-sitio sea real y no decorativa (sección 9).

---

## 8. Recorrido de verificación en 10 minutos

1. `npm run up` (Docker: Postgres + almacenamiento S3-compatible) — o `npm start` sin Docker, que
   cae automáticamente a un Postgres embebido y disco local. Ambos caminos están en CI.
2. Observe la línea de progreso: hojas resueltas / estimadas, procesos, PDFs, concurrencia actual,
   jobs `dead`, ETA.
3. Interrumpa con `Ctrl+C` y vuelva a ejecutar: continúa sin repetir trabajo.
4. `npm run verify` — ejecuta las comprobaciones de la sección 3 y devuelve 0 si todo cuadra.
5. `npm run report` — abra `reports/coverage.md`; busque `GAP = 0` y la tabla por año-mes.
6. `npm run dlq:list` y, si hay algo, `npm run retry-dlq`.
7. `npm run export -- --format csv` y abra el CSV.
8. Para ver la resiliencia sin tocar el sitio real: `npm run test:e2e` (usa el servidor falso).
9. Para ver el escalado horizontal: `npm run scale` (varios workers sobre la misma cola, sin
   duplicados, con la misma presión total sobre el sitio).
10. En el almacenamiento (consola web local en `:9001` con Docker), los PDFs aparecen como
    `br-trf5/<año>/<número CNJ>/<número CNJ>__relatorio__<id>.pdf` y
    `…__recibo__<idDoc>.pdf`.

---

## 9. Dónde está cada cosa

```
src/core/      lo que no sabe qué es el PJe: dominio, puertos, motor de cobertura, cola, políticas
src/sites/     un adaptador por sitio (br-trf5, fake-pje): sesión, formulario, parsers, canarios, ejes
src/infra/     implementaciones concretas: HTTP, Postgres/PGlite, S3/disco, logs, métricas
src/app/       composición: configuración, registro de adaptadores, comandos de CLI, roles
test/          unitarias, contratos (misma suite contra pg y PGlite; contra S3 y disco), e2e, fake-pje
docs/          esta guía, arquitectura resumida, decisiones (ADR), cómo añadir un sitio, reconocimiento
reports/       evidencia de la última corrida real
```

| Si quiere ver… | Mire |
|---|---|
| El algoritmo de partición | `src/core/engine/coverageEngine.ts` y `partitionTree.ts` |
| Cómo se extrae el id de acción dinámico y los canarios | `src/sites/br-trf5/parsers/listView.ts`, `src/sites/br-trf5/canaries.ts` |
| La detección de charset | `src/infra/http/encoding.ts` |
| La matriz de fallos y el backoff | `src/core/engine/failureClassifier.ts`, `retryPolicy.ts` |
| La cola y los leases | `src/infra/db/pgJobQueue.ts` |
| El limitador compartido | `src/infra/db/pgThrottle.ts` |
| La validación y nomenclatura de PDFs | `src/infra/blob/pdfValidate.ts`, `src/core/domain/blobKey.ts` |
| El esquema SQL | `src/infra/db/migrations/001_core.sql` |
| El servidor falso | `test/fake-pje-server/` |
| Por qué Postgres, por qué S3 API, por qué cola en Postgres, por qué hexagonal | `docs/ADR/` |

### Añadir otro tribunal

El motor no conoce el PJe. Un sitio nuevo es una carpeta en `src/sites/` que implementa la
interfaz `SiteAdapter` (cómo abrir sesión, cómo buscar, cómo se particiona, cómo se parsea el
detalle, qué PDFs tiene, qué canarios lo vigilan) y una línea en el registro. Si el sitio tiene
paginación clásica en vez de tope, su eje de partición es "página" y el motor sigue igual. La
guía paso a paso está en `docs/adding-a-site.md`, y la suite de contrato de adaptadores se
ejecuta sobre cualquier sitio registrado.

---

## 10. Límites y decisiones conscientes

- **Eje secundario.** Si un solo día tuviera más de 30 procesos de una misma clase judicial, ese
  día quedaría marcado como GAP con evidencia. Se prefirió declarar el límite a ocultarlo.
- **Ambiente de treinamento.** Los datos pueden reiniciarse y el captcha podría activarse; los
  canarios detectan lo segundo y el reporte lleva marca de tiempo para lo primero.
- **Datos personales.** CPF/CNPJ son públicos por norma, pero el repositorio no incluye datos
  extraídos, y las muestras se generan anonimizadas.
- **Sin orquestador.** El cuello de botella es la cortesía con un servidor público, no el
  cómputo: varios workers no descargan más rápido, sólo alcanzan antes el 429. El escalado se
  demuestra con `docker compose --scale`; Kubernetes tendría sentido para una flota de muchos
  sitios, no para uno.
- **Sin ORM, pocas dependencias.** El SQL explícito y seis dependencias de ejecución son una
  decisión: cada pieza del sistema es legible sin conocer un framework.
