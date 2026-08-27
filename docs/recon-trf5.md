# Recon técnico — PJe Consulta Pública TRF5 (`pjett.trf5.jus.br`)

> **Estado:** verificado empíricamente vía HTTP puro el 2026-08-26. Cada afirmación de este
> documento fue probada con requests reales, no inferida. Los bloques marcados
> `⚠️ NO VERIFICADO` son los únicos supuestos abiertos.
>
> **Cómo leer este documento.** Es el reconocimiento del sitio que precedió al código: la fuente
> de verdad sobre URLs, formulario, selectores, cookies y endpoints. Se publica tal cual se
> escribió, con una única corrección posterior —la de encoding, §9— señalada en su sitio y
> repetida al pie. Lo que el spike de la Fase 0 midió después está en
> [`spike-fase0.md`](spike-fase0.md); si ambos discrepan, manda el spike, que es más reciente.

---

## 1. Identificación del stack

| Aspecto | Valor |
|---|---|
| Servidor de aplicación | JBoss + **JBoss Seam** (`.seam`, `cid` de conversación) |
| Capa de vista | **JSF 1.2 + RichFaces 3.3.3.Final + Ajax4JSF (A4J)** |
| Encoding | **Mixto** — A4J responde UTF-8; páginas completas declaran ISO-8859-1 pero sólo usan ASCII + entidades HTML. Ver §9 |
| Balanceador | F5 BIG-IP (cookies `trf501*`) + sticky `ROUTER_ID` |
| Entorno | `pjett` = ambiente de **treinamento/homologação** del TRF5 |

### Cookies emitidas en el primer GET
```
JSESSIONID=<id>.tt-consulta-229-ls7wx   ; path=/pjeconsulta   <- sufijo = nodo del cluster
ROUTER_ID=<hash>                        ; path=/ ; Secure; SameSite=None
trf501ad1ee3=<hex>                      ; path=/              <- F5
trf501f66e06=<hex>                      ; path=/pjeconsulta   <- F5
```
**Implicancia:** afinidad de nodo obligatoria. Un cookie jar por worker, persistido durante toda
la vida del worker. Perder la cookie ⇒ 302 a `listView.seam` y pérdida de la conversación Seam.

---

## 2. 🔓 Hallazgo #1 — el reCAPTCHA está DESACTIVADO

La página carga `https://www.google.com/recaptcha/api.js`, pero el hook de submit es:

```js
function executarReCaptcha() {
    if (false) {                 // <- flag renderizada server-side en false
        grecaptcha.execute();
        return false;
    }
    executarPesquisa();          // camino real: submit A4J directo
}
```

**No hay que resolver ningún captcha.** El desafío es resoluble 100 % con `axios` + `cheerio`,
tal como exige el enunciado.

> Es una condición del entorno de *treinamento*. Sanity check obligatorio en el scraper: si
> `if (false)` cambia a `if (true)`, abortar con un error explícito en vez de fallar en silencio.

---

## 3. 🔑 Hallazgo #2 — tope duro de 30 resultados, sin paginación

Éste es **el** problema real del desafío, y no es evidente desde el navegador.

La tabla de resultados no tiene `rich-datascroller`. El `<div class="pull-left" title="Paginação">`
está **siempre vacío**. Cuando la consulta excede el tope, el servidor devuelve:

```html
<div class="alert alert-danger">
  Sua consulta retornou muitos processos e somente os 30 primeiros serão exibidos.
  Por favor, refine sua pesquisa.
</div>
```

### Mediciones reales (filtro `dataAutuação` inicio/fin)

| Rango | Filas | Truncado |
|---|---|---|
| 2010-01-01 → 2019-12-31 | 30 | ✅ sí |
| 2020-01-01 → 2023-12-31 | 30 | ✅ sí |
| 2024-01-01 → 2024-06-30 | 30 | ✅ sí |
| 2024-07-01 → 2024-12-31 | 30 | ✅ sí |
| 2025-01-01 → 2025-12-31 | 30 | ✅ sí |
| 2026-01-01 → 2026-12-31 | 30 | ✅ sí |
| **2024-05-15 → 2024-05-15** | **24** | **❌ no** |

**Conclusión:** "navegar por todo el sitio" ≠ paginar. Se resuelve **particionando el espacio de
búsqueda** por `dataAutuação` y **bisectando recursivamente** cualquier partición que vuelva
truncada, hasta que todas devuelvan < 30. El día es una partición viable (24 < 30 en la muestra),
pero **no se puede asumir que todo día cabe**: hace falta un eje secundario de desempate
(ver §8).

Los resultados vienen ordenados por número de proceso ascendente; el tope corta la cola, no
una ventana móvil. Sin partición, es imposible alcanzar completitud.

---

## 4. Flujo de búsqueda (POST A4J)

### 4.1 Bootstrap
```
GET https://pjett.trf5.jus.br/pjeconsulta/ConsultaPublica/listView.seam
```

Del HTML hay que extraer **dinámicamente**:

| Dato | Regex / selector | Valor observado |
|---|---|---|
| `action` del form | `<form id="fPP" ... action="([^"]+)"` | `/pjeconsulta/ConsultaPublica/listView.seam;jsessionid=<id>` |
| **ID de la acción de búsqueda** | `executarPesquisa=function\(\)\{A4J\.AJAX\.Submit\('fPP',null,\{.*?'parameters':\{'(fPP:j_id\d+)'` | `fPP:j_id244` |
| ViewState | `name="javax.faces.ViewState" ... value="([^"]*)"` | `j_id1` |

> ⚠️ **Trampa crítica.** El botón visible es `fPP:searchProcessos`, pero postear con ese
> parámetro **NO ejecuta la búsqueda**: sólo re-renderiza el panel de mensajes vacío
> (`Ajax-Update-Ids: fPP:j_id248`, respuesta de ~2.8 KB). Verificado.
> La acción real es la del `<script id="fPP:j_id244">` que define `executarPesquisa`.
> El `j_idNNN` es **autogenerado por JSF y puede cambiar** entre despliegues ⇒ **jamás
> hardcodearlo**; siempre derivarlo del regex de arriba.

### 4.2 El POST
```
POST https://pjett.trf5.jus.br{action}
Content-Type: application/x-www-form-urlencoded
X-Requested-With: XMLHttpRequest
Referer:  https://pjett.trf5.jus.br/pjeconsulta/ConsultaPublica/listView.seam
Cookie:   <jar completo>
```

Body (urlencoded; los campos usados son ASCII puro):

```
AJAXREQUEST=_viewRoot
fPP=fPP
fPP:numProcesso-inputNumeroProcessoDecoration:numProcesso-inputNumeroProcesso=
mascaraProcessoReferenciaRadio=on
fPP:j_id162:processoReferenciaInput=
fPP:dnp:nomeParte=
fPP:j_id180:nomeAdv=
fPP:j_id189:classeJudicial=
tipoMascaraDocumento=on
fPP:dpDec:documentoParte=
fPP:Decoration:numeroOAB=
fPP:Decoration:estadoComboOAB=org.jboss.seam.ui.NoSelectionConverter.noSelectionValue
fPP:Decoration:j_id223=
fPP:dataAutuacaoDecoration:dataAutuacaoInicioInputDate=01/01/2024      <- dd/MM/yyyy
fPP:dataAutuacaoDecoration:dataAutuacaoInicioInputCurrentDate=08/2026  <- MM/yyyy
fPP:dataAutuacaoDecoration:dataAutuacaoFimInputDate=31/12/2024
fPP:dataAutuacaoDecoration:dataAutuacaoFimInputCurrentDate=08/2026
autoScroll=
javax.faces.ViewState=j_id1
fPP:j_id244=fPP:j_id244            <- ID dinámico, ver arriba
AJAX:EVENTS_COUNT=1
```

**Campos de filtro disponibles:** nº de proceso, proceso de referencia, nombre de parte, nombre de
abogado, clase judicial (autocomplete), CPF/CNPJ de parte, nº OAB + estado, y rango de
`dataAutuação`. Sólo el rango de fechas resultó útil como eje de partición
(`nomeParte=MARIA` devolvió 0 resultados — el matching no es substring libre).

### 4.3 La respuesta
Documento XHTML parcial de A4J. El `<body>` trae el fragmento re-renderizado
`fPP:processosGridPanel` completo. Parsear con cheerio directamente sobre el body.

Marcadores útiles: `<meta name="Ajax-Update-Ids" content="fPP:j_id248">`,
`<meta id="Ajax-Response" name="Ajax-Response" content="true">`.

---

## 5. 🔑 Hallazgo #3 — el `idProcessoTrf` viene gratis en el DOM

Estructura de fila:

```html
<tr class="rich-table-row rich-table-firstrow">
  <td class="rich-table-cell" id="fPP:processosTable:16730:j_id255">
      <a onclick="openPopUp('Consulta pública',
         '/pjeconsulta/ConsultaPublica/DetalheProcessoConsultaPublica/listView.seam?ca=b22ef4ac…')">
  </td>
  <td class="rich-table-cell" id="fPP:processosTable:16730:j_id257">
      APELAÇÃO CÍVEL
      <a onclick="openPopUp(…mismo ca…)">
        <b class="btn-block">ApCiv 0000007-07.1985.8.20.0124 - Multas e demais Sanções</b>
      </a>
      EMPRESA NOSSA SENHORA APARECIDA LTDA e outros (3) X FAZENDA NACIONAL
  </td>
  <td class="rich-table-cell" id="fPP:processosTable:16730:j_id263">
      Conclusos para decisão (20/06/2026 11:18:14)
  </td>
</tr>
```

**El segmento numérico del `id` (`16730`) es el `idProcessoTrf`** — la PK interna del proceso.
Verificado: coincide exactamente con el `idProcessoTrf=16730` que exige el endpoint de PDF (§7).

Consecuencias:
1. **Clave de deduplicación natural** entre particiones solapadas (`16730`), estable y numérica.
2. Permite construir la URL del PDF del proceso **sin siquiera abrir el detalle** ⇒ el pipeline de
   PDFs se puede desacoplar del de detalles.

Campos derivables del listado: `idProcessoTrf`, `ca` token, clase judicial, sigla+número CNJ,
asunto, partes (resumen "A X B"), última movimentación + timestamp.

**Regex del número CNJ:** `\d{7}-\d{2}\.\d{4}\.\d\.\d{2}\.\d{4}`

---

## 6. Página de detalle

```
GET /pjeconsulta/ConsultaPublica/DetalheProcessoConsultaPublica/listView.seam?ca=<token>
```

GET simple, **misma cookie jar**. Sin cookies ⇒ **302** a `listView.seam`. Verificado.
`ca` es un token opaco (hex, 32–48 bytes) emitido por el listado.

> ⚠️ NO VERIFICADO: si `ca` expira, y con qué TTL. Diseñar asumiendo que **puede caducar** ⇒
> ante un 302 al listado, re-ejecutar la búsqueda de la partición y refrescar el `ca`.

### Campos extraíbles (verificados sobre `idProcessoTrf=16730`)

```
Número Processo            0000007-07.1985.8.20.0124
Data da Distribuição       15/05/2024
Classe Judicial            APELAÇÃO CÍVEL (198)
Assunto                    DIREITO TRIBUTÁRIO (14) - Crédito Tributário (5986) - … (jerarquía, N líneas)
Jurisdição                 TRF5
Órgão Julgador Colegiado   Pleno
Endereço                   Tribunal Regional Federal - 5ª Região, Cais do Apolo, s/n, Recife…
Órgão Julgador             Gab VICE-PRESIDÊNCIA
Processo referência        0000007-07.1985.8.20.0124
```

**Polo ativo / Polo passivo** — tabla por participante:
`NOMBRE - CNPJ: 08.409.021/0001-77 (APELANTE)` / `NOMBRE - OAB RN1966 - CPF: 474.225.484-87 (ADVOGADO)`
+ columna `Situação` (`Ativo`). Pie: `N resultados encontrados`.

**Movimentações do Processo** — lista `dd/MM/yyyy HH:mm:ss - <descripción>`, ~13+ por proceso.

**Documentos juntados ao processo** — tabla `#j_id146\:processoDocumentoGridTab`, pie
`N resultados encontrados`. En la muestra: 2 documentos (`Acórdão`).

> ⚠️ Los datos personales (CPF/CNPJ de partes) son públicos por la Res. 121/CNJ, pero el propio
> sitio advierte que procesos bajo *segredo de justiça* no se retornan. Vale la pena preverlo en el
> README y, si aplica, ofrecer una flag de anonimización.

---

## 7. 🔑 Hallazgo #4 — los tres endpoints de documentos

Extraídos de los `onclick="openPopUp(...)"` de la tabla de documentos:

| # | Endpoint | Método | Resultado verificado |
|---|---|---|---|
| 1 | `/pjeconsulta/ConsultaPublica/DetalheProcessoConsultaPublica/reportPDF.seam?idProcessoTrf=<id>` | GET | **`application/pdf`, 23 340 B, `%PDF-1.4`** — capa/relatório del proceso |
| 2 | `/pjeconsulta/Processo/reportReciboPDF.seam?idBin=<n>&idProcessoDoc=<n>&idProcessoTrf=<n>` | GET | **`application/pdf`, 18 311 B, `%PDF-1.4`** — comprobante por documento |
| 3 | `/pjeconsulta/ConsultaPublica/DetalheProcessoConsultaPublica/documentoSemLoginHTML.seam?ca=<tok>&idProcessoDoc=<n>` | GET | `text/html` — visor HTML del documento |

### Mecánica de la descarga (verificada)
```
GET reportPDF.seam?idProcessoTrf=16730
  -> 302
  -> GET /pjeconsulta/seam/docstore/document.seam?docId=1&cid=146297   <- cid = conversación Seam
  -> 200  Content-Type: application/pdf
          Content-Disposition: inline; filename="reportPDF.pdf"
```

- **Hay que seguir el redirect con la misma cookie jar.** Sin cookies: 302 y cuerpo vacío (0 B).
- El `Content-Disposition` trae siempre el nombre genérico (`reportPDF.pdf` / `reportReciboPDF.pdf`)
  ⇒ **el nombre descriptivo lo construye el scraper**, no el servidor.
- `docId=1` es constante; `cid` cambia por request (es la conversación Seam, no un ID de archivo).
- **Validar siempre el magic number `%PDF`** antes de escribir a disco: un 302 a HTML también
  devuelve 200 con `text/html` y produciría un "PDF" corrupto de 44 KB.

### Pares `idBin` / `idProcessoDoc` en el proceso de muestra
```
(idBin=7127696, idProcessoDoc=7222997, idProcessoTrf=16730)  -> Acórdão 11/05/2026 00:36:17
(idBin=3453502, idProcessoDoc=3469065, idProcessoTrf=16730)  -> Acórdão 27/10/2025 18:17:59
```

`documentoSemLoginHTML.seam` devolvió **302 → `listView.seam`** en acceso directo con cookies
(la conversación Seam necesita estar viva). Los dos endpoints de PDF **sí** funcionan directo.
⇒ Priorizar #1 y #2; #3 es opcional.

---

## 8. Rate limiting — lo que se midió y lo que no

| Prueba | Resultado |
|---|---|
| 15 GETs **secuenciales** a `reportPDF.seam` | 15 × `200 application/pdf`. **0 × 429.** Latencia ~2.3–2.6 s/req |
| 20 GETs **concurrentes** al mismo endpoint | 20 × `200 application/pdf`. **0 × 429.** |
| Latencia del POST de búsqueda | 2.4 – 4.7 s |

> ⚠️ **NO VERIFICADO: no se logró reproducir el 429** en el recon (deliberadamente acotado para
> no abusar de un servidor público). El enunciado del desafío lo declara explícitamente, así que
> es real — probablemente por volumen sostenido, por ventana temporal más larga, o disparado
> por el F5 aguas arriba.
>
> **Esto no relaja el requisito: el manejo de 429 es criterio de evaluación explícito y hay que
> implementarlo completo.** Sí implica que **la validación del backoff no puede depender de
> gatillarlo contra producción** ⇒ hace falta probarlo con un servidor mock / inyección de fallos.
> Ese es justamente el detalle que separa una entrega buena de una excelente.

Nota adicional: `Retry-After` no pudo observarse. El diseño debe **respetarlo si viene** y caer a
backoff exponencial + jitter si no.

---

## 9. Trampas de encoding (fuente #1 de datos sucios)

> **CORRECCIÓN (2026-08-27).** La primera versión de este documento afirmaba "ISO-8859-1 en ambos
> sentidos". **Era incorrecto**: el mojibake observado (`APELAÃÃO`) lo produjo el propio recon al
> decodificar bytes UTF-8 como latin1. Verificado contra bytes crudos:

| Respuesta | Header `Content-Type` | Bytes reales del cuerpo |
|---|---|---|
| GET `listView.seam` (página de búsqueda) | `text/html;charset=ISO-8859-1` | Sólo ASCII + **entidades HTML** (`&uacute;`, `&ccedil;`) ⇒ el charset es irrelevante |
| **POST A4J (resultados de búsqueda)** | **`text/xml;charset=UTF-8`** | **UTF-8 real** (`ser\xc3\xa3o`, `APELA\xc3\x87\xc3\x83O`) |
| GET detalle | `text/html;charset=ISO-8859-1` | Sólo ASCII + entidades HTML ⇒ irrelevante |

**Regla correcta:** decodificar **por detección** (charset del header → declaración `<?xml>`/`<meta>`
→ UTF-8 estricto → fallback latin1), nunca hardcodear ninguno de los dos. El `<meta charset=UTF-8>`
del HTML contradice al header `ISO-8859-1` de la misma respuesta: el servidor está mal configurado y
sólo se salva porque las páginas completas no llevan bytes no-ASCII.

1. Con `fetch`/`axios` pedir bytes crudos (`arrayBuffer`) y decodificar con `TextDecoder(charsetDetectado)`.
2. El body del POST: los campos de fecha son ASCII puro; si se envía `classeJudicial` con acentos,
   usar el charset detectado de la respuesta previa.
3. El HTML trae entidades (`&Uacute;`, `&ccedil;`, `&amp;`) ⇒ des-escapar después de parsear.
4. Los `onclick` traen JS-escapes: `\x2D` = `-`. Al extraer URLs de `onclick` hay que des-escaparlos.

**Sanity check barato:** ninguna cadena extraída debe contener `Ã` ni `Â` seguidos de un carácter
no-espacio. Si aparece, se decodificó con la tabla equivocada.

> **Nota al pie sobre esta sección (corrección R-1).** La primera versión de este recon afirmaba
> "ISO-8859-1 en ambos sentidos" y esa afirmación llegó a condicionar el diseño. Es falsa, y la
> evidencia es aritmética: `çã` aparece en el fixture `02` como los bytes `C3 83 C2 A3`, que son
> exactamente los bytes UTF-8 de `ã` (`C3 A3`) vueltos a codificar tras leerlos como latin1; y el
> mojibake `APELAÃÃO` que citaba el recon original es lo que produce leer UTF-8 **como** latin1
> (`C3 87 C3 83` → `Ã\x87Ã\x83`), nunca lo contrario. **El recon había invertido la dirección.**
>
> La consecuencia para el código no es "usar UTF-8": es **no hardcodear ninguno de los dos**. El
> cliente HTTP decodifica por detección (charset del header → declaración `<?xml>`/`<meta>` → UTF-8
> estricto → fallback latin1) y el canario C-6 rechaza cualquier cadena con secuencias de mojibake,
> de modo que el diseño es correcto sea cual sea la realidad del servidor y lo siga siendo si el
> servidor cambia. Ver `src/infra/http/encoding.ts` y `scripts/fix-fixture-encoding.ts`.

---

## 10. Números de referencia para dimensionar

| Métrica | Valor observado |
|---|---|
| Latencia búsqueda | 2.4 – 4.7 s |
| Latencia detalle | ~2 s |
| Latencia PDF | ~2.4 s |
| Tope por consulta | 30 filas |
| Documentos por proceso (muestra) | 2 |
| Tamaño PDF | 18–23 KB |
| Concurrencia tolerada sin error | ≥ 20 (medido) |

---

## 11. Resumen ejecutivo del recon

1. **No hay captcha** — `if (false)`.
2. **No hay paginación** — tope duro de 30. La completitud exige **partición por fecha con
   bisección recursiva**; es el núcleo intelectual del desafío.
3. **El `idProcessoTrf` está en el `id` del `<td>`** — dedup key gratis + URL de PDF sin abrir el detalle.
4. **La acción de búsqueda es un `j_idNNN` dinámico**, no el botón visible. Hardcodearlo = bomba de tiempo.
5. **Dos endpoints de PDF confirmados**, ambos vía 302 → `docstore` con cookies.
6. **Encoding mixto**: la respuesta A4J es UTF-8, las páginas completas declaran ISO-8859-1 pero sólo traen ASCII+entidades. Decodificar por detección (ver §9, corregido).
7. **El 429 no se reprodujo**; hay que implementarlo igual y validarlo con mocks.
