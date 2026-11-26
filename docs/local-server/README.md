# Local server

A Flowtinus in Docker on your own clone of a flows repo. It reads your working tree on disk, committed or not, and git
stays yours: you branch, commit, push and open pull requests yourself.

## Start it

1. Build the server's image once, in the Flowtinus repo: `docker compose --profile server build` (again after you pull
   Flowtinus). Another image name goes in `FLOWTINUS_IMAGE`.
2. Copy [`compose.yaml`](compose.yaml) into the root of your flows repo.
3. On a Linux host, put your user in a `.env` next to it, so the files the server writes are yours:

    ```sh
    printf 'UID=%s\nGID=%s\n' "$(id -u)" "$(id -g)" > .env
    ```

    Docker Desktop (Windows, macOS) maps the mount's owner itself: no `.env` needed.

4. `docker compose up -d` in the flows repo, then `bun run editor` in the Flowtinus repo and open http://localhost:5180.

`curl http://localhost:5190/health` answers `{"ok":true,"environment":"LOCAL"}`. Add `compose.yaml` to the flows repo's
`.gitignore` if it is not meant for the others. `docker compose down` stops it; `docker compose down -v` also deletes
its Postgres.

The api is on port 5190, as the editor expects: stop another Flowtinus server on that port first.

## What it does

- `LOCAL_REPO=/repo`, with the clone bind-mounted there (`.git` included), makes the whole server local: it reports
  `LOCAL` on `/health` and the workers page.
- Every workspace folder of the tree (a folder with a `workspace.yaml`) is a workspace of the local server.
- It seeds one admin user and the dev token for the MCP, never a workspace, and uses the fixed dev key unless
  `SECRETS_KEYS` is set.
- Connections, credentials, secrets and variables are the local server's own, kept in its Postgres volume across branch
  switches.

## What it does not do

- No commit, push, pull request or branch switch: the workspace's git section is read-only.
- No topology, environments, promotion, hotfix, backport, repair or emergency rollback, and no provider adapter.
- No polling of a remote and no git webhook.
- A trigger (a schedule or a webhook) arrives disabled, so a clone never fires a production cron.
