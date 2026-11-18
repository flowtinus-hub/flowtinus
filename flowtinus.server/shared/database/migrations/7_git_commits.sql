CREATE TABLE git_commits (
  workspace_id uuid NOT NULL REFERENCES workspaces,
  sha text NOT NULL,
  message text NOT NULL,
  author_name text NOT NULL,
  author_email text NOT NULL,
  authored_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, sha)
);
