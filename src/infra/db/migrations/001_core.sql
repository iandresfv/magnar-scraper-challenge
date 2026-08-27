-- Esquema núcleo de juris-scraper.
--
-- Postgres es la única fuente de verdad: los datos, el árbol de particiones, la cola de
-- trabajo, la DLQ (jobs en estado 'dead'), el limitador compartido y las métricas son tablas.
-- JSON y CSV existen sólo como formato de exportación.
--
-- Toda clave primaria lleva `site`. El modelo está pensado para consolidar varios tribunales
-- de LATAM y una columna `extra jsonb` absorbe los campos propios de cada uno sin un ALTER por
-- cada corte nueva.
--
-- Corre idéntica en Postgres 16 y en PGlite: no hay nada aquí que sólo entienda un servidor.

CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE SCHEMA IF NOT EXISTS juris;

-- ─────────────────────────── catálogo ───────────────────────────

CREATE TABLE juris.site (
  id        text PRIMARY KEY,
  country   char(2) NOT NULL,
  name      text NOT NULL,
  base_url  text NOT NULL,
  timezone  text NOT NULL
);

-- ─────────────────────── datos canónicos ────────────────────────

CREATE TABLE juris.case_record (
  site                      text NOT NULL REFERENCES juris.site,
  id_origem                 text NOT NULL,           -- TRF5: idProcessoTrf, gratis en el id del <td>
  numero                    text NOT NULL,           -- TRF5: número CNJ; otros países, su formato
  numero_norm               text NOT NULL,           -- sólo dígitos, para joins cross-sitio
  classe                    text NOT NULL,
  classe_codigo             integer,
  assunto_resumo            text NOT NULL,
  data_distribuicao         date,
  data_autuacao_ini         date NOT NULL,           -- rango de la hoja de partición que lo listó
  data_autuacao_fim         date NOT NULL,
  jurisdicao                text,
  orgao_julgador            text,
  orgao_julgador_colegiado  text,
  endereco                  text,
  processo_referencia       text,
  partes_resumo             text NOT NULL,
  ultima_mov_descricao      text,
  ultima_mov_em             timestamptz,
  estado                    text NOT NULL CHECK (estado IN ('LISTED', 'DETAILED', 'DETAIL_FAILED')),
  content_hash              text NOT NULL,           -- sha256 del registro canónico sin timestamps
  extra                     jsonb NOT NULL DEFAULT '{}',
  listed_at                 timestamptz NOT NULL,
  detailed_at               timestamptz,
  updated_at                timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (site, id_origem),
  CHECK (data_autuacao_fim >= data_autuacao_ini)
);
CREATE UNIQUE INDEX case_numero_uq ON juris.case_record (site, numero);
CREATE INDEX case_autuacao_idx ON juris.case_record (site, data_autuacao_ini);
CREATE INDEX case_classe_idx ON juris.case_record (site, classe);
CREATE INDEX case_estado_idx ON juris.case_record (site, estado);
CREATE INDEX case_extra_gin ON juris.case_record USING gin (extra jsonb_path_ops);

CREATE TABLE juris.subject (
  site       text NOT NULL,
  id_origem  text NOT NULL,
  nivel      smallint NOT NULL,
  codigo     integer,
  descricao  text NOT NULL,
  PRIMARY KEY (site, id_origem, nivel),
  FOREIGN KEY (site, id_origem) REFERENCES juris.case_record ON DELETE CASCADE
);

CREATE TABLE juris.party (
  site               text NOT NULL,
  id_origem          text NOT NULL,
  polo               text NOT NULL CHECK (polo IN ('ATIVO', 'PASSIVO', 'OUTROS')),
  ordem              smallint NOT NULL,
  nome               text NOT NULL,
  tipo_participacao  text NOT NULL,
  doc_tipo           text CHECK (doc_tipo IN ('CPF', 'CNPJ', 'DNI', 'RUC', 'NIT', 'CURP', 'RFC')),
  doc_digitos        text,
  doc_valido         boolean,
  situacao           text,
  PRIMARY KEY (site, id_origem, polo, ordem),
  FOREIGN KEY (site, id_origem) REFERENCES juris.case_record ON DELETE CASCADE
);
CREATE INDEX party_doc_idx ON juris.party (doc_digitos) WHERE doc_digitos IS NOT NULL;
CREATE INDEX party_nome_fts ON juris.party USING gin (to_tsvector('simple', nome));

CREATE TABLE juris.lawyer (
  site             text NOT NULL,
  id_origem        text NOT NULL,
  polo             text NOT NULL,
  ordem            smallint NOT NULL,
  nome             text NOT NULL,
  registro_uf      text,                              -- TRF5: UF de la OAB
  registro_numero  text,
  doc_tipo         text,
  doc_digitos      text,
  situacao         text,
  PRIMARY KEY (site, id_origem, polo, ordem),
  FOREIGN KEY (site, id_origem) REFERENCES juris.case_record ON DELETE CASCADE
);
CREATE INDEX lawyer_registro_idx ON juris.lawyer (registro_uf, registro_numero);

CREATE TABLE juris.movement (
  site       text NOT NULL,
  id_origem  text NOT NULL,
  seq        smallint NOT NULL,
  data_hora  timestamptz NOT NULL,
  descricao  text NOT NULL,
  PRIMARY KEY (site, id_origem, seq),
  FOREIGN KEY (site, id_origem) REFERENCES juris.case_record ON DELETE CASCADE
);
CREATE INDEX movement_data_idx ON juris.movement (site, data_hora DESC);
CREATE INDEX movement_fts ON juris.movement USING gin (to_tsvector('portuguese', descricao));

CREATE TABLE juris.document (
  site        text NOT NULL,
  id_origem   text NOT NULL,
  id_doc      text NOT NULL,                          -- TRF5: idProcessoDoc
  id_bin      text,                                   -- TRF5: idBin, necesario para el recibo
  tipo        text NOT NULL,
  juntado_em  timestamptz,
  titulo      text,
  PRIMARY KEY (site, id_doc),
  FOREIGN KEY (site, id_origem) REFERENCES juris.case_record ON DELETE CASCADE
);
CREATE INDEX document_case_idx ON juris.document (site, id_origem);

CREATE TABLE juris.blob (
  site          text NOT NULL,
  key           text NOT NULL,                        -- 'relatorio:16730' | 'recibo:16730:7222997'
  id_origem     text NOT NULL,
  id_doc        text,
  tipo          text NOT NULL,
  source_url    text NOT NULL,
  storage_uri   text,                                 -- 's3://bucket/…' | 'file:///…'
  estado        text NOT NULL CHECK (estado IN ('PENDING', 'STORED', 'FAILED', 'SKIPPED')),
  bytes         integer,
  sha256        text,
  content_type  text,
  stored_at     timestamptz,
  PRIMARY KEY (site, key),
  FOREIGN KEY (site, id_origem) REFERENCES juris.case_record ON DELETE CASCADE
);
CREATE UNIQUE INDEX blob_storage_uri_uq ON juris.blob (storage_uri) WHERE storage_uri IS NOT NULL;
CREATE INDEX blob_sha_idx ON juris.blob (sha256) WHERE sha256 IS NOT NULL;
CREATE INDEX blob_estado_idx ON juris.blob (site, estado);

-- ───────────────────── control de crawl ─────────────────────────

CREATE TABLE juris.crawl_run (
  run_id       uuid PRIMARY KEY,
  site         text NOT NULL REFERENCES juris.site,
  started_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz,
  root_ini     date NOT NULL,
  root_fim     date NOT NULL,
  config       jsonb NOT NULL,
  version      text NOT NULL,
  exit_code    integer,
  summary      jsonb
);
CREATE INDEX crawl_run_site_idx ON juris.crawl_run (site, started_at DESC);

CREATE TABLE juris.partition (
  site           text NOT NULL,
  id             text NOT NULL,                       -- '2024-05-15..2024-05-15|classe=APELAÇÃO CÍVEL'
  run_id         uuid NOT NULL REFERENCES juris.crawl_run,
  parent_id      text,
  data_ini       date NOT NULL,
  data_fim       date NOT NULL,
  facets         jsonb NOT NULL DEFAULT '{}',         -- ejes secundarios: {"classe": "..."}
  status         text NOT NULL CHECK (status IN
                   ('PENDING', 'SPLIT', 'SPLIT_SECONDARY', 'LEAF_DONE',
                    'LEAF_DONE_SECONDARY', 'GAP', 'STALE', 'FAILED')),
  observed_rows  integer,
  truncated      boolean,
  cap_seen       integer,
  attempts       integer NOT NULL DEFAULT 0,
  last_error     text,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (site, id),
  CHECK (data_fim >= data_ini),
  -- El teselado primario como restricción de la base, no como buena intención del código:
  -- dos hojas primarias del mismo sitio no pueden solaparse ni por accidente ni por un bug
  -- del planificador. Los huecos los detecta assertTiling, que es el otro lado del invariante.
  EXCLUDE USING gist (site WITH =, daterange(data_ini, data_fim, '[]') WITH &&)
    WHERE (status = 'LEAF_DONE' AND facets = '{}'::jsonb)
);
CREATE INDEX partition_status_idx ON juris.partition (site, status);
CREATE INDEX partition_run_idx ON juris.partition (run_id);

CREATE TABLE juris.job (
  id             bigserial PRIMARY KEY,
  site           text NOT NULL REFERENCES juris.site,
  kind           text NOT NULL CHECK (kind IN ('search', 'detail', 'blob', 'verify')),
  key            text NOT NULL,                       -- idempotencia: 'detail:16730'
  payload        jsonb NOT NULL,
  status         text NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending', 'leased', 'done', 'dead')),
  priority       smallint NOT NULL DEFAULT 100,       -- menor = antes; search < detail < blob
  run_after      timestamptz NOT NULL DEFAULT now(),
  attempts       integer NOT NULL DEFAULT 0,
  max_attempts   integer NOT NULL DEFAULT 6,
  leased_by      text,
  lease_until    timestamptz,
  failure_class  text,
  last_error     text,
  http_status    integer,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (site, key)
);
CREATE INDEX job_pick_idx ON juris.job (site, priority, run_after, id) WHERE status = 'pending';
CREATE INDEX job_lease_idx ON juris.job (lease_until) WHERE status = 'leased';
CREATE INDEX job_dead_idx ON juris.job (site, kind) WHERE status = 'dead';

CREATE TABLE juris.site_throttle (
  site               text PRIMARY KEY REFERENCES juris.site,
  tokens             numeric NOT NULL,
  capacity           numeric NOT NULL,
  refill_per_sec     numeric NOT NULL,
  concurrency        integer NOT NULL,
  concurrency_min    integer NOT NULL,
  concurrency_max    integer NOT NULL,
  in_flight          integer NOT NULL DEFAULT 0,
  ok_streak          integer NOT NULL DEFAULT 0,
  breaker_state      text NOT NULL DEFAULT 'CLOSED'
                       CHECK (breaker_state IN ('CLOSED', 'OPEN', 'HALF_OPEN')),
  breaker_until      timestamptz,
  breaker_opens      integer NOT NULL DEFAULT 0,
  last_429_at        timestamptz,
  retry_after_until  timestamptz,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CHECK (concurrency BETWEEN concurrency_min AND concurrency_max),
  CHECK (in_flight >= 0)
);

CREATE TABLE juris.class_vocabulary (
  site        text NOT NULL REFERENCES juris.site,
  facet       text NOT NULL,                          -- 'classe'
  value       text NOT NULL,
  first_seen  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (site, facet, value)
);

CREATE TABLE juris.metric (
  ts      timestamptz NOT NULL DEFAULT now(),
  run_id  uuid,
  site    text NOT NULL,
  name    text NOT NULL,
  labels  jsonb NOT NULL DEFAULT '{}',
  value   double precision NOT NULL
);
CREATE INDEX metric_idx ON juris.metric (site, name, ts DESC);
