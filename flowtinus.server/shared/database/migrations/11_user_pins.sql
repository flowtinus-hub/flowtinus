-- a pinned output is its user's: never in the draft, the same on every branch; flow_id has no foreign key (a flow only
-- on a branch has no flows row)
CREATE TABLE pins (
  workspace_id uuid NOT NULL REFERENCES workspaces,
  user_id text NOT NULL,
  flow_id uuid NOT NULL,
  node_id text NOT NULL,
  pinned jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id, flow_id, node_id)
);
