# With git on, the environment's branch is the source of truth, and every change goes to git first

From git sync step 2 on, what runs in an environment is what is on its branch. Every action that changes a file of the repo builds a commit, pushes it, and only then reaches Postgres, through the reconcile of that commit; a commit made straight in git reaches the server the same way, by polling or a webhook. Two writers (the app and git) can only agree if one of them is applied through the other, and git is the one a developer, a pull request and a promotion all write to.

## Considered options

- **Postgres first, git as a mirror** (step 1): a commit queue pushed after the change. A commit made straight in git never reaches the server, and a failed push leaves the server ahead of git.
- **Two-way sync**: Postgres first for the app's changes, the reconcile for git's. A change in flight on both sides has no rule for who wins, and the server can run something no branch holds.

## Consequences

- An action that changes the tree takes about a second more (fetch, commit, push), and fails while git cannot be reached; drafts and test runs still work.
- The Deploy button goes: a commit is the deploy.
- A commit made outside the app can be invalid: the reconcile refuses it whole and the environment stays on its last good commit, showing that git is ahead and why.
- Turning git off makes Postgres the source of truth again.
