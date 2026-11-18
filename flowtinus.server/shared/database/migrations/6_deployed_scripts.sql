CREATE TABLE deployed_scripts (
  workspace_id uuid NOT NULL REFERENCES workspaces,
  project_id uuid NOT NULL REFERENCES projects,
  path text NOT NULL,
  hash text NOT NULL,
  commit_sha text NOT NULL,
  PRIMARY KEY (project_id, path),
  FOREIGN KEY (workspace_id, hash) REFERENCES script_blobs (workspace_id, hash)
);
CREATE INDEX deployed_scripts_by_workspace ON deployed_scripts (workspace_id);
