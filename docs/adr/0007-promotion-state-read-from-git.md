# Git sync: a promotion is a branch at a first-parent commit, and its state is read from git

Recorded with git sync step 5. A promotion is opened by the source environment's server from `promote/<source>-<sha>`, a branch that points at the chosen first-parent commit of the source's branch, with no commit of its own. The source's server keeps the promotions it opened in a table of its own, and works out each one's state from git alone on every poll, with no provider adapter: merged when the promoted sha is an ancestor of the target's branch; lineage broken when the target's tree already holds the promoted content (merging the sha into the target would change nothing) but not the sha; closed when the promotion branch is gone from the remote; open otherwise. A promotion that changes no file is refused, which is what makes the second test sound. A broken lineage blocks that edge, and only that edge, until a repair is merged: a merge of the promoted sha into the target with the `ours` strategy, which keeps the target's tree. Servers do not call each other.

## Considered options

- **A pull request's state from the provider**: needs an adapter (step 7) for every provider, and a plain git server has none.
- **A promotion record in git** (a tag or a note per promotion), so every server sees it: one more thing written to the repo, outside its format, for a check only the source needs.
- **Blocking promotions out of the target too**: the harm of a squashed promotion is on the edge into the target, where the next merge finds an old merge base and conflicts wherever the source changed a line again. Promoting out of the target just carries its history; and the target's server does not have the record to enforce it.
- **A repair commit with the promoted sha's tree**: right only while the target has taken nothing since the squash; it would revert whatever was merged into the target afterwards.
- **A status endpoint on each server**, so a server sees another's reconciled commit and configured connections: authentication between servers, for screens that git already mostly answers.

## Consequences

- The app cannot stop a squash before it happens; it finds it after the target moves, and the repair is one reviewed pull request that deploys nothing.
- Only the source's server knows its promotions: the target's server shows them as commits.
- Other environments are shown as their branches say, not as they run: a refused commit or a pin shows only on its own server.
- What the pre-flight says about the target's environment is what git can tell: connections, schedules and webhooks new to the target, which arrive not configured or disabled by [ADR 0006](0006-trigger-definition-in-git-activation-in-the-environment.md).
