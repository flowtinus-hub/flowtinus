# A run's MCP answer depends on how the run ended

`test_run`, `run_for_real` and `get_run` answer a **clean** run (status `completed`, no envelope in error in any component or call, counting those diverted or let through) with its **run result**: status, the envelopes at its End, what it wrote, the user's warnings and errors. Any other run gets its **run summary**, the detail per component. A `detail` argument forces either one. Most runs an agent starts end cleanly, and for those the summary cost about 50 times the tokens of the answer it carried; a run that did not end cleanly is exactly when the agent needs the detail, so it gets it without a second call.

## Considered options

- **Always the run summary** (what we had): every clean run pays ~200 tokens for ~5 of answer; after a few dozen runs in one conversation, the context saved elsewhere is gone.
- **The run result only when asked for** (`detail: "result"`): agents rarely ask, so the cost stays.
- **Always the run result**: the agent makes a second call (`get_run` with `detail: "summary"`) exactly when something failed.
