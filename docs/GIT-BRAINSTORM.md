# Git sync: brainstorm

Where the discussion on git sync stands. Not a spec: it records what was decided, why, and what is still open, so the spec and its tickets can be written from it.

Status: first round. This branch (`feature/git-sync-prototype`) is the base for a second round of refinement, after the mock of the screens and the git simulation are reviewed. Nothing here is to be implemented or published to the issue tracker before that round.

## Goal

Flow definitions live only in Postgres today. With git sync on:

- a user can work on a branch of their own in the editor;
- a commit made straight in git reaches the server;
- flows are promoted between environments that are different servers, following a configurable path (for example DEV to STAGING, STAGING to PREVIEW or SANDBOX), where an environment can be protected.

All of it sits behind a setting. With no git configured, the app behaves as it does today.

## Where the code is today

- `flows.draft_definition`: one draft per flow, with a revision; a concurrent save is refused (409).
- `flow_versions`: immutable versions, with `content_hash` and `received_from`. `deployments` holds the deployed one, `deployment_history` its changes (the `promote` action and `source_env` already exist).
- `promotions` (a package sent between instances) is only a table and `.keep` folders: no code.
- A flow file names secrets and variables by name and scripts by path, but connections and called flows by id.
- Scripts are the project's and are not frozen: a change applies at once to every deployed flow. `script_blobs` holds content by hash, and each run keeps a snapshot of the scripts it used.
- There is no feature flag system. `workspace_settings` is a key/value table.

## Decisions

### One repo, one branch per environment

- One repository, with one folder per workspace.
- Each environment is a branch (`dev`, `staging`, `prod`; the names are configurable). A server knows its own branch, whether it can be edited directly, and which branches it may promote to.
- The topology is each server's configuration, not a file in the repo: a versioned file would have one copy per branch and would be promoted with the flows.
- The provider enforces the rules (protected branches, reviewers). Protection is the job of each environment's manager.

Considered and dropped: one repo with a single `main` and a moving ref per environment; one repo per environment (works only if the repos share history, and makes every promotion a cross-repo operation).

### Git holds what exists, the environment holds the values

| Item             | In git (promoted)                                                | In the environment (Postgres)            |
| ---------------- | ---------------------------------------------------------------- | ---------------------------------------- |
| Flow             | the flow file, with its id and a `deployed` field                | runs                                     |
| Script           | the file                                                         | nothing                                  |
| Connection       | id, name, type                                                   | config and credentials                   |
| Schedule         | id, flow, name; cron, timezone, parameters and input as defaults | an override of any of those, and enabled |
| Webhook          | id, flow, name, response mode                                    | token, and enabled                       |
| Secret, variable | the name only, as the flows read it                              | the value                                |

- What arrives by promotion starts off or incomplete: a new schedule is disabled until someone in that environment reviews and enables it; a new connection shows as not configured (the engine already treats a missing connection as a warning).
- A local override never goes back to git.
- Connection ids stay in the flow file, so the engine does not change.

### Merging into the environment's branch is the deploy

- When the environment's branch moves (a merged PR or a direct commit), the server reconciles git into Postgres in one transaction: a new `flow_versions` row (with the commit sha) for each flow whose content changed, `deployments` pointed at it, `deployment_history` written, and the environment's deployed set of scripts updated.
- Schedules and webhooks keep reading `deployments`. Nothing changes for them.
- The Deploy button goes away in this mode. A flow that is in git but must not run has `deployed: false` in its file, so an undeploy is a commit too and is promoted.
- Scripts become versioned: triggers resolve them from the environment's deployed set, the editor's Run from the working copy.

### Promotion

- Two hops: the user's branch into the environment's branch (PR), then one environment into the next (promotion PR).
- A promotion carries everything committed up to a commit. Drafts never go.
- To promote a commit that is not the tip, the app creates `promote/<source>-<sha>` and opens the PR from it.
- PRs are opened on the provider; approving inside the app comes later.
- A promotion PR is never squashed or rebased: only a merge commit or a fast-forward. A squash breaks ancestry and every later promotion conflicts on the same files.
- A commit on an environment that did not come from a promotion (a hotfix in `prod`) marks that environment as ahead of its source, and the app offers a backport PR. Not automatic.

### The editor as a small source control client

A branch picker above the canvas, next to the worker choice, and a changes panel. Five actions:

1. Switch or create a branch (`users/<slug>/<name>`, cut from the environment's branch).
2. See the changes: flows, scripts and the manifest, with a diff.
3. Commit: a message and which files go in.
4. Update: shows how many commits behind, and merges the environment's branch into the current one. On a conflict, mine or theirs per file.
5. Open a PR to the environment's branch.

Out: stash, rebase, a history graph, a visual merge editor.

- The working copy (uncommitted changes) lives in Postgres and belongs to the branch, not to the user. On a user's branch only that user writes. On the environment's branch it is shared, as the draft is today.
- The configuration says whether an environment accepts direct edits or only a branch and a PR.
- A new connection exists in the environment as soon as it is created; only its declaration is a change of the branch. Discarding the branch leaves an unused connection behind.

### Generic git

- Plain git protocol (clone, fetch, push) with polling: works with any server.
- One generic webhook endpoint that ignores the payload and triggers a fetch.
- A provider adapter only to open a PR, GitLab first. Without one, the app pushes the branch and shows the link.

### The repo layout

```
<workspace slug>/
  workspace.yaml            # declared connections: id, name, type
  <project name>/
    project.yaml            # id, description, icon, color
    flows/
      <folder name>/
        <flow name>.yaml
    scripts/
      <script path>
```

- A path is the name itself, not a slug: a renamed flow is found in the repo under its new name. A rename is a file move in git.
- So a name of a project, folder, flow or script must be a valid file name everywhere: none of `\ / : * ? " < > |` or control characters, no leading or trailing space, no trailing dot, not a name Windows reserves (`CON`, `PRN`, `AUX`, `NUL`, `COM1`…, `LPT1`…), not `.` or `..`. One rule in the core, checked by the editor and the server, git on or off.
- Names are already unique among siblings whatever the case, which is what a case-insensitive file system needs. They are written in NFC.
- A flow file is the core's `flowToYaml`, with the flow's id, without the pinned outputs (test data, which stays in Postgres), with the canvas positions and groups. Nodes, edges and config keys are written in a stable order, so a save that changes nothing gives no diff.
- A folder is identified by its path. An empty one is kept with a `.gitkeep`.
- The app was never published, so no existing name needs handling.
- Schedules and webhooks are not in step 1.

Considered and dropped: a stored slug per project, folder and flow (a rename would not move the file, but the file would no longer be found by the flow's name).

### The setting

A `git` key in `workspace_settings`: repo, the server's branch, whether it is editable, credentials, and the branches it may promote to. Absent: today's behavior.

## Findings of the git simulation (for the second round)

Nine scenarios run with real git (2.54) on fake flows written by the core's `flowToYaml`, in a local repo: `git merge --no-ff` for a merged PR, `--squash` for a squashed one. GitLab's server-side merge was not tested and may differ. Nothing below is decided: each point is a question for the second round.

Held up:

- One branch per environment with merge commits or fast-forwards: three rounds of promotion stayed clean, and ancestry (`git log staging..dev`) says what is not promoted yet.
- `promote/<source>-<sha>` for a commit that is not the tip, then the tip later: clean.
- A backport by merge: the next promotion is clean and the trees end identical.
- The stable order (nodes by id, edges by source and target, config keys a to z). Two branches each adding a node conflicted in 13 to 18% of 150 random trials with sorted nodes, and in all 150 with nodes in insertion order.
- Canvas positions inside the node: moving every node did not conflict with a config or label change to the same nodes.
- A rename as a file move: git followed it, even with a heavy rework in the same branch.

Broke:

1. **"Mine or theirs" per file loses merged work in silence.** One conflicting SQL line, "mine" for the whole file, and the 12 changes a teammate had already merged were gone (11 of them never conflicted); the PR then merged cleanly. Resolved per hunk, 11 of 12 and 3 of 3 were kept. On `workspace.yaml`, "mine" dropped the other side's connection while keeping the flow that uses it.
2. **A squashed promotion can also merge cleanly to the wrong content**, not only conflict: a node deleted in dev stayed in staging and prod, in a flow that is still valid. The app cannot control the provider's merge method, so it would have to check after a promotion that the source's tip is an ancestor of the target.
3. **Git merges cleanly into a workspace that is not valid.** An edge to a deleted node, a call to a renamed script, a connection no longer declared, a Flow Invoker calling a deleted flow: all exit 0, each branch valid on its own. Only the first is caught by `validateFlowFile`; the others need the whole tree. The design has no validation step before the reconcile deploys, nor says what happens when it fails.
4. **A hotfix not back-ported** makes the next promotion conflict inside the protected branch when dev touched the same line, and otherwise leaves the environments different with nothing saying so. A promotion cannot conflict when the target is contained in the source: should the backport block the promotion instead of being offered?
5. **"Ahead of its source" cannot be a commit count**: promotion merge commits count too (3 after three clean rounds), and a hotfix back-ported by cherry-pick is flagged forever. What was right in every case: would merging the environment into its source change the source's tree (`git merge-tree --write-tree`)? A backport by cherry-pick or squash has the same problems as a squashed promotion.
6. **Git's rename detection is not a flow's identity.** A flow deleted and an unrelated one added in the same branch were read as a rename (70% similar as text), and another branch's edit of the deleted flow became a conflict inside the unrelated one. The reconcile has to match flows by the `id` in the file and refuse a tree where one id is in two files.
7. **Connections as a list in `workspace.yaml` conflict** whenever two branches each add one (150 of 150 appended; 17 to 49 of 150 sorted by id, as a list or as a map). One file per connection did not. Schedules and webhooks will be lists of the same kind.
8. **A folder renamed while another branch adds a flow in it** depends on `merge.directoryRenames`: git's default raises a "file location" conflict, `true` moves the new flow along, `false` brings the old folder back. Wherever the app merges, it has to set it. That conflict and a rename/rename one (both branches rename the same flow) are not "both edited one file": the conflict screen needs a way out for them.
9. **A flow's name is in two places** (the file name and `name:` in the file). A move made by hand in git leaves them different: which one wins, or `name:` stays out of the git file.

## Findings of the mock of the screens (for the second round)

A clickable prototype with mocked data only, in the editor under `src/pages/prototype-git-sync` (dev builds only): `bun run editor`, then `/prototype/git-sync` (`?variant=A`: branch picker and changes in the top bar; `?variant=B`: in the sidebar, with a Source control page). Its bottom bar switches the server it runs as (DEV, STAGING, PROD, SANDBOX) and the user, simulates another user's change or a push straight in git, shows the raw state and resets it. Webhooks are not in it. Nothing below is decided.

Decided on seeing it:

- Layout B (branch picker in the sidebar, a Source control page) is the preferred one. A stays in the mock for now.
- Creating a branch takes the uncommitted changes along to the new branch, as `git switch -c` does: they leave the branch they were on.
- A user's branch can be cut from any branch, another user's included, not only from the environment's.
- Switching to another branch does not take the uncommitted changes along, unlike git: each branch keeps its own working copy, so a switch is never refused and there is no need for a stash. Only creating a branch takes them. Moving changes to a branch that already exists would be an action of its own, if it is ever needed.
- Update exists only on a user's own branch. On an environment's branch it would be a merge of one environment into another: a promotion without a PR.
- On the canvas the branch is picked inside the Changes drawer; the canvas toolbar has no branch picker of its own.

- On the canvas, Changes always opens the drawer (in both layouts), and the drawer is wide enough for a diff.
- The commits to promote are shown as a graph (dots and lines, as Sourcetree does), not a flat list: with merges, a commit lower in the list is not always contained in one above it. Choosing a commit dims what stays behind. Only a commit the environment's branch was at (its first-parent line) can be chosen; one that came in through a merge goes with that merge. That last rule is the mock's, to confirm.

- The Environments page follows a redesign the maintainer brought from v0.dev: a promotion pipeline of cards (branch, reconciled commit, source with behind and ahead counts, backport), a promote panel (one tab per edge, the commit graph, the selection's size, pre-flight checks, the impact on the target's flows), a "what runs where" table that marks what differs from the server one is on, then pull requests and activity. The pre-flight shows only what the mock can work out (conflicts, a target ahead of its source, connections not configured, schedules arriving disabled, direct pushes, drafts left behind); the "CI green" line of the redesign has nothing behind it in the design and was left out. The pipeline shows every edge, but the promote panel only has the edges that leave the server one is on: a server promotes to its own next environments, never on behalf of another.

The first two raise a question the mock does not answer: the environment's branch has one working copy shared by everyone, so creating a branch from it takes the other users' pending changes along too. And a branch cut from another user's branch still opens its PR to the environment's branch, carrying that user's commits.

What building and clicking it turned up:

1. **A backport that conflicts has no way to be resolved.** Update merges the environment's branch into the user's branch; for a backport that would merge the source into the later environment and bring unpromoted work. A `backport/<env>-<sha>` branch cut from the target, where the conflict is resolved?
2. **A promotion PR opened from the environment's branch keeps growing**: commits that land after it was opened join it. "Everything up to a commit" only holds from a `promote/<source>-<sha>` branch. Always create one, for the tip too?
3. **A server does not know its source.** It stores only where it promotes to, but "ahead of its source" and the graph need who promotes to it. A "receives from" in the configuration, or the topology worked out from somewhere shared?
4. **`promotesTo` lists branches, the screens want to say PROD.** A label per target, or branch names only?
5. **A working copy belongs to a server, not to the repo.** A user's branch opened on another server has another working copy there, and nothing records which environment's branch it was cut from (opened on PROD's server, its PR would go to prod).
6. **The shared working copy of the environment's branch can undo a merged PR.** A pending edit to a file stays on top when a PR that changes the same file is merged; the next direct commit reverts the PR's change. Today's draft refuses a concurrent save by its revision; the design has nothing like it (a base sha per file of the working copy?).
7. **There is no Discard** among the five actions, and Update needs a rule for uncommitted changes to files it brings. The mock added Discard per file and refuses the Update in that case.
8. **A merged user branch stays "behind" for ever.** Delete it on merge, offer to, or hide merged branches?
9. **After a backport, "to promote" counts merge commits that change nothing**, and a version number differs between environments for the same content (v3 in DEV, v2 in STAGING). Count changed files, and show the commit sha as what the environments share?
10. **A new schedule also "arrives" by the reconcile in the environment where it was written**, so it starts disabled there too. Enabled where its commit was made? How does the server tell?
11. **A new connection on a branch the user cannot write** (a protected environment): it should exist at once, but its declaration has nowhere to go. The mock refuses it.
12. **Names that collide with the layout's own files**: a project named `workspace.yaml`, a folder `X.yaml` beside a flow `X`; `nul.txt` is reserved even with an extension; a script's path needs the rule on each segment.
13. **Renaming a script changes every flow that calls it** (they name it by path): more changed files in the same commit.
14. **"Direct edits allowed" with a branch the provider protects** is a contradiction the app can only see by testing the access.
15. **Turning git on where drafts exist, or naming a branch that does not exist**: the mock drops the drafts and creates the branch, both guesses.

Assumed in the mock, to confirm: schedules inside the flow's file; changing `deployed` makes no new version; a new flow starts with `deployed: false`; the flow's name only in its path.

## Open

- The GitLab adapter.
- Emergency rollback from the app: it would have to produce a revert commit, or the environment differs from git.
- What the existing `promotions` table and folders become.

## Step 1

The smallest piece everything else stands on, with Postgres still the source of truth and one branch only:

1. The `git` setting in `workspace_settings`.
2. The canonical repo layout.
3. An export to the server's branch on every deploy.
4. The reconcile from git into Postgres, tested by round trip: export, import, same state.

No user branches and no promotion yet.

### Tickets (draft, not published)

Kept here only: nothing goes to the issue tracker before the mock of the screens is reviewed.

| #   | Ticket                           | Blocked by | What it delivers                                                                                                                                                            |
| --- | -------------------------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Names valid as file names        | none       | A project, folder, flow or script refuses an invalid name, with the same rule in the editor and on the server                                                               |
| 2   | A workspace's git configuration  | none       | An admin gives the repo, the branch and the credential; the server tests the access and shows the result. With none, everything as today                                    |
| 3   | A flow's deploy becomes a commit | 1, 2       | On deploy, the flow's file is on the branch, at the path its name gives, as YAML in a stable order and without the pinned outputs                                           |
| 4   | The whole workspace exported     | 3          | `project.yaml`, folders, scripts and `workspace.yaml` go to the repo; a rename, move, archive or undeploy moves or removes the files; turning git on makes the first export |
| 5   | Reconcile from git into Postgres | 4          | An empty workspace pointed at the repo gets its projects, folders, flows (with a version and a deploy) and scripts; exporting again gives the same tree                     |

Assumed:

- The configuration names a workspace secret that holds the token. HTTP(S) only; SSH later.
- A commit's author is the name and email of the user who did the action.
- Tests run against a local git repository (`file://`) and Postgres, with no GitLab container. `omc-solutions/test` is for checking by hand.
- Reacting to a commit made straight in git (webhook or polling) is not in step 1: it calls the reconcile of ticket 5 and is the first ticket of step 2.

### Local test setup

A GitLab runs in the Compose project with `docker compose --profile git up -d gitlab`: http://localhost:8929 from the host, `http://gitlab:8929` from the other containers. The test repository for step 1 is `omc-solutions/test` there (private: it needs an access token with `read_repository` and `write_repository`).
