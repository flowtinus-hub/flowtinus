-- The schema, from scratch (the earlier migrations 1 to 24 squashed into one). Changes go in new files after it.

CREATE TABLE api_tokens (
  id uuid PRIMARY KEY,
  user_id text NOT NULL,
  name text NOT NULL,
  token_hash text NOT NULL,
  prefix text NOT NULL,
  scopes text[] NOT NULL,
  expires_at timestamptz,
  last_used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  run_scope jsonb,
  UNIQUE (token_hash)
);
CREATE INDEX api_tokens_user ON api_tokens (user_id);

CREATE TABLE workspaces (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  slug text NOT NULL,
  description text NOT NULL DEFAULT '',
  icon text NOT NULL DEFAULT 'layers',
  color text NOT NULL DEFAULT 'blue',
  deleted_at timestamptz,
  deleted_by text,
  CONSTRAINT workspaces_slug_format CHECK ((slug ~ '^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$'))
);
CREATE UNIQUE INDEX workspaces_slug ON workspaces (slug);

CREATE TABLE connections (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces,
  name text NOT NULL,
  type text NOT NULL,
  config jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  server jsonb
);
CREATE UNIQUE INDEX connections_workspace_name ON connections (workspace_id, lower(name));

CREATE TABLE projects (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces,
  name text NOT NULL,
  description text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  deleted_by text,
  icon text NOT NULL DEFAULT 'folder',
  color text NOT NULL DEFAULT 'blue'
);
CREATE INDEX projects_workspace ON projects (workspace_id) WHERE (deleted_at IS NULL);

CREATE TABLE folders (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces,
  project_id uuid NOT NULL REFERENCES projects,
  parent_id uuid REFERENCES folders,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  deleted_by text,
  removed_at timestamptz,
  removed_by text
);
CREATE UNIQUE INDEX folders_live_name ON folders (project_id, COALESCE(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(name)) WHERE (deleted_at IS NULL);
CREATE INDEX folders_project ON folders (workspace_id, project_id);

CREATE TABLE flows (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces,
  project_id uuid NOT NULL REFERENCES projects,
  name text NOT NULL,
  draft_definition jsonb,
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  deleted_by text,
  folder_id uuid REFERENCES folders,
  created_at timestamptz NOT NULL DEFAULT now(),
  worker_tag text NOT NULL DEFAULT 'default',
  removed_at timestamptz,
  removed_by text
);
CREATE UNIQUE INDEX flows_live_name ON flows (project_id, COALESCE(folder_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(name)) WHERE (deleted_at IS NULL);
CREATE INDEX flows_project ON flows (workspace_id, project_id) WHERE (deleted_at IS NULL);

CREATE TABLE flow_versions (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces,
  flow_id uuid NOT NULL REFERENCES flows,
  number integer NOT NULL,
  definition jsonb NOT NULL,
  content_hash text NOT NULL,
  received_from text,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (flow_id, number)
);

CREATE TABLE deployment_history (
  id bigserial PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces,
  flow_id uuid NOT NULL REFERENCES flows,
  from_version_id uuid REFERENCES flow_versions,
  to_version_id uuid REFERENCES flow_versions,
  action text NOT NULL,
  source_env text,
  by_user text,
  at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT deployment_history_action_check CHECK ((action = ANY (ARRAY['deploy', 'promote', 'rollback', 'undeploy']))),
  CONSTRAINT deployment_history_to_version CHECK (((action = 'undeploy') = (to_version_id IS NULL)))
);
CREATE INDEX deployment_history_flow ON deployment_history (workspace_id, flow_id, at DESC);

CREATE TABLE deployments (
  workspace_id uuid NOT NULL REFERENCES workspaces,
  flow_id uuid PRIMARY KEY REFERENCES flows,
  flow_version_id uuid NOT NULL REFERENCES flow_versions,
  deployed_by text,
  deployed_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE flow_schedules (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces,
  project_id uuid NOT NULL REFERENCES projects,
  flow_id uuid NOT NULL REFERENCES flows,
  cron text NOT NULL,
  timezone text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  misfire text NOT NULL DEFAULT 'relaxed',
  parameters jsonb NOT NULL DEFAULT '{}'::jsonb,
  input jsonb,
  next_fire_at timestamptz,
  last_fired_at timestamptz,
  last_run_id uuid,
  last_error text,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT flow_schedules_misfire_check CHECK ((misfire = ANY (ARRAY['relaxed', 'strict', 'ignorable'])))
);
CREATE INDEX flow_schedules_due ON flow_schedules (next_fire_at) WHERE (enabled AND (next_fire_at IS NOT NULL));
CREATE INDEX flow_schedules_flow ON flow_schedules (workspace_id, flow_id);

CREATE TABLE flow_webhooks (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces,
  project_id uuid NOT NULL REFERENCES projects,
  flow_id uuid NOT NULL REFERENCES flows,
  name text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  response text NOT NULL DEFAULT 'async',
  token_hash text NOT NULL,
  token_hint text NOT NULL,
  last_called_at timestamptz,
  last_status integer,
  last_run_id uuid,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT flow_webhooks_response_check CHECK ((response = ANY (ARRAY['async', 'wait'])))
);
CREATE INDEX flow_webhooks_flow ON flow_webhooks (workspace_id, flow_id);

CREATE TABLE promotions (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces,
  direction text NOT NULL,
  peer_env text NOT NULL,
  package jsonb NOT NULL,
  content_hash text NOT NULL,
  status text NOT NULL,
  requested_by text,
  approved_by text,
  at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT promotions_direction_check CHECK ((direction = ANY (ARRAY['sent', 'received']))),
  CONSTRAINT promotions_status_check CHECK ((status = ANY (ARRAY['pending', 'applied', 'rejected'])))
);

CREATE TABLE runs (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces,
  flow_id uuid NOT NULL,
  parent_id uuid,
  mode text NOT NULL,
  flow_version_id uuid,
  draft_hash text,
  status text NOT NULL,
  trigger text NOT NULL,
  worker_tag text NOT NULL DEFAULT 'default',
  priority integer NOT NULL DEFAULT 0,
  parameters jsonb,
  input jsonb,
  queued_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  worker_id text,
  heartbeat_at timestamptz,
  cancel_requested boolean NOT NULL DEFAULT false,
  start_rss_bytes bigint,
  peak_rss_bytes bigint,
  cpu_ms bigint,
  duration_ms bigint,
  record jsonb,
  project_id uuid REFERENCES projects,
  definition jsonb,
  progress jsonb,
  run_from jsonb,
  scripts jsonb,
  called_flows jsonb,
  root_id uuid,
  parent_node_id text,
  call_chain jsonb,
  flow_name text,
  started_by text,
  parent_node_label text,
  batch_size integer,
  error text,
  envelopes_in bigint,
  envelopes_out bigint,
  rerun_of uuid,
  schedule_id uuid,
  scheduled_for timestamptz,
  webhook_id uuid,
  CONSTRAINT runs_check CHECK (((mode <> 'execution') OR (flow_version_id IS NOT NULL) OR (draft_hash IS NOT NULL))),
  CONSTRAINT runs_check1 CHECK (((mode <> 'validation') OR (draft_hash IS NOT NULL))),
  CONSTRAINT runs_mode_check CHECK ((mode = ANY (ARRAY['execution', 'validation']))),
  CONSTRAINT runs_status_check CHECK ((status = ANY (ARRAY['queued', 'running', 'completed', 'with-warnings', 'with-errors', 'failed', 'cancelled', 'skipped']))),
  CONSTRAINT runs_trigger_check CHECK ((trigger = ANY (ARRAY['manual', 'webhook', 'schedule', 'api', 'flow-invoker'])))
);
CREATE INDEX runs_by_parent ON runs (parent_id) WHERE (parent_id IS NOT NULL);
CREATE INDEX runs_by_root ON runs (root_id, status) WHERE (root_id IS NOT NULL);
CREATE INDEX runs_by_workspace ON runs (workspace_id, queued_at DESC);
CREATE INDEX runs_open ON runs (workspace_id, status) WHERE (status = ANY (ARRAY['queued', 'running']));
CREATE INDEX runs_queue ON runs (worker_tag, priority, queued_at) WHERE (status = 'queued');
CREATE INDEX runs_roots ON runs (workspace_id, queued_at DESC) WHERE (parent_id IS NULL);
CREATE INDEX runs_running ON runs (heartbeat_at) WHERE (status = 'running');
CREATE INDEX runs_schedule_open ON runs (schedule_id) WHERE ((schedule_id IS NOT NULL) AND (status = ANY (ARRAY['queued', 'running'])));
CREATE UNIQUE INDEX runs_schedule_time ON runs (schedule_id, scheduled_for) WHERE (schedule_id IS NOT NULL);

CREATE TABLE script_blobs (
  workspace_id uuid NOT NULL REFERENCES workspaces,
  hash text NOT NULL,
  content text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, hash)
);

CREATE TABLE script_folders (
  workspace_id uuid NOT NULL REFERENCES workspaces,
  project_id uuid NOT NULL REFERENCES projects,
  path text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, path)
);

CREATE TABLE scripts (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces,
  project_id uuid NOT NULL REFERENCES projects,
  path text NOT NULL,
  content text NOT NULL DEFAULT '',
  exports jsonb DEFAULT '[]'::jsonb,
  revision integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX scripts_project_path ON scripts (project_id, path);

CREATE TABLE secrets (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces,
  name text NOT NULL,
  key_version text NOT NULL,
  nonce bytea NOT NULL,
  ciphertext bytea NOT NULL,
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX secrets_workspace_name ON secrets (workspace_id, lower(name));

CREATE TABLE supervisors (
  id text PRIMARY KEY,
  tags text[] NOT NULL,
  workers integer NOT NULL,
  version text,
  last_seen timestamptz NOT NULL DEFAULT now(),
  host text,
  started_at timestamptz NOT NULL DEFAULT now(),
  color text,
  fire_and_forget_per_worker integer
);

CREATE UNLOGGED TABLE test_runs (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces,
  flow_id uuid NOT NULL,
  parent_id uuid,
  mode text NOT NULL,
  flow_version_id uuid,
  draft_hash text,
  status text NOT NULL,
  trigger text NOT NULL,
  worker_tag text NOT NULL DEFAULT 'default',
  priority integer NOT NULL DEFAULT 0,
  parameters jsonb,
  input jsonb,
  queued_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  worker_id text,
  heartbeat_at timestamptz,
  cancel_requested boolean NOT NULL DEFAULT false,
  start_rss_bytes bigint,
  peak_rss_bytes bigint,
  cpu_ms bigint,
  duration_ms bigint,
  record jsonb,
  project_id uuid REFERENCES projects,
  definition jsonb,
  progress jsonb,
  user_id text NOT NULL,
  run_from jsonb,
  scripts jsonb,
  called_flows jsonb,
  root_id uuid,
  parent_node_id text,
  call_chain jsonb,
  flow_name text,
  started_by text,
  parent_node_label text,
  batch_size integer,
  error text,
  envelopes_in bigint,
  envelopes_out bigint,
  rerun_of uuid,
  schedule_id uuid,
  scheduled_for timestamptz,
  webhook_id uuid,
  CONSTRAINT runs_check CHECK (((mode <> 'execution') OR (flow_version_id IS NOT NULL) OR (draft_hash IS NOT NULL))),
  CONSTRAINT runs_check1 CHECK (((mode <> 'validation') OR (draft_hash IS NOT NULL))),
  CONSTRAINT runs_mode_check CHECK ((mode = ANY (ARRAY['execution', 'validation']))),
  CONSTRAINT runs_status_check CHECK ((status = ANY (ARRAY['queued', 'running', 'completed', 'with-warnings', 'with-errors', 'failed', 'cancelled']))),
  CONSTRAINT runs_trigger_check CHECK ((trigger = ANY (ARRAY['manual', 'webhook', 'schedule', 'api']))),
  CONSTRAINT test_runs_validation CHECK ((mode = 'validation'))
);
CREATE INDEX test_runs_age ON test_runs (queued_at);
CREATE UNIQUE INDEX test_runs_latest ON test_runs (workspace_id, flow_id, user_id, ((run_from IS NOT NULL)));
CREATE INDEX test_runs_queue ON test_runs (worker_tag, priority, queued_at) WHERE (status = 'queued');
CREATE INDEX test_runs_running ON test_runs (heartbeat_at) WHERE (status = 'running');

CREATE TABLE users (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  email text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  is_admin boolean NOT NULL DEFAULT false
);
CREATE UNIQUE INDEX users_email ON users (lower(email));

CREATE TABLE variables (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces,
  name text NOT NULL,
  value text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX variables_workspace_name ON variables (workspace_id, lower(name));

CREATE TABLE workspace_members (
  workspace_id uuid NOT NULL REFERENCES workspaces,
  user_id uuid NOT NULL REFERENCES users,
  role text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workspace_members_role_check CHECK ((role = ANY (ARRAY['admin', 'editor', 'viewer']))),
  PRIMARY KEY (workspace_id, user_id)
);
CREATE INDEX workspace_members_user ON workspace_members (user_id);

CREATE TABLE workspace_settings (
  workspace_id uuid NOT NULL REFERENCES workspaces,
  key text NOT NULL,
  value jsonb NOT NULL,
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, key)
);

