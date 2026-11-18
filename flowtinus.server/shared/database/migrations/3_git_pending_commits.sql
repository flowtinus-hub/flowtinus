CREATE TABLE git_pending_commits (
  id bigserial PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces,
  message text NOT NULL,
  changes jsonb NOT NULL,
  author_name text,
  author_email text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX git_pending_commits_workspace ON git_pending_commits (workspace_id, id);
