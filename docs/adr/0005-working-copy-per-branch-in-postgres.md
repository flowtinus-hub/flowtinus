# Git sync: the working copy is per branch and per server, in Postgres, and Commit is the only write to git

Recorded with git sync step 3. Uncommitted work belongs to a branch: one table holds, for each branch a server has open, the changed files in the repo format, each with the blob it was based on and its last editor. The environment's branch is one of those branches, so today's drafts and scripts' editing copies become its working copy. Every change to the tree, a rename or a folder included, goes into the working copy, and a Commit of the files chosen is the only action that writes to git. A work branch's committed state is read from git, not imported into Postgres; only the environment's branch is reconciled.

## Considered options

- **A draft per flow, shared** (step 2): whoever Commits takes everyone's unfinished changes, and a user cannot keep work apart from the environment.
- **Drafts for the environment's branch and a second table for work branches**: two models of uncommitted work, two merges, two discards.
- **Every branch imported into Postgres** (a branch column on flows, scripts and the rest): each fetch of each branch becomes a reconcile, and versions, deployments, schedules and webhooks would have to ignore all but one branch.
- **Uncommitted work in a git worktree on the server**: one checkout per user and branch on disk, lost with the server's disk, and nothing in it for a query.
- **Structural changes committed at once** (step 2's rule for folders, renames, connections): a rename and the edits that depend on it cannot be one commit, and nothing of it can be discarded.

## Consequences

- Uncommitted work does not travel: a branch opened on two servers has two working copies, as two checkouts would.
- A flow that exists only on a work branch has no `flows` row: endpoints find it by its file's id within the branch, and its runs need no row.
- Pinned outputs leave the draft: they are the user's, in a table of their own, never in the working copy or in git.
- A Commit must bring what the files chosen need (a new folder, project, connection, an imported script), since the tree is validated on every branch before every push.
- Turning git off makes the environment's working copy the drafts again; other branches' working copies are kept, hidden.
