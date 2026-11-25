# Git sync: an environment ahead of its source is backported one hop at a time, always as a merge

Recorded with git sync step 6. An environment is ahead of its source when merging its branch into the source's would change the source's tree (`git merge-tree --write-tree`), not by a count of commits. While it is ahead, the promotion from that source into it is blocked. The way out is a backport: a pull request from `backport/<environment>-<sha>`, cut from the source's branch with the environment's tip merged into it, opened by the source's server into the source alone. Once it is merged, the source may be ahead of its own source in turn, and that source's server offers the next hop, up to the root. A backport is always a merge, never a cherry-pick or a squash.

## Considered options

- **Backporting straight to the root**: one pull request instead of one per hop, but the fix then reaches the environments in between only by a promotion from the root, which carries all of the root's pending work, ready or not (scenario 10 of the simulation).
- **A cherry-pick of the hotfix's commits**: no shared history, so the environment would read as ahead for ever by a count of commits, and the next promotion meets the same change twice.
- **Ahead by a count of commits**: promotion merge commits would count, and a change already in the source by another path would be flagged for ever. The tree test says what matters: whether the source would change.
- **No block while ahead**: the next promotion could conflict inside a protected branch, and environments would differ in silence.

## Consequences

- A hotfix costs a reviewed pull request in each protected branch on the way up, and until a hop is merged nothing is promoted into the environment it leaves. A second emergency there is a second hotfix.
- Each hop brings only what the environment had that its source lacked; the next promotion into it carries what the source already had, never unpromoted work further up.
- A squashed backport still ends the block, since the test is by tree; it shows as a broken lineage with a repair offered, as a promotion's does in [ADR 0007](0007-promotion-state-read-from-git.md), and blocks nothing.
