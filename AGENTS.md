# AGENTS.md

Instructions for AI coding agents working in this repository (Claude Code, Codex, Cursor and others).

## Agent skills

The repo carries [Matt Pocock's skills](https://github.com/mattpocock/skills) (MIT) as files: `.agents/skills/` (Codex, Cursor and other agents) and `.claude/skills/` (Claude Code), both from `skills-lock.json`. To update them, run `npx skills@latest update -p`; to restore them from the lock file, `npx skills@latest experimental_install`. Agents without skill support can read any `SKILL.md` there and follow it.

### Issue tracker

Issues are tracked in this repo's GitHub Issues, through the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five default triage labels: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.

## Branches

`main` takes changes only through a pull request (a GitHub ruleset: no direct push, force push or deletion). Work on a branch and open a PR to `main`.

A spec's tickets each go on `subtask/<issue>`, cut from the spec's `feature/<name>` branch (itself cut from `main`): switch to the ticket's `subtask/<issue>` before committing it.

An agent commits on its branch but never pushes, and never opens a PR, unless the maintainer says so for that change: they review the change before it leaves the machine. This holds for every branch, fixes to an open PR included, and above all for changes to the engine (`flowtinus.core`).

Commit messages and PR bodies carry the maintainer as the only author: no co-author trailer or "generated with" line for any AI tool (Claude, Cursor, Gemini, GPT or another), whatever the tool's own default.

## Tests

`bun run test` at the root runs every package's tests except the server's `tests/containers` (Testcontainers and supervisor processes, which need Docker). `bun run test:all` adds them; CI runs it on pull requests to `main`. A new test that starts a container or a separate process goes in `flowtinus.server/tests/containers`.

The editor's only unit tests are the arrange ones (`flowtinus.editor/tests/arrange.test.ts`): don't add new editor unit tests; check an editor change in the running app.
