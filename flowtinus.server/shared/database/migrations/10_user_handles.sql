-- the <handle> of users/<handle>/... branches: made once, when the user is inserted, and never changed after
ALTER TABLE users ADD COLUMN handle text;

-- joão.omc@gmail.com → joao_omc_gmail: accents dropped, the local part and the domain without its last label, every
-- run of other characters as one _
CREATE FUNCTION user_handle_base(email text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT coalesce(nullif(
    trim(BOTH '_' FROM regexp_replace(
      regexp_replace(e, '@([^@]*)$', '') || '_' || regexp_replace(coalesce(substring(e FROM '@([^@]*)$'), ''), '\.?[^.]*$', ''),
      '[^a-z0-9]+', '_', 'g')),
    ''), 'user')
  FROM (SELECT regexp_replace(normalize(lower(email), NFD), '[̀-ͯ]', '', 'g') AS e) AS email
$$;

CREATE FUNCTION users_handle() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  base text;
  n int := 1;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.handle IS NOT NULL THEN
    NEW.handle := OLD.handle;
    RETURN NEW;
  END IF;
  base := user_handle_base(NEW.email);
  NEW.handle := base;
  WHILE EXISTS (SELECT 1 FROM users WHERE handle = NEW.handle) LOOP
    n := n + 1;
    NEW.handle := base || n;
  END LOOP;
  RETURN NEW;
END
$$;

CREATE TRIGGER users_handle BEFORE INSERT OR UPDATE OF handle ON users FOR EACH ROW EXECUTE FUNCTION users_handle();

DO $$
DECLARE
  u record;
BEGIN
  FOR u IN SELECT id FROM users ORDER BY created_at, id LOOP
    UPDATE users SET handle = NULL WHERE id = u.id;
  END LOOP;
END
$$;
ALTER TABLE users ALTER COLUMN handle SET NOT NULL;
CREATE UNIQUE INDEX users_handle_unique ON users (handle);

-- each user's current branch in a workspace; no row: the environment's branch
CREATE TABLE user_branches (
  workspace_id uuid NOT NULL REFERENCES workspaces,
  user_id uuid NOT NULL REFERENCES users,
  branch text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id)
);
