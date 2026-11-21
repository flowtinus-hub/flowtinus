-- the workspace's slug is its handle: the name it goes by in urls, the repo and import paths
ALTER TABLE workspaces RENAME COLUMN slug TO handle;
ALTER TABLE workspaces RENAME CONSTRAINT workspaces_slug_format TO workspaces_handle_format;
ALTER INDEX workspaces_slug RENAME TO workspaces_handle;
