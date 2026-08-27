# Fixtures — PJe Consulta Pública, TRF5

Respuestas **reales** del servidor `pjett.trf5.jus.br`, capturadas por HTTP puro el **2026-08-26**
durante el reconocimiento del sitio ([`docs/recon-trf5.md`](../../../../docs/recon-trf5.md)). Son
la base de todos los tests de los parsers: el adaptador `br-trf5` se prueba entero sin tocar la red.

| Archivo | Qué es | Origen |
|---|---|---|
| `01-listview-form.html` | Página de búsqueda completa | `GET /pjeconsulta/ConsultaPublica/listView.seam` |
| `02-search-response-30-truncado.html` | Respuesta parcial A4J de una búsqueda **truncada** (30 filas + banner) | `POST` A4J con `dataAutuação` 01/01/2024–31/12/2024 |
| `03-detalhe-processo-16730.html` | Detalle de un proceso | `GET …/DetalheProcessoConsultaPublica/listView.seam?ca=…` |
| `04-reportPDF-16730.pdf` | Carátula/relatório del proceso 16730 | `GET …/reportPDF.seam?idProcessoTrf=16730` → 302 → docstore |
| `05-reportReciboPDF-7222997.pdf` | Comprobante de un documento | `GET …/reportReciboPDF.seam?idBin=7127696&idProcessoDoc=7222997&idProcessoTrf=16730` |

Los dos PDF se versionan a propósito (40 KB entre ambos, marcados `binary` en `.gitattributes`):
son la única forma de probar la validación de `%PDF-`/`%%EOF` contra bytes que el servidor emitió
de verdad, y no contra un PDF que nos inventemos nosotros.

## La reparación del fixture 02

`02-search-response-30-truncado.html` llegó **doblemente codificado**. La herramienta de captura
decodificó como latin1 los bytes UTF-8 del servidor y guardó el resultado como UTF-8; el
round-trip no pierde información, pero re-codifica cada byte como un code point:

```
servidor:   73 65 72 C3 A3 6F              -> "serão"
en disco:   73 65 72 C3 83 C2 A3 6F        -> "serÃ£o"
```

`scripts/fix-fixture-encoding.ts` aplica la inversa exacta (`Buffer.from(texto, 'latin1')`) una
sola vez; el archivo de este directorio **ya está reparado** y el script es idempotente, así que
volver a ejecutarlo no hace nada. La verificación vive en
[`test/unit/fixtures.encoding.test.ts`](../../../../test/unit/fixtures.encoding.test.ts).

Un detalle que conviene decir en voz alta: **el criterio correcto no es "cero caracteres `Ã`"**.
`Ã` es una letra legítima del portugués y aparece 28 veces en este fixture, dentro de `APELAÇÃO`.
Lo que no puede aparecer es la *firma* del mojibake — `Â` o `Ã` seguidos de un byte del rango de
continuación UTF-8 (`0x80`–`0xBF`) — porque esa secuencia no la produce ningún texto real. Ese es
el criterio que comprueban el test y el canario C-6.

## Advertencia

Contienen datos personales públicos (CPF/CNPJ de partes, nombres de abogados) publicados por el
propio tribunal bajo la Resolución 121 del CNJ. Se conservan sin alterar porque los parsers deben
probarse contra la forma real del documento; las **muestras** que genera el proyecto
(`reports/sample.md`) se producen con `--anonymize`.
