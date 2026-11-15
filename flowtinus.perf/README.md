# flowtinus.perf

Performance scenarios for the Flowtinus engine. Each scenario is one or more flows (YAML, the editor's Download
format) run by the server's own `runJob` in a fresh Bun process, against SQL Server and MongoDB in containers of their
own and a local fake HTTP API. The report is plain text on the terminal and a static web page (`report/`) that reads
the results; every result is kept in `results/<hostname>.jsonl`, outside git (the page's data, not meant to be read
by hand). The design is [docs/designs/flowtinus-perf.md](../docs/designs/flowtinus-perf.md).

This package is not part of the app: nothing of it goes into the server's image, and it never touches the development
stack (the server, its Postgres, ports 5180, 5190 and 5432).

## Running

From the repository root:

```sh
bun run perf                                   # every scenario
bun run perf in-memory-pipeline http-slow-api  # some of them
bun run perf sqlserver-to-mongodb --quick      # 2 runs, no warm-up, a smaller size
bun run perf --list                            # the scenarios, their services and metrics
bun run perf --serve --open                    # run nothing: open the report page with the results kept so far
```

Flags go after the script name, without `--`: `--runs N` (default 5), `--quick`, `--size N`, `--list`, `--serve`
(serve the report page on http://127.0.0.1:5196 until Ctrl+C; with one scenario, open on it), `--open` (open the page
in the browser; after a run, serve it and open it).

## Reading the results

- **Terminal**: one table per scenario while it runs, and a summary at the end.
- **Report page** (`bun run perf --serve --open`):
    - the overview: the latest execution of every scenario, its engine time and the change against the previous one;
    - a scenario: its history per metric (one chart each) and every execution, newest first;
    - the comparison: tick executions in the table, or click points on a chart, and they show side by side, the oldest as
      the baseline: every metric and every component's active and waiting time with its change against the baseline
      (green went the better way, red worse, grey under 2 %), and each execution's runs.

    The URL keeps what you are looking at (scenario, size, executions), so back, reload and a shared link work. Opened as
    a file (`results/report/index.html`) the page cannot read the results by itself: it asks you to pick or drop the
    `.jsonl`.

Each scenario runs one warm-up (discarded) and N measured runs, each in a new process. The report shows, for the
metrics the scenario picks, the median, the minimum, the maximum and the median of the previous result of the same
scenario and size on this machine. There are no limits and no verdict: you compare. When the engine's time varies more
than 10 % between runs the report says "high noise": run more, or on a quieter machine, before reading small changes.

Besides time, CPU and memory, every run measures what it hands to whoever follows it, as JSON, as a worker sends it to
its supervisor and the supervisor writes it to the database: `recordBytes` (the final record), and the progress sent
while it went, `progressCount`, `progressBytes` (all of it) and `progressMaxBytes` (the largest). A change that makes
the record or the progress carry much more (whole envelopes in every sample, four times a second) shows there before it
takes a worker's memory.

Exit code: 0; 1 when a measured run failed; 2 when the environment did (Docker, a port in use, the data load).
Ctrl+C saves what was measured as a partial result.

## Benchmark history: `git perf-push`

`bun run perf` keeps its results on this machine. To keep a **measurement** in the shared history, push with
`git perf-push` instead of `git push`, with the same arguments:

```sh
git perf-push                       # what `git push` would push
git perf-push origin my-branch --force     # any git push arguments
```

It runs, in order:

1. `git push --dry-run`: the push must update exactly one branch, whose new commit is the one measured. A push of
   several branches, only tags, only deletions or nothing is refused (use plain `git push`), and a push that would be
   rejected fails here, before any benchmark.
2. A temporary worktree of that commit (in the OS temp folder), `bun install --frozen-lockfile --ignore-scripts` in it,
   and every scenario at its default size with 5 runs, against the usual `flowtinus-perf` containers. Your checkout,
   its uncommitted changes and its `results/` are not touched, so every result line is clean. A failed scenario, Docker
   off or Ctrl+C stops here: nothing is pushed. The worktree is removed at the end, also on failure.
3. The real `git push`. If it fails, the measurement is discarded.
4. The **result lines** appended to `<hostname>.jsonl` on the **results branch** `perf-results` (an orphan branch,
   created by the first `git perf-push` with the Pages workflow), in a commit `perf: <short sha> <branch> @ <hostname>`
   authored by you, from a second temporary worktree, and pushed without force. When that push fails (the network,
   or another machine pushed first) it fetches and tries again, 3 times in all; then the lines are kept in
   `results/unsent.json` and the next `git perf-push` sends them too.

Each result line carries the commit's sha and, when the remote is on GitHub, a link to the commit (`git.url`), which
the report shows on the short sha. The alias is set by `bun install` (the root `prepare` script); the script is
`src/perf-push.ts`. A plain `git push` whose commits change `flowtinus.core/src` prints a reminder to measure them
with `git perf-push` (`.husky/pre-push`; it never blocks the push).

### The report on GitHub Pages

https://flowtinus-hub.github.io/flowtinus/

Every push to `perf-results` runs its workflow (`.github/workflows/perf-pages.yml` on that branch, from
`pages/perf-results-pages.yml` here): it takes the report's code from the repository's default branch (`main`), builds the page with every machine's file
joined into one `results.jsonl` (`bun flowtinus.perf/src/build-site.ts <folder of .jsonl> <output folder>`, which you
can also run locally) and publishes it. The site is public to anyone with its link: the result lines carry the
machines' hostnames, CPU models and memory sizes.

Once, on GitHub (Settings of the repository):

- **Pages** → Build and deployment → Source: **GitHub Actions**.
- **Environments** → `github-pages` → Deployment branches and tags: add `perf-results` (by default only the default
  branch may deploy).

## What it needs

- `bun install` at the root.
- For `sqlserver-to-mongodb` and `mongodb-pipeline-aggregate`: Docker Desktop with about 4 GB for containers, and ports
  14330 (SQL Server) and 27030 (MongoDB) free. The first run downloads the images (a few GB) and loads the data
  once; the containers keep running between runs.
- For `http-slow-api`: port 5195 free (the fake API runs as a local process while the scenario runs).
- For `redshift-batch-replace`: port 54330 free and about 1 GB for a Postgres container, which stands in for Redshift
  (the Redshift components speak its protocol). The numbers are the engine's and the drivers', not Redshift's, and
  Redshift's own limits (VARCHAR bytes, serializable isolation) are not reproduced. After each run the scenario checks
  the target table against what the pages say (a page with rows replaced, an empty page untouched, the staging empty)
  and reports any difference.
- `collection-etl-per-document` (MongoDB and the Postgres) and `page-router-fanout` (the Postgres) follow two patterns
  of a warehouse feed: a collection ETL that calls a transformer per document (a window from MongoDB, the snapshots to a
  data lake, a Redshift Upsert of 17 columns per document), and a page router that plans one call per snapshot and
  list and holds the page (megabytes) in a Wait until they end (each call one Redshift Execute). Both check their
  targets after each run.
- `in-memory-pipeline`, `flow-invoker-fanout`, `loop-iterations` and `loop-iterations-parallel` need nothing else.
  The two Loop scenarios take the same input (100 envelopes, each a loop of `size / 100` iterations); their throughput
  is iterations per second (what leaves the Loop, one envelope per iteration). `loop-iterations` runs the loops one
  after another and does only CPU work in them: the engine's cost of one iteration. `loop-iterations-parallel` has
  Parallel on and an iteration that waits 5 ms (a timer in a TypeScript step), so it takes about `size / 10 × 5 ms`:
  Parallel that stops running the loops side by side shows as a run ten times longer.

SQL Server has no ARM64 image: on Apple Silicon it runs emulated, and its numbers do not compare with other machines.

## Cleaning up

```sh
docker compose -p flowtinus-perf down       # stop the containers (the data stays in the volumes)
docker compose -p flowtinus-perf down -v    # also drop the data (the next run loads it again)
```

`results/` is local: delete it whenever you like (but keep `results/unsent.json`, if there is one, for the next `git perf-push`).

## Adding a scenario

1. A folder `scenarios/<id>/` with `scenario.ts` (a default export of `Scenario`, see `src/scenario.ts`), `data.ts`
   (a deterministic generator, `mulberry32` from `fake-api/random.ts`, never `Math.random`, and a `DATA_VERSION` to
   bump when the data changes) and `flows/*.yaml`.
2. Build the flow in the editor, use the connections `perf-sqlserver`, `perf-mongodb` or `perf-redshift` (fixed ids, see `src/flows.ts`;
   create profiles with those ids, or edit the YAML), Download it into `flows/`, and give it `id: <scenario id>`.
   A flow it calls (Flow Invoker) goes in the same folder with an id of its own; a flow's path is its name, so a Flow
   Invoker that picks its flow by path (`$dynamic`, Flow path) names it by that.
   The project scripts its TypeScript components import (`@myproject/scripts/<path>`) go in `scripts/<path>.ts`
   (e.g. `scripts/Shared/ExtendedJson.ts` for `@myproject/scripts/Shared/ExtendedJson`), each scenario its own copy.
3. Label the components: rulers and `throughputNode` name them by label (`component.<label>.waitingMs`).
4. Register it in `src/scenarios.ts`. `bun run test` checks its flows against the core.

## The fake API

`bun run --cwd=flowtinus.perf fake-api` runs it on its own (PORT, default 5195). `GET /items/:id` answers after
`delayMs ± jitterMs` and fails with 503 at `failRate`, both drawn from `seed` and the item's id, so the same item gets
the same answer on every run; `GET /_stats` and `POST /_reset` count what it served.
