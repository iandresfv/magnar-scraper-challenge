# Arquitectura

Una página. Los porqués están en los [ADR](ADR/); el recorrido guiado del código, en
[`GUIDE.md`](GUIDE.md).

## El problema, en una frase

El sitio **no pagina** y **corta en un tope** por consulta (30 filas en el TRF5), sin decir cuántas
dejó fuera. Por lo tanto la completitud no se observa: **se construye**, particionando el espacio
de búsqueda hasta que ninguna hoja toque el tope, y se demuestra con una invariante.

## Capas

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ app/            main.ts (composition root) · commands/ · config · registry   │
│                 crawl · verify · report · export · dlq:list · healthcheck    │
├─────────────────────────────────────────────────────────────────────────────┤
│ sites/          br-trf5/ (adapter, axes, parsers, canaries)                  │
│                 fake-pje/ (el mismo contrato, servido por los tests)         │
├─────────────────────────────────────────────────────────────────────────────┤
│ core/           domain/    tipos, fechas, CNJ, CPF/CNPJ, hash, mojibake      │
│   (sin IO)      ports/     SqlExecutor · HttpPort · SiteAdapter · Repos      │
│                            JobQueue · Throttle · BlobStore · Clock · Metrics │
│                 engine/    partitionTree · coverageEngine · pipeline         │
│                            backoff · failureClassifier · retryPolicy         │
│                 usecases/  verifyRun (11 comprobaciones de sanidad)          │
├─────────────────────────────────────────────────────────────────────────────┤
│ infra/          db/ (pg · pglite · migrator · repos · queue · throttle)      │
│                 http/ (fetch · encoding · cookies · throttled)               │
│                 blob/ (s3 · fs · validación de PDF) · metrics/ · log/        │
└─────────────────────────────────────────────────────────────────────────────┘

Las flechas de importación apuntan siempre hacia el centro: `core/` no importa a nadie.
Lo verifica `test/arch/imports.test.ts` sobre el grafo transitivo, no sólo sobre la primera línea.
```

## El algoritmo de cobertura

1. Se parte de una **partición raíz** (un rango de fechas de autuação).
2. Se consulta. Si la respuesta viene truncada — banner del sitio, o exactamente `cap` filas — la
   partición se **divide**: primero por fecha (mitades; un día no se puede partir más), y si un
   solo día sigue topando, por un **eje secundario** (`classeJudicial`, tomado del vocabulario que
   el propio sitio publica).
3. Si ningún eje puede dividir más y la respuesta sigue truncada, la partición se marca **GAP**:
   se declara con su aritmética en `reports/coverage.md` en vez de disimularse.
4. Al terminar, `assertTiling` exige que las hojas resueltas cubran el rango raíz **exactamente**:
   sin huecos y sin solapes. Lo mismo lo impide la base con `EXCLUDE USING gist`.

## Concurrencia y cortesía

Los workers son idénticos y sin estado: toman jobs con `FOR UPDATE SKIP LOCKED` bajo lease. La
cortesía **no** es por proceso: `juris.site_throttle` es una fila por sitio con la concurrencia
efectiva, el bucket de tokens y el circuit breaker, y todo request pasa por ella
(`ThrottledHttpClient`). Por eso `--scale worker=3` triplica el paralelismo local sin triplicar la
presión sobre el tribunal. La ley de control es AIMD: sube de a uno tras éxitos sostenidos, baja a
la mitad ante un 429.

## Fallos

Cada fallo se **clasifica** (`RATE_LIMITED`, `SERVER_ERROR`, `NETWORK`, `TIMEOUT`, `PARSE`,
`SESSION_LOST`, `NOT_PDF`, `FATAL_SITE_CHANGED`…). La clase decide la política: cuántos intentos,
con qué backoff (jitter decorrelado, `Retry-After` respetado) y si vale la pena reintentar. Los
handlers no duermen ni cuentan intentos: dicen _qué tipo de cosa falló_.

Diez **canarios** vigilan supuestos del sitio (el tope, el `actionId` del formulario, el encoding,
la página de rechazo del balanceador…). Si uno se rompe, la corrida se detiene: seguir produciría
datos que parecen bien y no lo están.

## Qué se puede intercambiar sin tocar el motor

| Puerto                          | Implementaciones                           | Suite de contrato            |
| ------------------------------- | ------------------------------------------ | ---------------------------- |
| `SqlExecutor`                   | Postgres (`pg`), PGlite (WASM, sin Docker) | sí, la misma contra las dos  |
| `BlobStore`                     | S3 (RustFS/AWS/GCS/Garage), disco          | sí                           |
| `SiteAdapter`                   | `br-trf5`, `fake-pje`                      | sí, la misma contra los dos  |
| `JobQueue`, `Throttle`, `Repos` | Postgres                                   | sí (corren en ambos drivers) |

## Códigos de salida

`0` completó · `1` quedan jobs en la DLQ · `2` el breaker abandonó el sitio · `3` un canario se
rompió · `4` falló una comprobación de sanidad · `130` interrumpido (reanudable).
