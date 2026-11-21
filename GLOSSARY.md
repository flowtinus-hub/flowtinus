# Flowtinus

Visual data flows: an engine that runs them, a server that schedules them and an editor that draws them. This glossary covers the vocabulary of the performance benchmarks (`flowtinus.perf`) and how their history is kept and read, loops, flow calls, how an agent reads a run, git sync, and how code imports scripts.

## Language

### Benchmark history

**Result line**:
One scenario measured once on one machine, with its runs, rulers and the commit it measured. The unit the report lists as an "execution".
_Avoid_: Execution, record, entry

**Measurement**:
The result lines of one `git perf-push`: every scenario, for the same commit, on the same machine.
_Avoid_: Benchmark run, session

**Machine**:
The host (by hostname) that produced result lines; each has its own history.
_Avoid_: Host, runner, node

**Results branch**:
The orphan branch `perf-results`, the shared history of every machine's measurements. Local runs of `bun run perf` are not part of it.
_Avoid_: Results repo, perf branch

### Loops

**Loop**:
A component that holds other components (its loop region) and runs them again and again, one iteration after another. Each envelope that enters it runs a loop of its own. What reaches its iteration end, in every iteration, goes out of it.
_Avoid_: For, while, repeat

**Iteration start**:
A Loop's inner port where each iteration begins, with the loop state.
_Avoid_: Loop start, inner Start

**Iteration end**:
A Loop's inner port where the paths of an iteration finish; what reaches it goes out of the Loop.
_Avoid_: End loop, inner End, loop end

**Loop region**:
The components inside a Loop. Closed: none of them is linked to a component outside it.
_Avoid_: Loop body, block, scope

**Iteration**:
One pass through a loop region, which ends when all its components have finished.
_Avoid_: Pass, round, cycle

**Continue with**:
A component inside a loop region: the envelope that reaches it is the loop state of the next iteration. It does not cut the iteration short.
_Avoid_: Continue, loop back

**Next**:
A component inside a loop region: an envelope that reaches it ends the iteration right away (what is still running in it stops, without failing) and the next iteration starts with the loop state as it is. The `continue` of a `for`.
_Avoid_: Skip, Continue

**Break**:
A component inside a loop region: the envelope that reaches it ends the loop; it does not go out of the Loop. It wins over a Continue with or a Next reached in the same iteration.
_Avoid_: Exit, stop

**Stop condition**:
A Loop's expression on the loop state and the loop index, checked before each iteration (or before each but the first, when the Loop checks after the iteration, as a do-while): true ends the loop.
_Avoid_: While, exit condition, until

**Loop index**:
The number of the current iteration, 0 in the first: `$_loopIndex`, in the components of a loop region and in the stop condition. Each Loop has its own: a component sees the one of the Loop whose region holds it.
_Avoid_: Counter, iteration number, i

**Loop state**:
The envelope an iteration starts with: the one that entered the Loop, then the one that reached Continue with in the previous iteration; when none did, it stays as it was.
_Avoid_: Accumulator, page, checkpoint

### Flow calls

**Wait**:
A Flow Invoker's call that runs the other flow inside the caller's run, its End's envelopes coming back to the caller. It stops when the caller stops.
_Avoid_: Inline call, inline child

**Fire and forget**:
A Flow Invoker's call that sends its envelopes on at once and starts runs of their own with batches of them. Those runs outlive the caller (stopped one by one or with Stop below); a batch not yet started when the caller ends early (Stop, timeout, a failure, or a Next ending its iteration) is dropped.
_Avoid_: Async call, background run

### Runs through the MCP

**Run status**:
How a run ended: `completed` (nothing to look at), `with-warnings` (a component's own warning or error line, a diverted envelope, or no envelope at the End), `with-errors` (an envelope in error let through), `failed` (it stopped). Only `completed` is a successful run.
_Avoid_: Success, OK

**Clean run**:
A run that ended `completed` with no envelope in error in any component or call it waited for: none let through (`onError: continue`), none diverted (`onError: divert`); every call it waited for ended `completed` too.
_Avoid_: Successful run, green run (a run `with-warnings` is not clean)

**Run result**:
The brief outcome of a run, what an agent gets for a clean run: its status, the envelopes that reached its End (a few, and how many), what it wrote outside and the warnings and errors the user's components wrote.
_Avoid_: Run output (only the End's envelopes), run record (the engine's full record)

**Run summary**:
The detail of a run per component: envelopes in and out per port, errors, writes, a Flow Invoker's calls and a few envelopes. What an agent gets for a run that is not clean, or when it asks for it.
_Avoid_: Run result, run record (the summary is shrunk from it)

### Git sync

**Environment**:
One server's place in the topology, with the branch it deploys from and the environments it promotes to.
_Avoid_: Stage, instance (the server itself), target

**Topology**:
The environments of a repository and how flows are promoted between them, kept on a branch of its own outside the pipeline.
_Avoid_: Pipeline config, environments file

**Environment's branch**:
The branch an environment deploys from. With git on, what is on its tip is what that environment should run.
_Avoid_: Deploy branch, main, release branch

**Reconcile**:
Applying the tree at the tip of the environment's branch to the server, whole or not at all. It is what deploys, with git on.
_Avoid_: Sync, import, pull

**Refused commit**:
A commit on the environment's branch whose tree is not valid: the reconcile leaves the server on the last commit it applied, and shows why.
_Avoid_: Failed deploy, broken commit

**Git ahead**:
The state of an environment whose branch has a commit the server has not applied: refused, or not reconciled yet.
_Avoid_: Out of sync, drift, behind

### Scripts

**Handle**:
The name a workspace or a project goes by in an import path: lowercase letters, digits and hyphens, unique in its scope. A workspace's is chosen when it is created and never changes; a project's is made from its name and changes with it.
_Avoid_: Slug, key

**Import path**:
How code names a script of any project in its workspace: `@w/<workspace handle>/<project handle>/scripts/<path>`, the same for the project's own scripts and another's.
_Avoid_: Module path, `@myproject`

**Deployed script set**:
The scripts at the commit an environment last applied: what its schedules, webhooks and deployed runs import. The editor's Run uses the scripts being edited instead.
_Avoid_: Script version, published scripts
