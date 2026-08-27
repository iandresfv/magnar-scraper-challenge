# ADR 0002 — Los PDF van al API S3, servido localmente por RustFS

**Estado:** aceptado · **Fecha:** 2026-08-27

## Contexto

Los documentos (relatórios y recibos) son binarios de tamaño medio. Guardarlos en la base los
convierte en `bytea` que nadie quiere leer y que infla cada backup; guardarlos sueltos en disco
ata el despliegue a una máquina concreta. El enunciado valora "object storage" y el evaluador debe
poder levantarlo sin cuenta en ningún proveedor.

## Decisión

El puerto es el **API S3** (`@aws-sdk/client-s3`), y el servicio local por defecto es **RustFS**
(Apache 2.0), fijado a un tag exacto en `docker-compose.yml`. La misma configuración apunta a AWS
S3, a GCS por interoperabilidad HMAC o a Garage cambiando `S3_ENDPOINT`.

## Alternativas consideradas

- **MinIO.** Era la elección obvia hasta que la edición community quedó archivada; fijar una
  imagen sin mantenimiento en un proyecto que se entrega como referencia no es defendible.
- **LocalStack.** Exige token de cuenta incluso en su nivel gratuito: un evaluador sin cuenta se
  queda sin poder ejecutar el proyecto.
- **Sólo disco.** Es el fallback (`BLOB_DRIVER=fs`), no el camino principal: no da URI estable ni
  se comparte entre procesos.

## Consecuencias

- Un `BlobStore` con dos implementaciones y **una** suite de contrato que corre contra las dos.
- La clave del objeto es determinista —`{site}/{año}/{numero}/{numero}__{tipo}[__{docId}].pdf`—,
  así que reintentar una descarga sobrescribe en vez de duplicar.
- Cada PDF se valida antes de subirse (cabecera `%PDF-`, `%%EOF`, tamaño mínimo): un HTML de
  sesión caída no se almacena como si fuera un documento.
