ALTER TABLE connections ADD COLUMN deleted_at timestamptz, ADD COLUMN deleted_by text;
DROP INDEX connections_workspace_name;
CREATE UNIQUE INDEX connections_workspace_name ON connections (workspace_id, lower(name)) WHERE (deleted_at IS NULL);

ALTER TABLE flows ADD COLUMN deleted_by_commit text;
ALTER TABLE flow_versions ADD COLUMN commit_sha text;
ALTER TABLE deployment_history ADD COLUMN commit_sha text;
