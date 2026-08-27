# Spike de Fase 0 — lo que se midió contra el sitio real antes de escribir el motor

> **Ejecutado:** 2026-08-27 · **Peticiones usadas:** 33 de un tope duro de 40 · secuenciales,
> 1,2 s entre cada una, User-Agent identificable. Reproducible con
> `npx tsx scripts/spike-fase0.ts --harvest-days 18 --ca-idle-seconds 600 --json out.json`.
>
> **Por qué existe este documento.** El reconocimiento ([`recon-trf5.md`](recon-trf5.md)) dejó
> cuatro supuestos sin verificar, y tres de ellos condicionan la arquitectura: si el eje
> secundario de partición funciona, si el token `ca` caduca, y si un día cabe siempre bajo el
> tope de 30. Escribir el motor sin medirlos habría sido construir sobre una suposición. Lo que
> sigue son mediciones, no inferencias; donde algo no se pudo medir, se dice.

---

## 1. Resultado en una tabla

| # | Pregunta abierta | Respuesta medida | Consecuencia en el código |
|---|---|---|---|
| a | ¿Qué charset devuelve cada endpoint? | **La respuesta A4J es UTF-8 real. La página de búsqueda y la de detalle declaran ISO-8859-1 y llevan bytes no-ASCII de verdad**, así que hay que creerles | Decodificación por detección (UTF-8 estricto → charset declarado → latin1). Ver §3 |
| b | ¿Cuál es el marcador exacto de "0 resultados"? | El pie **siempre** renderiza `<span class="text-muted">resultados encontrados</span>`; con resultados lleva el número delante | Cero se detecta por *número ausente*, no por un mensaje. Ver §4 |
| c | ¿`classeJudicial` filtra? (SUP-2, R-5) | **Sí, pero sólo si el cuerpo va codificado en latin1.** En UTF-8 devuelve 0 filas en silencio. Y el match es **por prefijo**, no exacto | El eje secundario existe. Ver §5 — es el hallazgo más importante del spike |
| d | ¿`numProcesso` parcial filtra? | **No.** `2024` sobre 1990–2027 devolvió 0 filas | **No hay tercer eje.** El nodo RESIDUAL y el GAP declarado siguen siendo necesarios |
| e | `Data da Distribuição` vs el día filtrado (SUP-3) | **Coincide en 4 de 4** detalles que cargaron | SUP-3 se sostiene. El sanity check 6 lo sigue midiendo en el run real |
| f | ¿Caduca el `ca`? (R-3) | **Sobrevive a otra búsqueda y a 10 minutos de inactividad.** Ambos `stillValid=true` | El pipeline de detalles **se puede desacoplar** del de búsqueda. Ver §6 |
| g | Vocabulario de clases | **20 clases** cosechadas de 18 días repartidos en 3 años | Semilla en `src/sites/br-trf5/classes.seed.json` |
| h | ¿Un día cabe siempre bajo el tope? | **No: 9 de 18 días muestreados (50 %) vinieron truncados** | El eje secundario no es un plan B: es camino habitual. Ver §7 |

Y dos hallazgos que nadie había pedido buscar, ambos con consecuencias:

| # | Hallazgo | Por qué importa |
|---|---|---|
| i | **Una cabecera `Cookie:` vacía hace que el F5 rechace la petición, y responde `200 OK`** con una página "Requisição - Rejeitada" | Falla en la primera petición de cada sesión, y falla en silencio. Ver §2 |
| j | Un `ca` de cada cinco redirigió a `errorUnexpected.seam` de forma reproducible | No todo 302 en el detalle es sesión perdida. Ver §6 |

---

## 2. El rechazo del WAF que parece un éxito

Éste es el hallazgo que más caro habría salido descubrir tarde.

La primera versión del spike enviaba siempre la cabecera `Cookie:`, tomada del jar — que en la
primera petición está vacío. El servidor respondió:

```
HTTP/1.1 200 OK
content-type: text/html;charset=ISO-8859-1
<title>Requisição - Rejeitada</title>          ← 22 287 bytes de página de error
```

**Status 200.** No 403, no 429, no 400. Un cliente que confíe en el código de estado ve una
respuesta perfectamente normal, la parsea, no encuentra el formulario y concluye "el sitio
cambió". Medido de forma aislada, cinco variantes:

| Cabeceras | Resultado |
|---|---|
| UA + Accept-Language + **`Cookie:` vacía** | **200, 22 287 B, "Requisição - Rejeitada"** |
| UA + Accept-Language, sin `Cookie` | 200, 48 116 B, formulario |
| sólo UA | 200, 48 143 B, formulario |
| UA + Accept + Accept-Language | 200, 48 143 B, formulario |
| sin cabeceras | 200, 48 116 B, formulario |

**Reglas que salen de aquí:**

1. La cabecera `Cookie` **se omite** cuando el jar está vacío; nunca se envía vacía.
2. La página de rechazo es un canario: `/Requisi[^<]*Rejeitada/` en un `200` se clasifica como
   bloqueo del WAF, no como cambio de sitio ni como error de parseo. Merece su propia clase de
   fallo y su propio mensaje, porque la acción correcta (bajar la concurrencia y reintentar con
   backoff) no es la de un `PARSE`.

---

## 3. Encoding: el recon estaba invertido, y el fixture escondía media verdad

El recon corregido ya decía que la respuesta A4J es UTF-8 y no ISO-8859-1. El spike lo confirma
y añade un matiz que **el fixture no podía mostrar**:

| Endpoint | `Content-Type` | Bytes reales | Rama que ganó |
|---|---|---|---|
| `GET listView.seam` | `charset=ISO-8859-1` | **Contiene bytes no-ASCII** (`nonAsciiBytes: true`) | **charset declarado** |
| `POST` A4J (resultados) | `charset=UTF-8` | UTF-8 real | UTF-8 estricto |
| `GET` detalle | `charset=ISO-8859-1` | Bytes no-ASCII + entidades | **charset declarado** |

El fixture `01-listview-form.html` capturado en el recon era ASCII puro con entidades, lo que
hacía pensar que el charset de las páginas completas era irrelevante. **En la página viva no lo
es.** Un decodificador que forzara UTF-8 sobre la página de búsqueda fallaría hoy.

El orden correcto, y el que implementa `src/infra/http/encoding.ts`, es: **UTF-8 estricto
primero** (porque el servidor declara ISO-8859-1 sobre cuerpos que son UTF-8), y si esos bytes
no son UTF-8 válido, entonces sí creerle a la declaración, y latin1 como último recurso. Nunca
hardcodear ninguno de los dos.

En el **sentido de subida** la regla es la contraria y es igual de importante: ver §5.

---

## 4. El marcador de "sin resultados"

No hay mensaje. El pie de la tabla siempre existe; lo que cambia es si lleva número:

```html
<span class="text-muted">resultados encontrados</span>        <!-- 0 resultados -->
<span class="text-muted">24 resultados encontrados</span>     <!-- 24 -->
<span class="text-muted">30 resultados encontrados</span>     <!-- 30, y además el banner -->
```

Además, toda respuesta de búsqueda real trae `<meta name="Ajax-Update-Ids"
content="fPP:processosGridPanel">`. Ese marcador es lo que distingue **una búsqueda que se
ejecutó y no encontró nada** de **la "trampa del botón"** del recon §4.1, que re-renderiza
`fPP:j_id248` y devuelve ~2,8 KB sin tocar la grilla. Sin esa distinción, postear el parámetro
equivocado se vería como "este rango está vacío" y el árbol de particiones se declararía
completo habiendo recorrido nada.

Cuerpo de una respuesta vacía: 4 846 bytes.

---

## 5. El eje secundario: por qué devolvía cero y por qué ahora funciona

Con el día dorado (15/05/2024, 24 procesos sin truncar) como control:

| Consulta | Filas |
|---|---|
| sin filtro de clase | **24** |
| `classeJudicial=APELAÇÃO CÍVEL`, cuerpo en **UTF-8** | **0** |
| `classeJudicial=APELAÇÃO CÍVEL`, cuerpo en **latin1** | **12** |
| `classeJudicial=APELACAO CIVEL` (sin acentos) | 12 |
| `classeJudicial=APELA` (prefijo) | **18** |

**Diagnóstico.** El formulario se sirve como ISO-8859-1 y el servidor decodifica el cuerpo con
ese charset. `URLSearchParams` codifica siempre en UTF-8, así que `Ç` viajaba como `%C3%87` y el
servidor lo leía como dos caracteres latin1 (`Ã‡`). El resultado es una búsqueda por un texto
que no existe: **cero filas, sin error, sin banner, indistinguible de un día sin procesos de esa
clase**. Es el mismo error de encoding del recon, en el sentido contrario.

**Regla:** el cuerpo del POST se codifica con el charset **de la página que sirvió el
formulario**, no con el de la respuesta. Son distintos, y esa asimetría es real.

**Dos propiedades más del filtro, medidas:**

- **Es insensible a acentos.** `APELACAO CIVEL` devuelve lo mismo que `APELAÇÃO CÍVEL`.
- **Es por prefijo, no exacto.** `APELA` devuelve 18 filas: `APELAÇÃO CÍVEL` (12) más las otras
  clases que empiezan igual (`APELAÇÃO CRIMINAL`, `APELAÇÃO / REMESSA NECESSÁRIA`).

La segunda propiedad tiene una consecuencia que el diseño original no contemplaba. Si una clase
del vocabulario es prefijo de otra, filtrar por la corta devuelve también las filas de la larga.
Eso **no pierde datos** —la deduplicación es por `idProcessoTrf`— pero sí rompe la aritmética
del nodo RESIDUAL (`Σ filas por clase` contra `filas visibles`), que es justamente la prueba de
que un día quedó completo. Dos mitigaciones, ambas implementadas:

1. La aritmética cuenta sólo las filas cuya clase **coincide exactamente** con el facet, no
   todas las devueltas.
2. Al construir los hijos por clase, si una clase del vocabulario es prefijo de otra se anota en
   el nodo y el reporte lo declara; con las 20 clases cosechadas no ocurre, pero el vocabulario
   crece durante el crawl.

---

## 6. El token `ca` dura más de lo que se temía

El riesgo R-3 asumía que `ca` podía caducar pronto y que el detalle debía leerse en la misma
sesión y de inmediato. **Medido, no es así:**

| Prueba | Resultado |
|---|---|
| Reusar un `ca` después de lanzar **otra búsqueda** con la misma sesión | `200`, detalle completo (`stillValid: true`) |
| Reusar un `ca` tras **600 s de inactividad** | `200`, detalle completo (`stillValid: true`) |

Consecuencia de diseño: el job `detail` **no necesita afinidad** con el worker que hizo la
búsqueda dentro de esa ventana, lo que hace real el escalado con `--scale`. Se mantiene de todos
modos la recuperación de R-18 (si el detalle devuelve 302, se re-ejecuta el `search` de su hoja
para refrescar el `ca`), porque el TTL superior sigue siendo desconocido y un run largo puede
excederlo.

**Lo que sí falla (hallazgo j):** de los 5 detalles muestreados, **uno devolvió 302 de forma
reproducible**, y no hacia `listView.seam` sino hacia
`errorUnexpected.seam?cid=98319`. Los otros cuatro cargaron con las 9 etiquetas esperadas. No
es caducidad de sesión —los `ca` vecinos, emitidos en la misma respuesta, funcionan—; parece un
proceso que el propio sistema no puede renderizar. **Queda como incógnita abierta**, y el
clasificador la trata como `CLIENT_ERROR` no reintentable en vez de `SESSION_LOST`: reintentarlo
seis veces y renovar la sesión no lo arreglaría, sólo gastaría peticiones contra el tribunal.
Se cuenta en el reporte para que la tasa sea visible.

---

## 7. La medición que redefine la estrategia: la mitad de los días desborda

18 días muestreados entre 2024 y 2026, uno por consulta:

| Filas | Días | |
|---|---|---|
| 0 | 2 | 15/11/2026, 18/11/2026 |
| 1–19 | 4 | 3, 4, 7, 12 filas |
| 20–29 | 3 | 20, 22, 24 filas |
| **30 (truncado)** | **9** | 02/09/2025, 09/02/2026, 03/05/2026, 10/10/2024, 24/08/2026, 11/06/2025, 25/04/2024, 05/09/2025, 12/02/2026 |

**El 50 % de los días muestreados viene truncado.** El recon había medido un solo día (24 filas)
y de ahí salió la idea de que "el día es una partición viable". Con 18 días la conclusión es
otra: **el día es la hoja primaria, pero la mitad de las veces no basta**, y el eje por clase
deja de ser un plan de contingencia para convertirse en el camino habitual.

Consecuencias directas:

1. El vocabulario de clases pasa a ser **crítico**, no accesorio: si está incompleto, la
   aritmética del RESIDUAL marcará GAP y el reporte perderá días. De ahí que se siembre con las
   20 clases medidas y se siga cosechando de cada fila vista.
2. El coste del crawl sube: cada día desbordado cuesta 1 + N consultas (N = clases conocidas)
   en vez de 1. Con 20 clases, un día desbordado cuesta ~21 peticiones.
3. La estimación de progreso y el ETA tienen que contar hojas secundarias, no sólo días.

---

## 8. Decisión: el eje secundario definitivo

> **El eje secundario es `classeJudicial`, con el cuerpo del formulario codificado en el charset
> de la página del formulario (ISO-8859-1), aritmética de cierre por coincidencia exacta de
> clase, y nodo RESIDUAL cuando la suma no explica lo visible.**
>
> **No hay tercer eje.** El filtro por número de proceso parcial no funciona (§1.d), así que un
> día en el que una sola clase supere el tope se declara `GAP` con su evidencia numérica. No se
> disimula: `reports/coverage.md` lo lista y `verify` sale con código 4.

Los ejes quedan, en orden de prioridad: `[DateAxis, ClasseAxis]`. `CnjYearAxis` **no se
implementa**; el spike cerró esa puerta con una medición, que es la única razón aceptable para
descartar un plan.

---

## 9. Números para dimensionar

| Métrica | Valor medido |
|---|---|
| Latencia del bootstrap | 1,4 s |
| Latencia de búsqueda | 0,9 – 3,0 s |
| Latencia de detalle | 1,6 – 2,4 s |
| Cookies emitidas | 4 (`JSESSIONID`, `ROUTER_ID`, `trf501ad1ee3`, `trf501f66e06`) |
| `searchActionId` observado hoy | `fPP:j_id244` (idéntico al recon; se sigue derivando por regex) |
| `ViewState` | `j_id1` |
| Captcha | `if (false)` — sigue desactivado |
| Tope | 30, leído del banner |
| Cuerpo de respuesta vacía | 4 846 B |
| Clases distintas conocidas | 20 |

---

## 10. Lo que este spike **no** midió

Honestidad sobre los límites, que es parte del entregable:

- **El 429 no se intentó provocar.** Provocarlo contra un tribunal sería abusivo y el tope de 40
  peticiones existe justamente para no acercarse. Todo el manejo de 429 se valida contra el
  servidor PJe falso (`test/fake-pje-server/`), con y sin `Retry-After`.
- **El TTL superior del `ca` sigue siendo desconocido.** Se midió que aguanta ≥ 10 minutos; no
  dónde se rompe. El diseño asume que puede romperse.
- **El tamaño total del dataset es desconocido.** 18 días muestreados no permiten extrapolar con
  honestidad a 36 años de raíz; el reporte del run real dará la cifra.
- **La causa del 302 a `errorUnexpected.seam`** (hallazgo j) no se investigó más allá de
  comprobar que es reproducible y no contagia a los `ca` vecinos.
