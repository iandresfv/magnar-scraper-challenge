# ADR 0004 — Núcleo hexagonal y un `SiteAdapter` por tribunal

**Estado:** aceptado · **Fecha:** 2026-08-27

## Contexto

El enunciado pide un motor **multi-sitio**: hoy el TRF5, mañana otro tribunal de otro país, con
otro formulario, otro tope por consulta y otro formato de número de expediente. Lo que no cambia
entre sitios es el algoritmo: particionar el rango, detectar truncamiento, dividir, reintentar,
verificar.

## Decisión

`core/` (dominio, puertos, motor, casos de uso) no importa nunca `sites/`, `infra/` ni `app/`. Un
tribunal se implementa como `SiteAdapter` + sus `Axis` (ejes de partición) + sus canarios, y se
registra en el `SiteRegistry`. La regla la vigilan ESLint **y** un test que recorre el grafo de
imports transitivo, porque una regla de capas sin test es una convención.

## Alternativas consideradas

- **Un solo módulo con `if (site === …)`.** Más corto hasta el segundo sitio; después, cada cambio
  del TRF5 puede romper Perú.
- **Herencia (`class Trf5 extends BaseSite`).** La variabilidad real está en piezas
  intercambiables (ejes, clasificador de fallos, canarios), no en una jerarquía; con herencia se
  acaba sobrescribiendo métodos para desactivar lo que la base asumió.
- **Plugins cargados dinámicamente.** Complejidad de carga y tipos a cambio de nada: los sitios
  viven en este repositorio y se compilan con él.

## Consecuencias

- Hay dos adaptadores vivos (`br-trf5` y `fake-pje`) y **una** suite de contrato que ambos pasan;
  el segundo es además el servidor que la suite e2e maltrata a voluntad.
- Los tests del motor no tocan la red, y los del sitio no tocan la base.
- Añadir un tribunal es un directorio nuevo y una línea en el registro:
  ver [`../adding-a-site.md`](../adding-a-site.md).
- Cuesta indirección: leer un flujo completo obliga a saltar entre puerto y adaptador. Es el
  precio de que el motor no sepa qué es un `classeJudicial`.
