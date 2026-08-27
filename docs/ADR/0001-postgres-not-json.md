# ADR 0001 — Postgres como única fuente de verdad, sin archivos JSON

**Estado:** aceptado · **Fecha:** 2026-08-27

## Contexto

El enunciado pide "almacenamiento estructurado" y admite archivos. El dominio, en cambio, tiene
tres propiedades que un archivo no cubre: los procesos se **actualizan** (movimientos nuevos sobre
un expediente ya visto), el crawl es **reanudable** (una corrida de horas se interrumpe), y la
completitud es una **invariante geométrica** (las hojas del árbol de particiones deben teselar el
rango raíz sin huecos ni solapes).

## Decisión

Toda la verdad vive en Postgres: los datos canónicos, el árbol de particiones, la cola de trabajo,
la DLQ, el throttle compartido y las métricas. JSON y CSV existen únicamente como **salida**
(`npm run export`). No hay estado en archivos, ni siquiera un checkpoint.

## Alternativas consideradas

- **JSONL por corrida.** Simple de escribir, imposible de actualizar: cada re-crawl duplicaría
  expedientes y la deduplicación pasaría a ser trabajo del lector.
- **SQLite.** Resuelve el update, no el resto: sin `SKIP LOCKED` no hay varios workers, y sin
  `EXCLUDE USING gist` el solape de particiones vuelve a ser una buena intención del código.
- **Postgres para datos + Redis para la cola.** Dos almacenes que pueden discrepar, y una
  transacción que ya no abarca "guardar el caso y encolar sus PDFs".

## Consecuencias

- El solape de hojas primarias es imposible por restricción de la base
  (`EXCLUDE USING gist … WHERE status = 'LEAF_DONE'`), no por disciplina del programador.
- Un worker puede morir en cualquier punto: el trabajo vuelve por expiración del lease.
- Cuesta una dependencia de infraestructura. Se mitiga con PGlite (ADR 0004): el mismo DDL y las
  mismas consultas corren embebidas, sin Docker, y la suite de contrato se ejecuta contra ambos.
