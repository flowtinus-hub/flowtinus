# Git sync: brainstorm

Where the discussion on git sync stands. Not a spec: it records what was decided and why, so the spec and its tickets can be written from it.

Status: third round. The four points the second round's prototype turned up are decided below (the backport now goes one hop at a time, after a tenth simulation scenario), and the prototype follows them. A pass on the local mode followed, with an eleventh scenario run on Windows: "Local mode" records what it showed and what was decided from it. Step 1 is published as a spec and tickets (see "Step 1"); the later steps stay here until the maintainer says otherwise.

## Goal

Flow definitions live only in Postgres today. With git sync on:

- a user can work on a branch of their own in the editor;
- a commit made straight in git reaches the server;
- flows are promoted between environments that are different servers, following a configurable path (for example DEV to STAGING, STAGING to PREVIEW or SANDBOX), where an environment can be protected.

All of it sits behind a setting. With no git configured, the app behaves as it does today.

Later, and the reason the repo is shaped the way it is: a VS Code extension that renders and edits flows and scripts, creates folders and so on, and a Flowtinus running locally in Docker, so that a developer works the way they do today. They run the app locally, create their branches, test locally, push to the remote, and merge there into the environments' branches; a protected environment only takes pull requests. Nothing of that is built now, but the repo has to be as git friendly as possible so it fits later without changing the format.

## Where the code is today

- `flows.draft_definition`: one draft per flow, with a revision; a concurrent save is refused (409).
- `flow_versions`: immutable versions, with `content_hash` and `received_from`. `deployments` holds the deployed one, `deployment_history` its changes (the `promote` action and `source_env` already exist).
- `promotions` (a package sent between instances) is only a table and `.keep` folders under `flowtinus.server/features/promotions`: no code.
- A flow file names secrets and variables by name and scripts by path, but connections and called flows by id.
- Scripts are the project's and are not frozen: a change applies at once to every deployed flow. `script_blobs` holds content by hash, and each run keeps a snapshot of the scripts it used.
- There is no feature flag system. `workspace_settings` is a key/value table.

## Principles

The repo is a public format, written by the app, by hand, or by another tool (the future extension, a script, a merge). Four rules follow, and the decisions below apply them:

1. Any valid tree is accepted, in any order and formatting. The server never rewrites a branch to normalize it. The stable order is what the app writes, not what it requires to read.
2. The tree explains itself: nothing outside the repo is needed to read it. A name is in the path, an identity (`id`) is in the file.
3. The app copes with branches it did not create, of any name.
4. The format is a contract: it carries a version, and the core publishes a JSON Schema of its files.

## Environments and topology

- One repository, with one folder per workspace. Each environment is a branch (`dev`, `staging`, `prod`; the names are free).
- The topology is a file in the repo, on a branch of its own that is not part of the pipeline (for example `flowtinus/config`). For each environment it gives a label (`PROD`), the branch, the environments it promotes to, and a mode. Every server reads the same file in the same fetch it already does, and a change to the topology is a commit, protected by the provider like any other.
- A server's own configuration (a `git` key in `workspace_settings`) keeps only the repo, the workspace secret that holds the token, and which environment the server is. Absent: today's behavior.
- The topology is a tree: an environment has one source at most and may promote to several. A topology where an environment has two sources is refused.
- An environment's mode:

| Mode           | Who writes to its branch                                                  |
| -------------- | ------------------------------------------------------------------------- |
| `direct`       | edits straight in the editor (the shared working copy), and pull requests |
| `pull-request` | only pull requests from work branches                                     |
| `protected`    | only promotion and hotfix pull requests                                   |

- The provider enforces the rules (protected branches, reviewers); the mode says what the app offers. Where they disagree, see "Turning git on".

Considered and dropped: one repo with a single `main` and a moving ref per environment; one repo per environment (works only if the repos share history, and makes every promotion a cross-repo operation); the topology in each server's configuration (each server sees only its neighbours, and nothing catches two servers that disagree); a topology file inside the pipeline's branches (one copy per branch, promoted with the flows).

## Git holds what exists, the environment holds the values

| Item             | In git (promoted)                                                              | In the environment (Postgres)            |
| ---------------- | ------------------------------------------------------------------------------ | ---------------------------------------- |
| Flow             | the flow file, with its id and an optional `deployed` field                    | runs, pinned outputs                     |
| Script           | the file                                                                       | nothing                                  |
| Connection       | its file: id and type, the name in the path                                    | config and credentials                   |
| Schedule         | in the flow's file: id, name; cron, timezone, parameters and input as defaults | an override of any of those, and enabled |
| Webhook          | in the flow's file: id, name, response mode                                    | token, and enabled                       |
| Secret, variable | the name only, as the flows read it                                            | the value                                |

- What arrives by the reconcile starts off or incomplete, everywhere, including the environment where it was written: a new schedule or webhook is disabled until someone in that environment enables it (a webhook's token is made when it is enabled); a new connection shows as not configured (the engine already treats a missing connection as a warning). The editor says so on a new schedule, and the environment lists what arrived disabled.
- A local override never goes back to git.
- Connection ids stay in the flow file, so the engine does not change.
- A new connection exists in the environment as soon as it is created; only its declaration is a change of the branch. Discarding the change leaves an unused connection behind. On a `protected` environment's server a connection can only be created inside a hotfix branch; anywhere else it is refused, pointing to the root environment, where it would arrive from as not configured. Configuring a declared connection is allowed everywhere.

## Merging into the environment's branch is the deploy

- When the environment's branch moves (a merged pull request or a direct commit), the server reconciles git into Postgres in one transaction: a new `flow_versions` row (with the commit sha) for each flow whose content changed, `deployments` pointed at it, `deployment_history` written, and the environment's deployed set of scripts updated.
- Schedules and webhooks keep reading `deployments`.
- The Deploy button goes away in this mode. `deployed` is optional in a flow's file and absent means `true`: a new flow runs once it is merged. The editor writes `deployed: false` on an undeploy, so an undeploy is a commit too and is promoted.
- A flow's content hash leaves out `deployed` and is taken over normalized line endings: changing only `deployed` makes no new version, only a deploy or an undeploy in `deployment_history`.
- Version numbers belong to each server (`v3` in DEV and `v2` in STAGING can be the same content). What the environments share, and what the screens compare, is the commit sha and the content hash.
- Scripts become versioned: triggers resolve them from the environment's deployed set, the editor's Run from the working copy.

### Validation and identity

- One validation of the whole tree, in the core. It runs in the editor before a commit, in the pre-flight of a pull request or a promotion (on the merge result the app works out), and in the reconcile as the last barrier. Later, the same function is a `flowtinus validate` command for CI and the extension.
- Git merges cleanly into trees that are not valid together, so the reconcile never applies an invalid tree. It refuses the commit whole: the environment stays on the last good commit and shows that git is at X, the deploy at Y, and why. The next commit is tried again. A protected environment can then differ from git until someone fixes it; that is preferred to running an invalid tree.
- Errors, which refuse the commit: YAML or schema not valid; an `id` missing or in two files; an edge to a node that does not exist; a call to a script or flow that does not exist; a connection referenced and not declared. Warnings, which apply: a declared connection not configured in this environment; a secret or variable with no value.
- A flow and a project are identified by the `id` in their file, never by git's rename detection (which read a deleted flow and an unrelated new one as a rename). The same `id` at another path is a rename. Whoever creates the file makes the `id` (the editor, the extension); the server never writes one back.
- A script and a folder are identified by their path. A renamed script is a delete and an add.
- A name lives only in the path: a flow's file has no `name:`. Renaming the file, in git or in VS Code, renames the flow; the same for a project, a folder and a connection.

### Emergency rollback

- The fix is a commit like any other: the app can open it as `hotfix/revert-<sha>`, reviewed and then back-ported.
- To stop the damage before that review, an environment can pin a flow: `deployments` goes back to a version that already ran in that environment, without git. It is written to `deployment_history`, shown on every screen as differing from git, and cleared when a commit changes that flow's content. It is the one way the deploy differs from git on purpose, and it is per flow only.

## Promotion

- Two hops: a work branch into the environment's branch (pull request), then one environment into the next (promotion pull request).
- A promotion carries everything committed up to a commit. Drafts and the working copy never go.
- Only a commit on the source's first-parent line can be chosen: one that came in through a merge was never a state of the source environment, and goes with its merge.
- Every promotion is opened from `promote/<source>-<sha>`, for the tip too, so the pull request stays what was chosen. A pull request opened from the environment's branch would grow with every later commit.
- A server promotes only along the edges that leave its own environment, never on behalf of another.
- A promotion pull request is never squashed or rebased: only a merge commit or a fast-forward. Where there is an adapter, it is opened with squash off, and the app refuses to open it on a project that forces squash. Squash matters only for promotions and backports: a change or hotfix pull request may be squashed, since its branch is removed on merge and nothing later depends on its ancestry.
- After the target's reconcile, the app checks that the promoted sha is an ancestor of the target. It needs no adapter: the promoted sha is in the `promote/<source>-<sha>` branch the app opened, so the app keeps the promotions it opened (a table of its own, part of the promotion step). If not (a squash or rebase on the provider), the target's lineage is broken: promotions into and out of it are blocked until a repair pull request, a commit whose parents are the target and the promoted sha and whose tree is the promoted sha's. That is the right content because a promotion only happens when the target is contained in its source (see below). The deploy follows git meanwhile.
- "To promote" shows the files that change (a tree diff), not a count of commits: a merge commit that changes nothing is not work to promote.

### Hotfix and backport

- A `protected` environment takes a hotfix as a pull request from `hotfix/<name>`, cut from its branch and reviewed like a promotion.
- An environment is ahead of its source when merging it into the source would change the source's tree (`git merge-tree --write-tree`). Not a count of commits: promotion merge commits would count, and a change back-ported by cherry-pick would be flagged for ever.
- While an environment is ahead of its source, the promotion from that source into it is blocked. So a promotion never conflicts inside a protected branch, and environments never differ in silence. A hotfix whose content the source already has (the same fix made upstream and promoted) leaves the environment not ahead, and nothing is blocked.
- The backport goes one hop at a time: from the environment into its source, by a pull request from `backport/<env>-<sha>` cut from the source's branch, opened on the source's server. Once it is merged, the source's edge into the environment unblocks at once, and the source is ahead of its own source in turn: the app offers the next hop, up to the root. A conflict is resolved in the backport branch, in the editor or with git locally, before the pull request; on a `protected` source the editor edits a backport branch as it does a hotfix branch.
- Each hop brings only the hotfix: the next promotion into the environment carries what its source already had, never the unpromoted work further up. Backporting straight to the root was dropped for this: the hotfix then reached the source only by a promotion from the root, which carried all of the root's pending work, ready or not (scenario 10 of the simulation).
- A backport is always a merge, never a cherry-pick or a squash, for the same reason as a promotion.
- The cost: a reviewed pull request in each protected branch on the way, and until a hop is merged, nothing is promoted into the environment it leaves. A second emergency there is a second hotfix.

## The editor as a small source control client

The screens are the prototype's, layout B: the branch picker in the sidebar and a Source control page; on the canvas, the branch is picked inside the Changes drawer, which is wide enough for a diff. Six actions:

1. Switch or create a branch.
2. See the changes: flows, scripts, connections and the manifest, with a diff.
3. Commit: a message and which files go in.
4. Discard: per file or all. A discarded rename goes back to the old path; a new connection stays in the environment, only its declaration goes.
5. Update (on a user's own branch only): shows how far behind and merges the environment's branch into the current one. Refused, as git does, while a file it brings has an uncommitted change: commit or discard it first.
6. Open a pull request to the environment's branch.

Out: stash, rebase, a visual merge editor beyond the conflict screen.

### Branches

The app tells a branch's kind by its name and the topology, with nothing stored:

| Branch                                    | Kind                                                                                                                                  |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| an environment's branch (in the topology) | environment                                                                                                                           |
| `promote/…`, `backport/…`, `hotfix/…`     | the app's own; not offered as work branches (on a `protected` server the picker shows only hotfix branches and the backports into it) |
| `users/<slug>/…`                          | a user's: only that user writes; the owner comes from the name                                                                        |
| any other (`fix/x`, pushed from a laptop) | a shared work branch: anyone may edit it, and its working copy works as the environment's does                                        |

- The app creates `users/<slug>/<name>`. A branch can be cut from any branch, another user's included. A pull request from a branch cut from another user's branch says that it includes N commits from that branch not yet in the environment; they leave the diff once that branch is merged.
- A pull request from a work branch goes to the environment of the server it is opened on. Only a `direct` or `pull-request` environment's server opens one; a `protected` environment's server opens only promotions and hotfixes, and its editor edits flows only inside a hotfix branch or a backport into it.
- Where there is an adapter, the app opens a pull request with "remove the source branch" on, and always for its own branches. Whatever the provider, the picker hides a branch that is contained in the environment's branch and has no uncommitted change, behind "show merged".
- A branch removed on the remote while this server has uncommitted changes on it: the changes are kept, marked as such, and the user either creates a branch with them or discards them.

### The working copy

- The working copy (uncommitted changes) lives in Postgres and belongs to a branch on one server. A branch opened on two servers has two working copies; uncommitted work does not travel, as with a checkout. On a user's branch only that user writes; on the environment's branch, and on a shared work branch, it is shared, as the draft is today.
- Each file of the working copy keeps the blob it was based on and who edited it last.
- When the branch moves under it (a merged pull request, a push), each changed file is merged three ways: base, what arrived, the pending edit. Clean: the base moves on, silently. A conflict: the file is marked and cannot be committed until it is resolved. It is today's revision check on a draft, per file, and it is what stops a pending edit from reverting a merged pull request.
- Creating a branch takes the uncommitted changes along to the new branch, as `git switch -c` does, and they leave the branch they were on. From an environment's or a shared branch it takes only the files whose last editor is the user creating it; from one's own branch, all of them.
- Switching to another branch does not take them: each branch keeps its own working copy, so a switch is never refused and there is no stash. Moving changes to a branch that already exists would be an action of its own, if it is ever needed.

### Conflicts

- A content conflict is resolved per hunk, never as "mine or theirs" for the whole file, which lost a teammate's merged work in silence. What did not conflict is already merged, as in git. Each conflicting hunk takes mine, theirs, both, or an edit. The result must parse and pass the validation before it can be committed. With nodes in a stable order a hunk is usually one node; a merge per node may come later.
- A conflict that is not about content is a choice between outcomes:

| Conflict                                     | Choice                        |
| -------------------------------------------- | ----------------------------- |
| both renamed the same flow                   | one of the two names          |
| one edited, the other deleted                | keep with the edit, or delete |
| both added the same path, with different ids | rename one                    |

- Wherever the app merges it sets `merge.directoryRenames=true`, so a flow added to a folder another branch renamed follows the folder instead of raising a conflict.
- The same screen resolves a working copy file marked by a moved branch, an Update, and a backport.
- Whoever works with git locally resolves conflicts with git.

### Environments page

The page follows the redesign in the prototype: a promotion pipeline of cards (branch, reconciled commit, source with behind and ahead, backport), a promote panel (one tab per edge that leaves this server, the commit graph, the selection's size, pre-flight checks, the impact on the target's flows), a "what runs where" table that marks what differs from this server, then pull requests and activity.

- The commits to promote are a graph (dots and lines), not a list. Choosing a commit dims what stays behind; only first-parent commits can be chosen.
- The pre-flight shows: the validation of the merge result; a target ahead of its source (which blocks); a broken lineage (which blocks); connections not configured; schedules and webhooks arriving disabled; drafts left behind.

## The repo layout

```
flowtinus/config branch:
  topology.yaml                        # environments: label, branch, promotesTo, mode
each environment's branch:
  .gitattributes                       # eol=lf, written on the first export
  <workspace slug>/
    workspace.yaml                     # format: 1
    connections/
      <connection name>.yaml           # id, type
    projects/
      <project name>/
        project.yaml                   # id, description, icon, color
        flows/
          <folder>/
            <flow name>.flow.yaml
        scripts/
          <script path>
```

- A path is the name itself, not a slug. A rename is a file move in git.
- So a name of a project, folder, flow, script segment or connection must be a valid file name everywhere: none of `\ / : * ? " < > |` or control characters, no leading or trailing space, no trailing dot, not `.` or `..`, not a name Windows reserves (`CON`, `PRN`, `AUX`, `NUL`, `COM1`…, `LPT1`…) even with an extension (`nul.txt`). A folder's name may not end in `.flow.yaml`. One rule in the core, checked by the editor and the server, git on or off.
- Projects sit under `projects/`, so no project name collides with the workspace's own files; flows end in `.flow.yaml`, so a folder `X` and a flow `X` never collide, and VS Code can tie the JSON Schema to `**/*.flow.yaml`.
- One file per connection: a list in `workspace.yaml` conflicted whenever two branches each added one, sorted or not; separate files did not.
- Schedules and webhooks live in their flow's file: they move and are deleted with it, and two branches adding one to the same flow at once is rare and an ordinary conflict.
- Names are unique among siblings whatever the case and after NFC normalization, which a case-insensitive file system and a name written in NFD by another tool need. They are written in NFC.
- A name and the whole path in the repo have a length limit, so a clone on Windows works without `core.longpaths` (see "Local mode").
- A flow file is the core's `flowToYaml`, with the flow's id, without its name and without the pinned outputs (test data, which stays in Postgres), with the canvas positions and groups. The app writes nodes by id, edges by source and target and config keys a to z, so a save that changes nothing gives no diff and two branches adding nodes rarely conflict (13 to 18% of trials sorted, against all of them in insertion order). Reading accepts any order.
- A folder is identified by its path. An empty one is kept with a `.gitkeep`.
- Renaming a script changes every flow that calls it, since flows name scripts by path: the editor does it as one change, in one commit; done by hand, the validation points at the flows left behind.
- The app was never published, so no existing name needs handling.

Considered and dropped: a stored slug per project, folder and flow (a rename would not move the file, but the file would no longer be found by the flow's name); an id per script (a `.py` has nowhere to keep one but a second file).

## Turning git on

- What happens depends on what each side has:

| The branch has the workspace | Postgres has flows | Result                                                                                                        |
| ---------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------- |
| no                           | either             | first export: what is deployed is the first commit                                                            |
| yes                          | no                 | import: the reconcile                                                                                         |
| yes                          | yes                | refused until an explicit choice, "git replaces the server" or "the server replaces git", each with a preview |

- A draft is an uncommitted change: each draft that differs from the deployed version becomes a file of the environment's working copy, with whoever saved it as its last editor. A `protected` environment has no working copy, so git cannot be turned on there while drafts exist; they are listed.
- A branch that does not exist is created only on confirmation: empty for the root, from its source's tip otherwise, which the screen says is a promotion of everything. The topology branch is created the same way, by the first admin, from the app.
- The access test proves reading and writing (it pushes a throwaway branch), not a given branch's protection, and the screen says so. With an adapter, the app reads the branches' protection and shows where it disagrees with the topology's modes. Without one, the disagreement shows at the first refused push: the changes stay in the working copy, the message names both sides, and the user can create a branch with them.

## Generic git

- Plain git protocol (clone, fetch, push) with polling: works with any server. HTTP(S) with a token first; SSH later.
- One generic webhook endpoint that ignores the payload and triggers a fetch.
- A provider adapter for what plain git cannot do: open a pull request (squash off, remove the source branch), read the project's merge settings, read the branches' protection, read a pull request's state. GitLab first, GitHub next. It uses the same workspace secret. Without one, the app pushes the branch and shows the link, and the checks that need the provider happen after the fact.
- Pull requests are approved on the provider; approving inside the app comes later.

## Local mode

Not built now, but the format has to fit it. A developer clones the repo, runs Flowtinus in Docker, edits in the app, in VS Code (by hand or with the future extension) or with any tool, and uses git themself: branches, commits, pushes, pull requests on the provider.

- The local server reads the files on disk, the developer's working tree, not a branch: the disk is its working copy. It never commits, pushes or switches a branch; git is the developer's. It is no environment of the topology, promotes nothing and opens no pull request.
- It reconciles the tree as a whole, as a server does on a commit: an invalid tree is refused whole and the last good one keeps running, so a checkout or a merge with conflict markers half written never runs. The editor writes into the same files.
- Connection configs, credentials, secrets and variables are the local server's own, in its own Postgres, as in any environment. A schedule arrives disabled there too, so a clone never fires a production cron.

What scenario 11 showed, with git 2.54 on Windows (NTFS, case-insensitive, `core.autocrlf=true` as Git for Windows installs it):

1. **The app's writer and hand edits.** A file edited by hand (a comment above a SQL block, a node appended last in flow style) reads fine. The app's next save of one change rewrites it into the stable order: 10 lines added and 7 removed for a one-line move, the comment dropped in silence. A hand edit of the same node on another branch then conflicts with that rewrite. Between files every writer keeps in the stable order such conflicts are rare (scenario 4), so the question is how hand-written files get there.
2. **A case-only rename by the file system is invisible to git** on a case-insensitive disk (`core.ignorecase=true`): `Load orders` renamed to `Load Orders` in the explorer, then `git add -A`, gives nothing to commit. The local server would read the new name from disk while git and every other server keep the old one, and no validation can see it. `git mv` records it, and the rename then merges cleanly into a branch that edited the file.
3. **Case and Unicode duplicates merge cleanly.** A branch from a Linux clone with `flows/sales/` merged with `flows/Sales/` gives both folders in the tree and one on this disk; a name in NFC and the same name in NFD (as some macOS tools write it) give two entries in the tree and two files here. Git says nothing in either case: only the validation catches them, so it compares names whatever the case and after NFC normalization.
4. **Long paths break on Windows.** A reasonable folder, subfolder and flow name made a 197-character path in the repo, 279 in a clone under a user's folder. Without `core.longpaths`, `git add` does not stage it and a clone fails with "Filename too long"; with it, both work. Git for Windows leaves it off by default.
5. **Line endings hold with `.gitattributes`.** Without it, a clone with `core.autocrlf=true` has CRLF on disk; the content hash is the same either way, but the app writing LF over the file leaves git listing it as modified with an empty diff. With `* text=auto eol=lf` the disk has LF and the status stays clean.

What follows, decided in the third round:

- **The format is canonical, as `gofmt`.** Every writer (the app, the extension, a `flowtinus fmt` command next to `flowtinus validate`) writes the stable order, so a hand-edited file reaches it at its next save or format and diffs stay small after that. Reading still accepts any order (principle 1). Comments are not part of the format: a node's `notes` holds what a comment would. The validation warns on a comment in a flow file, which the next save drops.
- **Paths have a length limit**, one rule in the core with the other name rules, git on or off: a length per name and for the whole path in the repo, sized so a clone under a user's folder on Windows stays under 260 characters without `core.longpaths` (about 150 for the path in the repo is the starting point; the values are set in the ticket). It also spares the other tools that still trip on long paths on Windows.
- **References stay by id.** A flow names a connection and a called flow by id: rename-safe across branches, and the extension shows the names and completes the ids. Scripts stay by path.
- **A file without an `id` stays an error**, and the error gives a fresh id to paste. The extension and a `flowtinus new` command write one; nothing writes into a developer's files.
- The extension renames with `git mv`, and the local server warns when a file's name on disk differs only in case from the name in git's index (finding 2).
- The validation compares names whatever the case and after NFC normalization (finding 3), and warns when the repo has no `.gitattributes` (finding 5).

## Evidence

Eleven scenarios run with real git (2.54) on fake flows written by the core's `flowToYaml`, in a local repo, with `git merge --no-ff` for a merged pull request and `--squash` for a squashed one; GitLab's server-side merge was not tested. Most of the rules above on promotion, backport, identity, conflicts and file granularity come from what broke there; scenario 11, the local mode, runs on the machine it is run on and was run on Windows. The script and its evidence are in `docs/git-sync-simulation/`: `sim.ts` (run `bun sim.ts` in that folder, about 90 seconds; `bun sim.ts 5` runs one scenario; it rebuilds `repos/` there, which git ignores, and rewrites `out/`), `out/results.md` (every command, output and conflict hunk) and `out/summary.json`. Temporary: delete the folder, and this paragraph, once git sync is implemented.

The clickable prototype, with mocked data only, is in the editor under `src/pages/prototype-git-sync` (dev builds only): `bun run editor`, then `/prototype/git-sync?variant=B`. Its bottom bar switches the server it runs as and the user, simulates another user's change or a push straight in git, shows the raw state and resets it. It is the reference for the screens and follows the decisions above: the layout, the topology on `flowtinus/config` (edited in Settings), the three modes, hotfix branches on a protected server, the backport one hop at a time, the block on a promotion while the target is ahead, the lineage check and its repair (squash a promotion on the mock provider to see it), the reconcile refusing an invalid tree (Simulate), the working copy's base and last editor with the three-way merge when its branch moves, the conflict screen per hunk, branches of any name (Simulate pushes one from a laptop), merged branches hidden, the emergency pin (Versions on the canvas), and the three cases of turning git on. It does not show webhooks, the GitHub adapter, the CLI, or the local mode.

## Step 1

The smallest piece everything else stands on. Postgres stays the source of truth and the Deploy button stays: git is a mirror of what is deployed, on one environment's branch, and the reconcile only imports into an empty workspace. That fixes the format, the validation and the configuration, which everything after builds on, without touching how a flow is edited or run.

No working copy, no user branches, no promotion, no schedules or webhooks in the files, no reacting to commits yet.

### Spec and tickets

Published: the spec is [#8](https://github.com/flowtinus-hub/flowtinus/issues/8), and its tickets are its sub-issues, with their blocking edges on GitHub. The spec and the tickets are the reference from here on; this section only points at them.

| Ticket                                                                                           | Blocked by |
| ------------------------------------------------------------------------------------------------ | ---------- |
| [#9](https://github.com/flowtinus-hub/flowtinus/issues/9) Names valid as file names              | none       |
| [#10](https://github.com/flowtinus-hub/flowtinus/issues/10) Drop the old promotions              | none       |
| [#11](https://github.com/flowtinus-hub/flowtinus/issues/11) A workspace's git configuration      | none       |
| [#12](https://github.com/flowtinus-hub/flowtinus/issues/12) The repo format in the core          | #9         |
| [#13](https://github.com/flowtinus-hub/flowtinus/issues/13) Validation of a whole workspace tree | #12        |
| [#14](https://github.com/flowtinus-hub/flowtinus/issues/14) A flow's deploy becomes a commit     | #11, #12   |
| [#15](https://github.com/flowtinus-hub/flowtinus/issues/15) The whole workspace exported         | #14        |
| [#16](https://github.com/flowtinus-hub/flowtinus/issues/16) Import a workspace from git          | #13, #15   |
| [#17](https://github.com/flowtinus-hub/flowtinus/issues/17) Turning git on                       | #16        |

Decided while writing the spec: the server runs the `git` binary (its image gains `git`), since later steps need `git merge-tree` and three-way merges; a failed push leaves the deploy standing, the environment shows git behind and why, and the next commit pushes what is pending; the server's git tests are integration tests against a `file://` repository, run by `bun run test`.

Assumed:

- HTTP(S) with a token only; SSH later.
- Drafts stay drafts: there is no working copy in step 1, so turning git on leaves them in Postgres as today. They become the working copy in the step that brings it.
- Tests run against a local git repository (`file://`) and Postgres, with no GitLab container. `omc-solutions/test` is for checking by hand.

### After step 1

In the order they depend on each other, to be cut into tickets when step 1 is done:

1. React to a commit (polling and the generic webhook) with the reconcile, the environment's branch becomes the source of truth and the Deploy button goes; scripts become versioned; the environment shows when git is ahead of its deploy and why.
2. The working copy and the editor's source control client: branches, changes, commit, discard, update, pull request, the three-way merge on a moved branch, the conflict screen; the environment modes.
3. Schedules and webhooks in the flow's file, arriving disabled.
4. Promotion: `promote/` branches, first-parent choice, the pre-flight, the table of the promotions the app opened, the lineage check and its repair; the Environments page.
5. Hotfix and the backport one hop at a time, and the block on promotion while the target is ahead.
6. The GitLab adapter, then GitHub.
7. The emergency pin.

### Local test setup

A GitLab runs in the Compose project with `docker compose --profile git up -d gitlab`: http://localhost:8929 from the host, `http://gitlab:8929` from the other containers. The test repository for step 1 is `omc-solutions/test` there (private: it needs an access token with `read_repository` and `write_repository`).
