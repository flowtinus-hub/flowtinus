# Coding standards

Judgement calls the reviewer applies to a diff. Formatting, import shape and braces are enforced by Prettier and oxlint
(pre-commit and CI); they are not repeated here.

## Comments

- A comment marks an **edge case** the code does not show: an exception to a rule, a reason no name can carry. A diff
  adds zero comments by default; review every comment it adds against this. What goes: a doc comment restating a name or
  type, a header block summarizing a module, a pointer to an ADR or issue, a note describing a test fixture.

## GitHub workflows

- A workflow that checks out this repository's code at a ref other than its own takes the default branch
  (`${{ github.event.repository.default_branch }}`), never a feature branch by name: feature branches are merged and
  deleted, and the workflow breaks with them.

## Scripts that run git for the user

- A script that pushes on the user's behalf (such as `git perf-push`) refuses arguments that change what the push
  means (`--dry-run`, `-n`) or checks the outcome itself, so it never records something the remote does not have.
- Anything it measured or checked before a long step is checked again right before the push: the ref it read may
  have moved in the meantime.
- Temporary worktrees live in the OS temp folder, are detached (no branch is created), and are removed in a `finally`
  that also deletes the folder itself (on Windows `git worktree remove` leaves `node_modules` link folders behind).

## Concurrent work in the engine

- Work that runs beside other work (parallel loops, called flows, requests at once) stops with the run: a test stops
  or fails the run while that work is in flight, including work that starts right as the run stops, and shows nothing
  goes on after the run has returned.
