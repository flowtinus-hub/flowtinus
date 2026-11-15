# 07 · Deploys

A flow has a **draft** and, once deployed, a **deployed version**. Deploying happens in the environment you are in (DEV,
QA...). Sending a version to another environment is a _promotion_, which does not exist yet.

| Who runs what                                                               | Draft | Deployed version |
| --------------------------------------------------------------------------- | :---: | :--------------: |
| The editor's Run (test run) and Run for real                                |  yes  |                  |
| Triggers: [schedules](09-schedules.md) and [webhooks](10-webhooks.md)       |       |       yes        |
| A Flow Invoker calling the flow, in a run of the editor (Run, Run for real) |  yes  |                  |
| A Flow Invoker calling the flow, in a run of a trigger                      |       |       yes        |

- **Deploy** (`POST /w/:ws/flows/:id/deploy`, Deploy in the canvas' tools) freezes the saved draft as a new immutable row
  of `flow_versions` (numbers 1, 2, 3... per flow) and points `deployments` (one row per flow) to it. Every change of
  what is deployed goes to `deployment_history` (`deploy`, `rollback`, `undeploy`, with who and when). A lock per flow
  keeps two deploys at once from taking the same number.
- **What counts as a change** is only what the engine takes: core's `deployContent` (from `toExecutableFlow`). Moving
  components, notes, groups, pinned outputs, and the order of components and edges do not count. A component's label
  does, because the run's record and logs show it. When nothing counts, the deploy is refused ("Nothing to deploy: the
  draft is v3") and the badge does not say _changed_. **Compare draft with deployed** (core's `flowChanges`) lists what
  does: components added, removed, changed (which settings), connections added and removed.
- **Not frozen in a version:** the flow's name, folder and worker tag (the `flows` row's), the project's scripts and the
  workspace's connection profiles, secrets and variables. A change to any of them applies at once to every deployed
  flow.
- **Rollback** makes an older version the deployed one, and **Deploy** on a newer one comes back after it. Versions never
  change. **Restore draft** replaces the draft with a version (the next revision: an editor still on the old one is told
  to reload). **Undeploy** leaves nothing deployed and keeps the versions.
- **Archiving** a deployed flow, its folder or its project undeploys it (in its history) and turns its schedules and
  webhooks off. Restoring it turns nothing back on. Archiving a folder or a project archives the active folders and flows
  in it with it, at the same time; restoring it brings back what went with it (what was archived before stays archived),
  and nothing in an archived project is restored on its own.
- **Deleting** works only on what is archived (`DELETE /w/:ws/flows/:id`, `DELETE /w/:ws/folders/:id`, a folder with
  everything under it): the rows stay (versions, history and runs keep pointing at them), but they leave every list,
  Archived included, and cannot be restored.
- **Flow Invokers** call the called flow's draft in a run of the editor (Run and Run for real: pieces being edited
  together are tested together), and its deployed version in a run of a trigger (`calledFlows(..., 'draft' |
'deployed')` in `start-run/called-flows.ts`, with its `versionId`). There, a flow that is not deployed cannot be
  called: each call fails the envelope with _"The flow "X" cannot be called: it is not deployed."_ and goes to the run's
  errors. Deploy shows a warning, without refusing, when the draft calls a flow that is not deployed, archived or
  removed.
- **Where it shows:** the badge on Deploy (`v3`, `v3 · changed`, `Not deployed`), the Versions window (versions and
  history), a `v3` chip on the project's flows and on the Runs page for a run of a deployed version
  (`runs.flow_version_id`; a run of the draft has none).

## In the code

| What                                | File                                                       |
| ----------------------------------- | ---------------------------------------------------------- |
| Deploy, rollback, undeploy, history | `flowtinus.server/features/deployments/`                   |
| What counts as a change             | core `deployContent` and `flowChanges`                     |
| What a Flow Invoker calls           | `flowtinus.server/features/runs/start-run/called-flows.ts` |

---

[← 06 · The engine: envelopes](06-engine-envelopes.md) · [Index](README.md) · [08 · Re-run and logs →](08-rerun-and-logs.md)
