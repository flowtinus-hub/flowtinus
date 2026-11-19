-- an Update of a work branch that conflicted (or merged into an invalid tree): the merge waits, as git's MERGE_HEAD,
-- until a Commit takes it whole or Discard all aborts it
CREATE TABLE pending_merges (
  workspace_id uuid NOT NULL REFERENCES workspaces,
  branch text NOT NULL,
  -- the branch's tip the merge was made on: the first parent
  ours text NOT NULL,
  -- the environment's branch tip merged in: the second parent
  theirs text NOT NULL,
  -- the environment's branch, by name
  source text NOT NULL,
  -- the files the merge wrote into the branch's working copy, and those of them marked as conflicted
  paths text[] NOT NULL,
  conflicts text[] NOT NULL,
  merged_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, branch)
);
