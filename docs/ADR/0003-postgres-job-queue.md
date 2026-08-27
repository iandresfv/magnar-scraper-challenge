# ADR 0003 — La cola de trabajo es una tabla, no un broker

**Estado:** aceptado · **Fecha:** 2026-08-27

## Contexto

El crawl produce trabajo de tres tipos (buscar, detallar, descargar) con dependencias entre sí, y
debe repartirse entre varios procesos sin duplicar ni perder nada. Cada unidad de trabajo tiene
estado (intentos, clase de fallo, cuándo reintentar) que es exactamente lo que hay que auditar
cuando algo sale mal.

## Decisión

`juris.job` es una tabla. Los workers toman trabajo con
`SELECT … FOR UPDATE SKIP LOCKED` bajo un **lease** con vencimiento; agotados los intentos, el job
queda `status='dead'` — esa es la DLQ, consultable con SQL y reprocesable con `npm run retry-dlq`.

## Alternativas consideradas

- **Redis / BullMQ.** Rápido y conocido, pero mete un segundo almacén: el job y el dato que
  produce dejarían de poder confirmarse en la misma transacción, y aparece la ventana en la que un
  expediente se guardó y sus PDFs no se encolaron nunca.
- **RabbitMQ / SQS.** Mismo problema, más operación, y el ack no cubre "reintentar dentro de 40
  segundos con jitter" sin una cola de delay aparte.
- **Concurrencia en memoria dentro de un proceso.** No sobrevive a un reinicio ni escala a más de
  una máquina, que es justo lo que hay que demostrar.

## Consecuencias

- Un handler escribe el caso y encola sus documentos en **una** transacción.
- `--scale worker=3` funciona sin coordinación adicional: lo demuestra `npm run scale`.
- El lease es la única defensa contra un worker muerto; su duración (`LEASE_MS`) es un parámetro
  visible, no una constante escondida.
- La cola compite por conexiones con las consultas de datos. Es aceptable a esta escala y el
  `pool` está dimensionado para ello.
