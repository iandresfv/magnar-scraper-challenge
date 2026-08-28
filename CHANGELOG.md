# Changelog

Generado del historial (`git log --oneline`), agrupado por dominio. El historial es parte del
entregable: cada commit deja la suite en verde y toca un solo dominio, así que `git bisect` entre
dos de ellos acota cualquier regresión a un módulo.

## v1.0.0 — 2026-08-27

Primera versión completa: motor multi-sitio, un tribunal real implementado (TRF5), un tribunal
falso que pasa el mismo contrato, 837 tests y un run de evidencia publicado en [`reports/`](reports/).

### Motor de cobertura

- `feat(engine): add partition tree and tiling assertion` — el invariante que sostiene la
  completitud: las hojas resueltas teselan el rango raíz, sin huecos ni solapes.
- `feat(engine): add coverage engine` — dividir por fecha, luego por clase judicial; declarar
  `GAP` cuando ningún eje puede más.
- `feat(engine): add pipeline with search and detail handlers`.
- `feat(engine): add failure classifier and retry policy` — la clase de fallo decide la política.
- `feat(engine): add blob handler with download budget`.

### Sitios

- `feat(trf5): add list view parser and canaries`, `add search form builder and response parser`,
  `add detail parser`, `add site adapter and partition axes`.
- `feat(fake-pje): add site adapter for the fake server` — el doble de test es un sitio
  registrado que pasa la misma suite de contrato, no un mock.
- `test(core): add site adapter contract suite`.

### Persistencia y cola

- `feat(db): add sql executor for pg and pglite` — dos drivers, una suite de contrato.
- `feat(db): add core schema migration and runner`, `add repositories with contract tests`.
- `feat(db): add job queue with skip locked leases` — la cola es una tabla; la DLQ también.
- `feat(db): add shared site throttle with aimd and breaker` — la cortesía es del sitio, no del
  proceso.

### Transporte y almacenamiento

- `feat(http): add fetch client with cookie jar and charset detection`.
- `feat(blob): add fs blob store and pdf validation`, `add s3 blob store`.

### CLI y observabilidad

- `feat(cli): add crawl command with planner and worker roles`, `add retry-dlq and dlq:list
commands`, `add verify command with sanity checks`, `add report command`, `add export command
for jsonl and csv`, `add progress output and exit codes`.
- `feat(metrics): add metrics registry and prometheus endpoint`.

### Infraestructura y documentación

- `chore(docker): add compose with postgres and rustfs`, `pin image tags and finalize env
examples`; `build(docker): add multi-stage dockerfile and app profile`.
- `ci(github): add workflow with postgres and rustfs services`.
- `docs(recon)`, `docs(spike)`, `docs(adr)`, `docs(readme)`, `docs(site)`, `docs(guide)`,
  `docs(reports)`.

### Correcciones de la propia implementación

Dieciocho, todas nacidas de un fallo observado y con test de regresión. Las que más enseñan:

- `fix(http): decode latin1 by definition, not by encoding label` — `TextDecoder('iso-8859-1')`
  es un alias de windows-1252, y el resultado difería entre macOS y CI.
- `fix(http): route every request through the shared throttle` — el limitador existía, estaba
  probado y **no estaba en el camino de las peticiones**.
- `fix(queue): reclaim expired leases while the run is in progress` — un job arrendado por un
  proceso muerto no volvía durante la corrida, y el bucle esperaba para siempre.
- `fix(cli): make the non-crawl commands usable from the entry point` — un `return promesa`
  dentro de un `try/finally` cerraba la base antes de adoptarla.
- `fix(report): count the cases the site could not render` — el total de expedientes bajaba a
  medida que avanzaba la corrida.
- Los tres primeros treinta segundos, encontrados probando el proyecto en una máquina limpia en
  vez de dándolos por buenos: `fix(cli): load .env from the process, as the readme promises` —los
  scripts corren por `tsx`, así que el archivo que el README manda copiar no lo leía nadie—,
  `fix(config): read an empty environment variable as unset` —`.env.example` deja claves en blanco
  a propósito y se rechazaban como fecha inválida— y `fix(db): create the pglite data directory
before opening it` —el camino sin Docker moría con `ENOENT` en un clon recién hecho.
- `fix(crawl): keep a planner-only run unfinished`, `fix(db): re-derive document formatting when
reading a party`, `fix(engine): share one crawl across the completeness assertions`,
  `fix(core): detect the windows-1252 rendering of mojibake too`, `fix(docs)` ×2, `fix(ci)` ×2,
  `fix(db)` ×1, `fix(cli)` ×1.
