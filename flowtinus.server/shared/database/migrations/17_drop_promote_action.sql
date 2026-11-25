ALTER TABLE deployment_history DROP CONSTRAINT deployment_history_action_check;
ALTER TABLE deployment_history
  ADD CONSTRAINT deployment_history_action_check CHECK (action = ANY (ARRAY['deploy', 'rollback', 'undeploy']));
