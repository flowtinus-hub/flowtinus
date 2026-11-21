# MCP server

Flowtinus runs no model. It gives **your own agent** (Copilot, Claude, Cursor, Codex…) tools to read, write, validate
and test flows the way the editor does, through a remote MCP server at `/mcp` on the API (`http://localhost:5190/mcp`
in development). The plan and its decisions: [plan.md](plan.md).

What an agent can do: read the catalog of components, list projects, folders, flows, scripts and the names of
connections, variables and secrets; create a workspace's variables or change their values; test a connection (and see which server it reaches); read a flow's draft as YAML;
validate a flow; create projects, folders and flows; save drafts; pin a component's output from a run; test run a draft,
read the summary, page through a component's envelopes, list the runs; with the user's explicit approval (or within the
token's run scope), run a flow for real; with the user's explicit approval, archive it. What it cannot: deploy (a person
does it in the editor), promote, read a secret's value or a connection's fields, create connections or secrets (a secret's value goes in through the editor only).

## Authentication: personal access tokens

Every call carries `Authorization: Bearer ftn_...`. A token belongs to a user of the environment: the agent acts as
that user, in any of the user's workspaces. Each call acts in one workspace: the one it names (`workspace`, its handle) or
the one of the flow, project, run or connection it names; a workspace the user is not a member of is not found. In a workspace the
token never does more than the user's role there: a viewer reads, an editor also writes and runs, an admin also manages
the workspace (the tools that write answer `forbidden` to a viewer whatever the token's scopes). Only the token's sha256 is stored (`api_tokens`, migration 19). A revoked or expired token gets `401`; a tool
outside the token's scopes answers `forbidden`, naming the scope.

| Scope              | Tools                                                                                                                                                                              |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `catalog:read`     | `list_components`, `describe_component`, `get_flow_format`, `validate_flow`, the catalog resources                                                                                 |
| `flows:read`       | `list_workspaces`, `list_projects`, `get_project_contents`, `get_flow`, `get_flow_calls`, `get_deployments`, `list_scripts`, `get_script`, `resolve_url`, `flowtinus://flows/{id}` |
| `flows:write`      | `create_flow`, `save_draft`, `rename_flow`, `move_flow`, `save_script`, `pin_from_run` and `unpin` (the user's own pins)                                                           |
| `projects:write`   | `create_project`, `create_folder`                                                                                                                                                  |
| `runs:test`        | `test_run`, `cancel_run` (only runs the token's user started)                                                                                                                      |
| `runs:execute`     | `run_for_real` (only with the user's explicit approval, or within the token's run scope, see below)                                                                                |
| `flows:archive`    | `archive_flow` (one flow; only with the user's explicit approval, see below)                                                                                                       |
| `runs:read`        | `get_run`, `get_run_output`, `list_runs`                                                                                                                                           |
| `resources:read`   | `list_connections` (id, name, type, the server its last test reached), `test_connection`, `list_variables`, `list_secret_names`                                                    |
| `resources:write`  | `set_variable` (a workspace's variables: create or change the value; never a secret)                                                                                               |
| `workspaces:write` | `create_workspace` (only for an admin of the environment)                                                                                                                          |

**In development** the seed (`ENVIRONMENT=DEV`) adds a token for the dev user with every scope:
`ftn_dev_local_only_change_with_SEED_DEV_PAT` (`DEV_PAT` in `flowtinus.server/shared/database/seed-dev.ts`). Set
`SEED_DEV_PAT` in `flowtinus.server/.env` to use your own value.

**Access tokens page** (the editor's sidebar, `/tokens`; the API's `GET /tokens`, `POST /tokens`,
`POST /tokens/:id/revoke`): each user makes, sees and revokes **their own** tokens (a token is its user's, not a
workspace's; another user's is not found). A new token gets a name, its scopes (each one says what it allows), how long
it lasts (none, 30 or 90 days, a year) and, with `runs:execute`, what it may run for real: any flow (each run with the
user's approval) or only some folders (with their subfolders) and flows, picked in the tree of a project of any of the
user's workspaces (its **run scope**, `api_tokens.run_scope`, migration 24; see below). Its value is shown once, when it
is made (only its sha256 is kept). The list shows the name, the first characters, the scopes, the run scope, when it was
made, last used and expires. A token without a run scope (every token made before) may run any flow, each run with the
user's approval.

## Connecting an agent

Replace the token below with yours. The examples point at the local API (`API_PORT`, 5190 by default).

**VS Code (Copilot)**, `.vscode/mcp.json` (it asks for the token once and keeps it):

```json
{
    "servers": {
        "flowtinus": {
            "type": "http",
            "url": "http://localhost:5190/mcp",
            "headers": { "Authorization": "Bearer ${input:flowtinus-token}" }
        }
    },
    "inputs": [{ "id": "flowtinus-token", "type": "promptString", "description": "Flowtinus personal access token", "password": true }]
}
```

Copilot's newer agent runtime reads `.mcp.json` at the repository root instead (it offers to migrate the file above; Claude Code reads the same file):

```json
{
    "mcpServers": {
        "flowtinus": {
            "type": "http",
            "url": "http://localhost:5190/mcp",
            "headers": { "Authorization": "Bearer ftn_dev_local_only_change_with_SEED_DEV_PAT" }
        }
    }
}
```

`.vscode/` and `.mcp.json` are in `.gitignore`: a token never goes into the repository.

**Claude Code**:

```bash
claude mcp add --transport http flowtinus http://localhost:5190/mcp --header "Authorization: Bearer ftn_dev_local_only_change_with_SEED_DEV_PAT"
```

**Cursor**, `~/.cursor/mcp.json` (or `.cursor/mcp.json` in a project):

```json
{
    "mcpServers": {
        "flowtinus": {
            "url": "http://localhost:5190/mcp",
            "headers": { "Authorization": "Bearer ftn_dev_local_only_change_with_SEED_DEV_PAT" }
        }
    }
}
```

**Claude Desktop** (through `mcp-remote`, which adds the header), `claude_desktop_config.json`:

```json
{
    "mcpServers": {
        "flowtinus": {
            "command": "npx",
            "args": ["mcp-remote", "http://localhost:5190/mcp", "--header", "Authorization:${FLOWTINUS_TOKEN}"],
            "env": { "FLOWTINUS_TOKEN": "Bearer ftn_dev_local_only_change_with_SEED_DEV_PAT" }
        }
    }
}
```

## Tools

| Tool                                                                                                                  | What it does                                                                                                                                                                                                                                                                                                                                                   |
| --------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list_components`, `describe_component(type)`                                                                         | the components (also `start` and `end`): ports, settings, a valid example config                                                                                                                                                                                                                                                                               |
| `get_flow_format()`                                                                                                   | the flow file (YAML): shape, ports, connections, expressions, the rules, a full example                                                                                                                                                                                                                                                                        |
| `validate_flow(projectId, yaml, flowId?)`                                                                             | `{ok, issues, warnings}`, each issue with `nodeId`, `settingKey` or `port`; checks the project too (called flows, connections, secrets, scripts)                                                                                                                                                                                                               |
| `resolve_url(url)`                                                                                                    | what an editor link (/w/<workspace>/...) points at: a flow, a project, a workspace or a run (checked against the user's workspaces)                                                                                                                                                                                                                            |
| `list_workspaces`, `list_projects(workspace)`, `get_project_contents(projectId)`                                      | the user's workspaces (handle, name, role); a workspace's projects (with their handles); a project's folders and flows                                                                                                                                                                                                                                         |
| `get_flow(flowId, includePinned?)`                                                                                    | the draft as YAML with its `revision`, project, folder and worker tag (the token's user's pinned outputs left out unless asked)                                                                                                                                                                                                                                |
| `get_flow_calls(flowId)`, `get_deployments(flowId)`                                                                   | who it calls and who calls it; what is deployed and whether the draft differs                                                                                                                                                                                                                                                                                  |
| `list_connections(workspace)`, `list_variables(workspace)`, `list_secret_names(workspace)`, `list_scripts(projectId)` | the workspace's connections, variables and secrets (for all its projects) and the project's scripts, by name (never a secret's value or a connection's fields); a database connection with the server its last test reached (`server`: engine, version, testedAt) and a `warning` when that engine is not the type's (a "Redshift" that answers as PostgreSQL) |
| `test_connection(connectionId)`                                                                                       | the editor's Test connection of a saved profile: `ok`, the message and time, the server it reached (engine and version, kept with the connection) and the `warning`; or `ok: false` and why                                                                                                                                                                    |
| `set_variable(workspace, name, value)`                                                                                | creates a variable of the workspace or gives it a new value (a name is unique ignoring case; an existing one keeps its name): what flows read as `$VARIABLES['name']`, e.g. a connection's name for `connectionName`; never a secret                                                                                                                           |
| `get_script(projectId, path)`, `save_script(projectId, path, content, expectedRevision?)`                             | a script's code with its revision; create (no revision) or replace it (the revision guards a person's edit), syntax checked first                                                                                                                                                                                                                              |
| `create_workspace(handle, name)`, `create_project(workspace, name)`, `create_folder`                                  | a workspace (an admin of the environment); a project; a folder (in another with `parentFolderId`)                                                                                                                                                                                                                                                              |
| `create_flow(projectId, name, folderId?, yaml?)`                                                                      | a flow and, with `yaml`, its first draft (validated first: nothing is created when it is not valid)                                                                                                                                                                                                                                                            |
| `save_draft(flowId, yaml, expectedRevision)`                                                                          | validated first; a different revision is a `conflict` with the `currentRevision` (an agent never overwrites a person's edit); a `pinned` in the yaml is ignored (pins are the user's, not the draft's)                                                                                                                                                         |
| `rename_flow`, `move_flow`                                                                                            | name; folder (`null`: the root)                                                                                                                                                                                                                                                                                                                                |
| `test_run(flowId, input?, parameters?, timeoutS = 120, detail?, sample = 3)`                                          | the editor's Run on the saved draft (writes nothing outside); waits and answers the run's [answer](#a-runs-answer), or `running` and the `runId`                                                                                                                                                                                                               |
| `run_for_real(flowId, userApproval?, input?, parameters?, timeoutS = 120, detail?, sample = 3)`                       | the editor's Run for real on the saved draft (it writes outside); only after the user's explicit approval, quoted in `userApproval`, or for a flow in the token's run scope (no `userApproval` needed); waits and answers the run's [answer](#a-runs-answer)                                                                                                   |
| `archive_flow(flowId, userApproval)`                                                                                  | the editor's Archive of one flow (deployed, it is undeployed); only after the user's explicit approval, quoted in `userApproval`                                                                                                                                                                                                                               |
| `get_run(runId, subRunId?, detail?, sample = 5)`, `cancel_run(runId)`                                                 | a run's [answer](#a-runs-answer); with `subRunId` (one id, or the ids down to a call of a call) the answer for a called flow's run; stop a run the token's user started                                                                                                                                                                                        |
| `get_run_output(runId, nodeId, port?, offset = 0, limit = 10, subRunId?)`                                             | the envelopes the run's record keeps of a component's port (`input` for what came in: the End's is what reached it), whole, a page at a time: `total`, `inRecord`, `leftOut`, `next`                                                                                                                                                                           |
| `list_runs(workspace? \| flowId?, status?, mode?, limit = 20, cursor?)`                                               | the runs, newest first: for real (with the runs they queued) and the user's own test runs (only the latest per flow, for a day); `next` is the following page's cursor                                                                                                                                                                                         |
| `pin_from_run(flowId, nodeId, runId, port?, subRunId?)`                                                               | the token's user's pinned output of the component becomes what went out of it in that run (as the editor's Pin output; the draft does not change, nobody else sees it); with `subRunId`, from a call another flow's run made to this flow                                                                                                                      |
| `unpin(flowId, nodeId)`                                                                                               | takes the token's user's pinned output off a component (or a list of them), as the editor's Unpin output; one without a pin comes back in `notPinned`, one not in the draft in `notFound`                                                                                                                                                                      |

Resources: `flowtinus://catalog`, `flowtinus://components/{type}`, `flowtinus://connections`, `flowtinus://docs/flow-format`,
`flowtinus://flows/{flowId}` (the draft as YAML). Prompts: `build-flow(description, projectId?)` and `debug-run(run)`,
which walk an agent through the loop catalog → write → `validate_flow` → `save_draft` → `test_run` → fix.

**Git sync: the user's current branch.** In a workspace with git on, every tool reads and writes the branch the token's
user is on in the editor (their current branch, kept on the server): a flow or project that exists only on that branch is
found by its id, a save is an uncommitted change there, and `test_run` runs that branch's flow, called flows and scripts.
There are no branch or commit tools: the user picks, creates and commits branches in the editor. Where the current branch
cannot be edited (the environment's branch of a `pull-request` server, another user's `users/…` branch, a work branch of a
`protected` server, whose environment's branch is as step 2 left it) `save_draft`, `create_flow`, `create_folder`, `create_project`, `rename_flow`, `move_flow`,
`archive_flow` and `save_script` refuse (`conflict`), saying to pick or create a branch in the editor; reading, pins and
runs still work.

**Flows that call flows.** A test run's Flow Invoker calls the other flow's **draft**, so an agent that splits a process
into flows A → B saves B, then tests A: nothing has to be deployed. Deploying stays a person's decision in the editor.

## Actions that need the user's explicit approval

`run_for_real` (writes to databases, sends POSTs) and `archive_flow` (undeploys a deployed flow) are only for when the user
said so in the conversation ("run it for real", "archive the flow X"). For `run_for_real` that can be one flow or a
standing approval for any flow ("you can run any flow you want for real"), valid for the rest of the
conversation until the user withdraws or narrows it; `archive_flow` always needs one for that flow. Three layers, from
soft to hard:

1. **The descriptions and the server's instructions** tell the agent to call them only after an explicit approval, and
   otherwise to ask or to say that it needs one. A description is guidance: a model may still ignore it.
2. **`userApproval`**: the user's message that authorized it, quoted word for word. Without it the call is refused (for
   `run_for_real`, unless the token's run scope covers the flow, below). The server cannot tell whether the words are
   really the user's, but the agent has to point at a message, and the server logs it with the run or the flow
   (`MCP run_for_real: run … userApproval: "…"`).
3. **Their own scopes**, `runs:execute` and `flows:archive`: `runs:test` and `flows:write` are not enough. This is the hard
   switch: give a token those scopes only when its agent may run for real or archive at all; without them the tools answer
   `forbidden` whatever the agent says. The dev token has every scope.

**A token's run scope** (`run_for_real` only; `archive_flow` does not change). A token whose `runs:execute` is held to
some folders (each with its subfolders) or flows was approved for those when its owner made it, so the agent does not
stop to ask in the middle of the work:

- (a) a flow **in** the scope runs for real **without `userApproval`** (one given is only logged);
- (b) a flow **outside** it is refused by the server (`forbidden`, naming what the token may run), with or without
  `userApproval`; and a flow that a flow in the scope calls (a Flow Invoker) outside it cannot be called in that run:
  each call to it is an error of the envelope (`it is outside what the token that started this run may run for real`);
- (c) a token **without** a run scope (every token made before) works as before: `userApproval` is required every time.

The check is in the server (`features/api-tokens/run-scope.ts`, `StartRunHandler`), not in the description.

## How it works

- `POST /mcp`, Streamable HTTP, **stateless**: one MCP server per request, JSON answers (no SSE stream; `GET` is 405).
  Route: `flowtinus.server/api/routes/mcp.routes.ts`; server: `flowtinus.server/features/mcp/mcp-server.ts`; one file per tool in `features/mcp/tools/` (listed in `tools/index.ts`).
- Every tool calls the same use case handlers as the editor's API (`features/*`), as the token's user, in the workspace of the call (`features/mcp/workspace-of-call.ts`) with the user's role there.
- The catalog comes from the core's declarations (`buildCatalog()`, `@flowtinus/core`); the same JSON generates
  [the component docs](../components/README.md), [the flow format](../flow-format.md) and `llms.txt` / `llms-full.txt`
  (`bun run docs`; CI fails when they drift).
- <a id="a-runs-answer"></a>**A run's answer** (`test_run`, `run_for_real`, `get_run`; [ADR 0001](../adr/0001-mcp-run-answer-depends-on-outcome.md)):
  a **clean run** (status `completed`, no envelope in error in any component or call it waited for: none let through by
  `onError: continue`, none diverted by `onError: divert`, every call it waited for `completed`) answers its **run result**: `runId`, `flowId` (with `subRunPath` and the called `flow` for a sub-run),
  `status`, `durationMs`, `output` (up to `sample` of the envelopes that reached the End, shrunk as below, counted in
  `shrunk`), `outputCount` (all that reached it: `get_run_output` on the End pages them), `writes` summed per table over
  the whole run and its calls (empty in a test run) and `logs`, the warnings and errors the user's components wrote (`warning
(Script): …`, up to 10). Any other run (`failed`, `cancelled`, `with-warnings`, `with-errors`, still `running` or
  `queued`) answers its **run summary**: `flowId`, `mode`, `editorUrl` and, per component, envelopes in/out per port,
  errors, `writes`, a Flow Invoker's `subRuns` and up to `sample` envelopes (`run_for_real` adds `userApproval` or
  `approvedBy`). `detail: "result" | "summary"` forces either one. The sum flow (Start → `a + b` → End) answers
  `{"runId":"…","flowId":"…","status":"completed","durationMs":1,"output":[{"soma":42}],"outputCount":1}`.
- Limits: a flow file in or out up to 512 KB; `test_run` waits up to 600 s (120 by default); summaries hold at most 10
  envelopes per component and port, each up to 12 KB: a larger one is **shrunk, still valid JSON** (long lists keep their
  first items and end with `"…+N items"`, texts their start and `"…+N chars"`, objects their first keys and
  `"…": "+N keys"`), counted in the component's `shrunk`; `get_run_output` gives the envelopes whole (a run's record keeps
  the first 50 per port, up to 1 MB per component, 10 MB for the End; a called flow's record 5 per port), a page of up to
  50 envelopes and 256 KB.
- A summary's component also carries what a database component wrote, per table (`writes`: inserted, updated, deleted,
  affected, batches, failed; an Execute's under `sql`; nothing in a test run), and a Flow Invoker's calls (`subRuns`: id,
  flow, status, durationMs, envelopesAtEnd, firstError, fireAndForget; up to 20 listed). A fire and forget call of a run
  for real is a run of its own: `get_run` with its id as `runId`.
- An error a component threw again with another's as its `cause` (a TypeScript's `rethrow($input.wait.firstError)`)
  reads `"Report" ← "Insert": message` in the run's `error` (see [06 · The engine](../runtime/06-engine-envelopes.md)).
- Links: `EDITOR_URL` (DEV: `http://localhost:5180`) makes the answers carry `editorUrl`; without it, `editorPath`.
- After pulling a change to the components, rebuild what runs them (`docker compose --profile server up -d --build`):
  the catalog an agent reads is the API's, and the test runs are the supervisors'.
- No rate limiting in v1 (local or trusted use). Put the API behind a proxy that limits `/mcp` before exposing it.
