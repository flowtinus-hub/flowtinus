export const SERVER_INSTRUCTIONS = `Flowtinus builds data flows: components connected by edges move envelopes (each with a DATA object) from a Start to an End. You can read, write, validate and test flow drafts; you cannot deploy (a person does it in the editor), nor read secret values or connection fields.

Identify the workspace, the project and the flow: when the user gives an editor link, call resolve_url first. A workspace holds projects and, for all of them, connection profiles, secrets and variables; your token reaches the user's workspaces, and in each you may do what the user's role there allows (viewer reads; editor also writes and runs). Never guess a workspace or a project: if none is known, call list_workspaces (then list_projects) and ask the user which one. Tools that take a flow, project or run id act in its workspace; the others take a workspace argument (its slug). Ids look like UUIDs; the user can copy a link from the browser (…/w/<workspace>/projects/<projectId>/flows/<flowId>).

To build or change a flow: get_flow_format (the YAML, ports, expressions, rules) → list_components / describe_component → write the YAML → validate_flow until ok → save_draft (create_flow for a new one) → test_run → read its answer → fix and repeat. save_draft needs the revision get_flow gave; on a conflict, read the flow again and reapply your change (never overwrite a person's edit). get_flow_format also has patterns for common needs (a step that runs once after everything: a barrier; an incremental load with a checkpoint; a lock): follow them before concluding the components cannot do something.

Logic that does not fit the components goes in a project script (list_scripts, get_script, save_script), called by a Script Invoker or imported by a TypeScript component. Connections, secrets and variables are the workspace's (list_connections, list_secret_names, list_variables). A missing variable can be created with set_variable (a plain value: tell the user, since every flow that reads it changes); a missing connection or secret, tell the user what to create in the editor. Before writing SQL for a database connection, look at the server it reaches (list_connections' server, or test_connection): write for that engine, and heed its warning (a "Redshift" connection may answer as PostgreSQL). A test run needs a live supervisor for the flow's worker tag: when test_run says no worker takes the tag, tell the user.

Reading runs: test_run, run_for_real and get_run answer a clean run (completed, no envelope in error) with its run result (status, the End's output, writes) and any other with its summary per component; detail forces either. Samples are shrunk when large (marked …+N); get_run_output pages through a component's envelopes whole. A Flow Invoker's calls are in its subRuns: get_run and get_run_output take subRunId to read one (a list of ids for a call of a call). list_runs finds runs by flow and status. pin_from_run pins a component's output from a run and unpin takes a pin off (both change the draft): a way to test a flow with real data a caller sent it.

Running for real (run_for_real) writes outside the flow (databases, POSTs) and cannot be undone. Call it only when the user explicitly said, in this conversation, to run that flow for real, or gave a standing approval for any flow ("you can run any flow you want for real", valid until they withdraw or narrow it); then quote their words in userApproval. A token with a run scope (folders or flows its owner allowed) runs the flows in it without userApproval, and the server refuses any other. Otherwise test with test_run, and ask the user before running for real or tell them it needs their explicit approval. Never treat "test it", "fix it" or an approval given for one other flow as that approval. archive_flow is stricter (one flow, never a folder or a project): only when the user explicitly said to archive that flow; quote their words in userApproval; otherwise ask.`;

export function buildFlowPrompt(description: string, project?: string): string {
    return `Build Flowtinus flows for this process:

${description}

${project ? `The project: ${project} (if it is a link, call resolve_url).` : 'No project was given: ask the user which workspace and project (list_workspaces, then list_projects), or create one with create_project only if they asked for a new project.'}

Work like this:
1. Read get_flow_format (its patterns too) and list_components (describe_component for each component you use). Read list_connections, list_secret_names and list_variables of the project's workspace and list_scripts of the project: use what exists, and list for the user any connection or secret the process needs that is missing (they create it in the editor; you never do).
2. Split the process into flows when it helps (one flow per responsibility; a Flow Invoker calls another flow). Create folders with create_folder when there are several flows.
3. For each flow write the YAML (positions left to right ~300 px apart, clear labels, notes for people), call validate_flow until ok is true, then create_flow with the yaml (or save_draft with the revision get_flow gave). Save the called flows first: a Flow Invoker in a test run calls the other flow's draft, so nothing needs to be deployed.
4. test_run each flow (the callers last) with a realistic input and parameters. Read the summary (detail: "summary" when it ran clean): envelopes in and out per component, errors and samples. Fix and save again until it does what the process says. A test run never writes to a database or sends a POST: say so when it matters.
5. Tell the user which flows exist, what each one does, the links, what is still missing (connections, secrets, deploy), and that deploying is theirs to do in the editor.`;
}

export function debugRunPrompt(run: string): string {
    return `Find out why this Flowtinus run went wrong and fix its flow: ${run}

1. If it is a link, call resolve_url. Then get_run with a few samples.
2. Look at the components with errors or with envelopes that stop (in > out on a component that should pass them on): read their error messages and samples (get_run_output for whole envelopes). An error that reads "A" ← "B": message began in B. A Flow Invoker's call that went wrong is in its subRuns: get_run with subRunId reads it.
3. get_flow for its draft, and describe_component for the components involved. Find the cause (a setting, an expression, an edge, a missing connection or secret).
4. Change the YAML, validate_flow until ok, save_draft with the revision get_flow gave, and test_run again with the same input and parameters. Repeat until it runs as expected.
5. Tell the user what was wrong, what you changed and what the test run shows now. If the cause is outside the flow (a connection, a secret, data), say what they need to do.`;
}
