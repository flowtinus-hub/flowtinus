CREATE TABLE emergency_rollbacks (
  flow_id uuid PRIMARY KEY REFERENCES flows,
  workspace_id uuid NOT NULL REFERENCES workspaces,
  git_version_id uuid NOT NULL REFERENCES flow_versions,
  version_id uuid NOT NULL REFERENCES flow_versions,
  by_user text,
  at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE deployment_history DROP CONSTRAINT deployment_history_action_check;
ALTER TABLE deployment_history
  ADD CONSTRAINT deployment_history_action_check
  CHECK (action = ANY (ARRAY['deploy', 'rollback', 'undeploy', 'emergency-rollback', 'end-emergency-rollback']));

-- an end by a commit or by turning git off goes back to no version of its own: its to_version_id is null
ALTER TABLE deployment_history DROP CONSTRAINT deployment_history_to_version;
ALTER TABLE deployment_history
  ADD CONSTRAINT deployment_history_to_version
  CHECK (action = 'end-emergency-rollback' OR ((action = 'undeploy') = (to_version_id IS NULL)));
