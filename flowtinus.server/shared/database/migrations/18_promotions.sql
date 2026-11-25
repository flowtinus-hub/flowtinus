CREATE TABLE promotions (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces,
  source text NOT NULL,
  target text NOT NULL,
  sha text NOT NULL,
  branch text NOT NULL,
  opened_by text NOT NULL,
  opened_at timestamptz NOT NULL DEFAULT now(),
  state text NOT NULL CHECK (state IN ('open', 'broken', 'merged', 'closed')),
  state_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX promotions_workspace ON promotions (workspace_id, opened_at DESC);

CREATE TABLE git_reconciles (
  workspace_id uuid NOT NULL REFERENCES workspaces,
  sha text NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('applied', 'refused')),
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX git_reconciles_workspace ON git_reconciles (workspace_id, at DESC);
