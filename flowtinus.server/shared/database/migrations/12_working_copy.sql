CREATE TABLE working_copy (
  workspace_id uuid NOT NULL REFERENCES workspaces,
  branch text NOT NULL,
  path text NOT NULL,
  content text,
  deleted boolean NOT NULL DEFAULT false,
  file_id text,
  base text,
  edited_by text,
  conflict text,
  revision integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, branch, path)
);
CREATE INDEX working_copy_file ON working_copy (workspace_id, branch, file_id);

-- the drafts and the scripts being edited, kept for the step after the migrations that writes them into the working
-- copy in the repo format (features/git/draft-carryover.ts), which then drops these two tables
CREATE TABLE draft_carryover AS
  SELECT workspace_id, id AS flow_id, draft_definition AS draft, updated_by FROM flows
   WHERE draft_definition IS NOT NULL AND removed_at IS NULL;
ALTER TABLE scripts RENAME TO scripts_carryover;

ALTER TABLE flows DROP COLUMN draft_definition, DROP COLUMN draft_base, DROP COLUMN draft_conflict;
