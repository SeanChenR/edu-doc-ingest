-- docs/DESIGN.md §4 (tables), §7.3 (RLS). Roles app_user / worker_user are created by
-- scripts/migrate.ts before this file runs (passwords come from env, never from SQL).

-- 4.1 workspaces -------------------------------------------------------------
CREATE TABLE workspaces (
  id         text PRIMARY KEY,
  name       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- 4.2 api_keys ---------------------------------------------------------------
CREATE TABLE api_keys (
  id           text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces (id),
  key_hash     text NOT NULL UNIQUE,
  label        text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  revoked_at   timestamptz
);
CREATE INDEX api_keys_workspace_id_idx ON api_keys (workspace_id);

-- 4.3 documents --------------------------------------------------------------
CREATE TABLE documents (
  id             text PRIMARY KEY,
  workspace_id   text NOT NULL REFERENCES workspaces (id),
  name           text NOT NULL,
  mime_type      text NOT NULL,
  size_bytes     integer NOT NULL,
  storage_key    text NOT NULL,
  status         text NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'processing', 'ready', 'failed')),
  latest_job_id  text,
  extracted_text text,
  page_count     integer,
  chunk_count    integer,
  metadata       jsonb,
  deleted_at     timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX documents_workspace_created_idx ON documents (workspace_id, created_at DESC);
CREATE INDEX documents_workspace_status_idx ON documents (workspace_id, status);

-- 4.5 jobs -------------------------------------------------------------------
CREATE TABLE jobs (
  id                 text PRIMARY KEY,
  workspace_id       text NOT NULL REFERENCES workspaces (id),
  document_id        text NOT NULL REFERENCES documents (id),
  kind               text NOT NULL DEFAULT 'ingest',
  status             text NOT NULL DEFAULT 'queued'
                     CHECK (status IN ('queued', 'extracting', 'embedding', 'ready', 'failed')),
  progress           smallint NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  attempt            smallint NOT NULL DEFAULT 0,
  max_attempts       smallint NOT NULL DEFAULT 3,
  last_error_code    text,
  last_error_message text,
  queue_msg_id       bigint,
  started_at         timestamptz,
  finished_at        timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX jobs_workspace_created_idx ON jobs (workspace_id, created_at DESC);
CREATE INDEX jobs_document_id_idx ON jobs (document_id);

-- 4.4 document_chunks --------------------------------------------------------
CREATE TABLE document_chunks (
  id           text PRIMARY KEY,
  document_id  text NOT NULL REFERENCES documents (id),
  workspace_id text NOT NULL,
  chunk_index  integer NOT NULL,
  content      text NOT NULL,
  token_count  integer NOT NULL,
  embedding    vector(1536),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_id, chunk_index)
);
-- No embedding index yet (§4.4): there is no query endpoint. HNSW cosine in production.

-- 4.6 job_events -------------------------------------------------------------
CREATE TABLE job_events (
  id           bigserial PRIMARY KEY,
  job_id       text NOT NULL REFERENCES jobs (id),
  workspace_id text NOT NULL,
  type         text NOT NULL
               CHECK (type IN ('snapshot', 'stage_changed', 'progress', 'retry_scheduled', 'completed', 'failed')),
  stage        text,
  progress     smallint NOT NULL,
  attempt      smallint NOT NULL,
  message      text,
  payload      jsonb,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX job_events_job_id_id_idx ON job_events (job_id, id);

-- 4.7 idempotency_keys -------------------------------------------------------
CREATE TABLE idempotency_keys (
  workspace_id    text NOT NULL,
  key             text NOT NULL,
  request_hash    text NOT NULL,
  response_status smallint,
  response_body   jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, key)
);

-- 7.3 Row-Level Security -----------------------------------------------------
-- Policy reads the transaction-local setting written by withTenant(); a missing
-- setting yields NULL and therefore matches no row.
ALTER TABLE documents        ENABLE ROW LEVEL SECURITY;
ALTER TABLE documents        FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON documents
  USING (workspace_id = current_setting('app.workspace_id', true));

ALTER TABLE document_chunks  ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_chunks  FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON document_chunks
  USING (workspace_id = current_setting('app.workspace_id', true));

ALTER TABLE jobs             ENABLE ROW LEVEL SECURITY;
ALTER TABLE jobs             FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON jobs
  USING (workspace_id = current_setting('app.workspace_id', true));

ALTER TABLE job_events       ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_events       FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON job_events
  USING (workspace_id = current_setting('app.workspace_id', true));

ALTER TABLE idempotency_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE idempotency_keys FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON idempotency_keys
  USING (workspace_id = current_setting('app.workspace_id', true));

-- Grants ---------------------------------------------------------------------
-- app_user (api): subject to RLS. worker_user: BYPASSRLS attribute set by migrate.ts,
-- still wraps every job in withTenant() (§7.3).
GRANT USAGE ON SCHEMA public TO app_user, worker_user;
GRANT SELECT ON workspaces, api_keys TO app_user, worker_user;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON documents, document_chunks, jobs, job_events, idempotency_keys
  TO app_user, worker_user;
GRANT USAGE, SELECT ON SEQUENCE job_events_id_seq TO app_user, worker_user;

-- pgmq functions are not SECURITY DEFINER: callers need the queue tables too.
GRANT USAGE ON SCHEMA pgmq TO app_user, worker_user;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pgmq TO app_user, worker_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA pgmq TO app_user, worker_user;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA pgmq TO app_user, worker_user;
