# 08 · Re-run and logs

## Re-run

**Re-run** (`POST /runs/:id/rerun`, the Runs page, failed runs only) queues the failed run again as a new run with the
same snapshot: the same flow or deployed version, scripts, called flows, parameters, input, worker tag and priority. It
is started by who asked, and `rerun_of` points to the failed run. A fix made after the failure is not in it: Run for
real or a new deploy runs the fix. It is refused when the flow or its project was archived, or when no live supervisor
takes the tag.

## What the logs say about a run

The supervisor writes one event per run as it ends (`LOG_FORMAT=json`; the otel-collector sends them to OpenObserve):

- `run_id` is the run of the event. `parent_run_id` is the run whose Flow Invoker called it, one level up.
  `root_run_id` is the run at the top of the calls (the same as `run_id` for a run nobody called). `root_run_id = X`
  finds everything a run caused, at any depth.
- A call that ran **inside** its caller (not fire and forget) is written when the caller ends, with the time **it**
  ended (`at`, the event's `time`; the collector takes that time).
- `service.name` is `supervisor` (or `server`), and `service.instance.id` is which one: its container's name, or
  `SUPERVISOR_NAME`. Several supervisors are told apart by it.

## In the code

| What                        | File                                                                             |
| --------------------------- | -------------------------------------------------------------------------------- |
| Re-run                      | `flowtinus.server/features/runs/rerun-run/rerun-run-handler.ts`                  |
| Logs (instance, event time) | `flowtinus.server/shared/logging/logger.ts`, `observability/otel-collector.yaml` |
| Tests                       | `flowtinus.server/tests/integration/rerun-api.test.ts`                           |

---

[← 07 · Deploys](07-deploys.md) · [Index](README.md) · [09 · Schedules →](09-schedules.md)
