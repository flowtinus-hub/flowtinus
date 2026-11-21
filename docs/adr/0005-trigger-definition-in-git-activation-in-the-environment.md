# Git sync: a trigger's definition is in its flow's file, whether it runs is the environment's, and what arrives is disabled

Recorded with git sync step 4. A schedule or webhook is written in its flow's file (its id, a cron and time zone or a name, its defaults) and is promoted with the flow; whether it runs, a webhook's token, and an environment's overrides of a schedule's values stay in that environment's Postgres and never go to git. Whatever the reconcile creates or brings back arrives disabled, in every environment, the one where it was written included: a commit, a promotion or a clone never starts a production cron or opens an address by itself. Triggers are not part of the flow's content hash, so a trigger change makes no new flow version and the emergency pin never rolls one back.

## Considered options

- **Triggers only in Postgres** (steps 1 to 3): a new environment, a clone or a local server has none, and nothing reviews them.
- **Enabled in git**: a promotion or a merged pull request would turn a cron on in production with no one there deciding it, and a clone would fire it.
- **Arriving enabled where they were written**: the server cannot tell the app's own commit from a push of the same branch by hand, so the rule would differ by who wrote the file.
- **Triggers in the content hash**: every cron change a new flow version, and the emergency pin would roll triggers back with the flow.

## Consequences

- Turning a trigger on is a step in each environment after it arrives, even where it was written; the Commit's outcome offers the switch.
- A webhook's address (`/wh/<id>`) is the same path in every environment; its token is each environment's.
- An override can hide a change made in git: the screens show both values.
