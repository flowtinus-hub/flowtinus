import YAML from 'yaml';
import { aheadOfSource, applyOverlay, changesBetween, commitsBetween, envOfBranch, flowFile, flowYaml, isAncestor, isUserBranch, mergeBase, nameProblem, parseFlow, parseWorkspace, POSTGRES, projectDir, scriptFile, scriptPathProblem, sameName, shortHash, sourceOf, threeWay, workspaceFile, WS, type Commit, type CommitKind, type FlowDoc, type GitSettings, type Overlay, type Pr, type PrKind, type ScheduleDefaults, type State, type Tree } from './model';

export type Result = string | null;

export function log(state: State, text: string, tone: 'ok' | 'warn' | 'error' | 'info' = 'info') {
    state.seq++;
    state.events.unshift({ id: state.seq, at: state.clock, text, tone });
    state.events = state.events.slice(0, 60);
}

const tick = (state: State) => (state.clock += 7 * 60 * 1000);

export function commitTree(state: State, parents: string[] | null, tree: Tree, message: string, author: string, kind: CommitKind): string {
    tick(state);
    state.seq++;
    const sha = shortHash(`${state.seq}:${message}:${JSON.stringify(parents)}`);
    state.commits[sha] = { sha, parents: parents ?? [], message, author, at: state.clock, tree, kind };
    return sha;
}

const contentHash = (content: string) => shortHash(content);

export function reconcile(state: State, env: string) {
    const server = state.servers[env]!;
    const sha = state.branches[server.settings.branch];
    if (!server.gitOn || !sha || sha === server.reconciledSha) {
        return;
    }
    const commit = state.commits[sha]!;
    const view = parseWorkspace(commit.tree);
    const seen = new Set<string>();
    const changed: string[] = [];
    for (const flow of view.flows) {
        seen.add(flow.id);
        const content = commit.tree[flow.path]!;
        const row = (server.flows[flow.id] ??= { id: flow.id, name: flow.name, versions: [], current: null });
        row.name = flow.name;
        const hash = contentHash(content.replace(/^deployed: .*$/m, ''));
        const last = row.versions.at(-1);
        if (!last || last.hash !== hash || last.deployedField !== flow.doc.deployed) {
            if (!last || last.hash !== hash) {
                row.versions.push({
                    n: row.versions.length + 1,
                    sha,
                    message: commit.message,
                    hash,
                    deployedField: flow.doc.deployed,
                    at: commit.at,
                });
            } else {
                last.deployedField = flow.doc.deployed;
            }
            changed.push(flow.name);
        }
        const before = row.current;
        row.current = flow.doc.deployed ? row.versions.at(-1)!.n : null;
        if (before !== row.current) {
            server.history.unshift(
                `${sha} ${flow.name}: ${row.current === null ? 'not running (deployed: false)' : `v${row.current} deployed`}${commit.kind === 'promotion' ? ' (promote)' : ''}`,
            );
        }
        for (const schedule of flow.doc.schedules ?? []) {
            if (!server.schedules[schedule.id]) {
                server.schedules[schedule.id] = { id: schedule.id, flowId: flow.id, enabled: false, override: {} };
                server.history.unshift(`${sha} schedule "${schedule.name}" of ${flow.name} arrived: disabled until reviewed`);
            }
        }
    }
    for (const row of Object.values(server.flows)) {
        if (!seen.has(row.id) && row.current !== null) {
            row.current = null;
            server.history.unshift(`${sha} ${row.name}: gone from git, no longer running`);
        }
    }
    for (const decl of view.connections) {
        if (!server.connections[decl.id]) {
            server.connections[decl.id] = { ...decl, configured: false };
            server.history.unshift(`${sha} connection "${decl.name}" arrived: not configured`);
        } else {
            server.connections[decl.id]!.name = decl.name;
        }
    }
    server.scripts = Object.fromEntries(view.scripts.map(s => [s.path, contentHash(s.content)]));
    server.reconciledSha = sha;
    log(
        state,
        `${env} fetched ${server.settings.branch} @ ${sha} and reconciled${changed.length ? `: ${changed.join(', ')}` : ' (no flow changed)'}`,
        'ok',
    );
}

export function branchMoved(state: State, branch: string) {
    for (const env of state.envOrder) {
        if (state.servers[env]!.settings.branch === branch) {
            reconcile(state, env);
        }
    }
}

const userKey = (state: State) => `${state.session.env}:${state.session.user}`;
export const me = (state: State) => state.users.find(u => u.slug === state.session.user)!;
export const server = (state: State) => state.servers[state.session.env]!;

export function currentBranch(state: State): string {
    const s = server(state);
    if (!s.gitOn) {
        return POSTGRES;
    }
    const chosen = state.session.branchByEnvUser[userKey(state)];
    return chosen && state.branches[chosen] ? chosen : s.settings.branch;
}

export function headTree(state: State, branch: string): Tree {
    if (branch === POSTGRES) {
        const sha = server(state).reconciledSha;
        return sha ? state.commits[sha]!.tree : {};
    }
    const sha = state.branches[branch];
    return sha ? state.commits[sha]!.tree : {};
}

export const workingTree = (state: State, branch = currentBranch(state)) =>
    applyOverlay(headTree(state, branch), server(state).working[branch]);

export const currentChanges = (state: State, branch = currentBranch(state)) =>
    changesBetween(headTree(state, branch), workingTree(state, branch));

export function editRefusal(state: State, branch = currentBranch(state)): string | null {
    const s = server(state);
    if (branch === POSTGRES) {
        return null;
    }
    if (branch === s.settings.branch) {
        return s.settings.directEdits
            ? null
            : `${s.env} is protected: its branch ${branch} takes no direct edits. Create a branch (users/${state.session.user}/...) and open a PR.`;
    }
    if (isUserBranch(branch)) {
        const owner = state.branchMeta[branch]?.owner ?? branch.split('/')[1];
        return owner === state.session.user ? null : `${branch} is ${owner}'s branch: only they write on it.`;
    }
    return `${branch} is not this server's branch nor a user branch: read only here.`;
}

export function editFiles(state: State, edits: Overlay, what: string, quiet = false): Result {
    const branch = currentBranch(state);
    const refusal = editRefusal(state, branch);
    if (refusal) {
        log(state, refusal, 'error');
        return refusal;
    }
    const s = server(state);
    const head = headTree(state, branch);
    const overlay = { ...(s.working[branch] ?? {}), ...edits };
    for (const [path, content] of Object.entries(overlay)) {
        if (content === (head[path] ?? null)) {
            delete overlay[path];
        }
    }
    s.working[branch] = overlay;
    if (quiet) {
        return null;
    }
    log(state, `${what} (working copy of ${branch === POSTGRES ? 'the Postgres draft' : branch} on ${s.env})`);
    return null;
}

export function changeFlow(state: State, flowId: string, change: (doc: FlowDoc) => void, what: string): Result {
    const tree = workingTree(state);
    const flow = parseWorkspace(tree).flows.find(f => f.id === flowId);
    if (!flow) {
        return 'Flow not found on this branch.';
    }
    const doc = parseFlow(tree[flow.path]!);
    change(doc);
    return editFiles(state, { [flow.path]: flowYaml(doc) }, `${flow.name}: ${what}`);
}

function siblingClash(names: string[], name: string, kind: string): Result {
    return names.some(n => sameName(n, name))
        ? `A ${kind} named "${name}" already exists here (names are unique whatever the case).`
        : null;
}

export function createProject(state: State, name: string): Result {
    const view = parseWorkspace(workingTree(state));
    const problem =
        nameProblem(name, 'project') ??
        siblingClash(
            view.projects.map(p => p.name),
            name,
            'project',
        ) ??
        (sameName(name, 'workspace.yaml')
            ? 'A project cannot be named "workspace.yaml": the folder would collide with the workspace file.'
            : null);
    if (problem) {
        return problem;
    }
    return editFiles(
        state,
        {
            [`${projectDir(name)}/project.yaml`]: YAML.stringify({
                id: `p-${shortHash(name)}`,
                description: '',
                icon: 'folder',
                color: 'gray',
            }),
        },
        `Project "${name}" created`,
    );
}

function moveAll(tree: Tree, fromPrefix: string, toPrefix: string): Overlay {
    const edits: Overlay = {};
    for (const [path, content] of Object.entries(tree)) {
        if (path.startsWith(fromPrefix)) {
            edits[path] = null;
            edits[toPrefix + path.slice(fromPrefix.length)] = content;
        }
    }
    return edits;
}

export function renameProject(state: State, from: string, to: string): Result {
    const tree = workingTree(state);
    const view = parseWorkspace(tree);
    const problem =
        nameProblem(to, 'project') ??
        siblingClash(
            view.projects.filter(p => p.name !== from).map(p => p.name),
            to,
            'project',
        ) ??
        (sameName(to, 'workspace.yaml')
            ? 'A project cannot be named "workspace.yaml": the folder would collide with the workspace file.'
            : null);
    if (problem) {
        return problem;
    }
    return editFiles(state, moveAll(tree, `${projectDir(from)}/`, `${projectDir(to)}/`), `Project "${from}" renamed to "${to}"`);
}

function folderChildren(state: State, project: string, parent: string) {
    const view = parseWorkspace(workingTree(state));
    const p = view.projects.find(x => x.name === project);
    const depth = parent ? parent.split('/').length + 1 : 1;
    const folders = (p?.folders ?? [])
        .filter(f => f.split('/').length === depth && (parent ? f.startsWith(`${parent}/`) : true))
        .map(f => f.split('/').pop()!);
    const flows = view.flows.filter(f => f.project === project && f.folder === parent).map(f => f.name);
    return { folders, flows };
}

export function createFolder(state: State, project: string, parent: string, name: string): Result {
    const { folders, flows } = folderChildren(state, project, parent);
    const problem =
        nameProblem(name, 'folder') ??
        siblingClash(folders, name, 'folder') ??
        (flows.some(f => sameName(`${f}.yaml`, name)) ? `"${name}" would collide with the file of the flow "${name.slice(0, -5)}".` : null);
    if (problem) {
        return problem;
    }
    const path = parent ? `${parent}/${name}` : name;
    return editFiles(state, { [`${WS}/${project}/flows/${path}/.gitkeep`]: '' }, `Folder "${path}" created in ${project}`);
}

export function renameFolder(state: State, project: string, path: string, to: string): Result {
    const parent = path.split('/').slice(0, -1).join('/');
    const { folders, flows } = folderChildren(state, project, parent);
    const old = path.split('/').pop()!;
    const problem =
        nameProblem(to, 'folder') ??
        siblingClash(
            folders.filter(f => f !== old),
            to,
            'folder',
        ) ??
        (flows.some(f => sameName(`${f}.yaml`, to)) ? `"${to}" would collide with the file of the flow "${to.slice(0, -5)}".` : null);
    if (problem) {
        return problem;
    }
    const target = parent ? `${parent}/${to}` : to;
    return editFiles(
        state,
        moveAll(workingTree(state), `${WS}/${project}/flows/${path}/`, `${WS}/${project}/flows/${target}/`),
        `Folder "${path}" renamed to "${target}"`,
    );
}

function flowNameProblem(state: State, project: string, folder: string, name: string, except?: string): Result {
    const { folders, flows } = folderChildren(state, project, folder);
    return (
        nameProblem(name, 'flow') ??
        siblingClash(
            flows.filter(f => f !== except),
            name,
            'flow',
        ) ??
        (folders.some(f => sameName(f, `${name}.yaml`)) ? `The file "${name}.yaml" would collide with the folder of that name.` : null)
    );
}

export function createFlow(state: State, project: string, folder: string, name: string): Result {
    const problem = flowNameProblem(state, project, folder, name);
    if (problem) {
        return problem;
    }
    const doc: FlowDoc = {
        id: `f-${shortHash(`${project}/${folder}/${name}/${state.seq}`)}`,
        deployed: false,
        workerTag: 'default',
        nodes: [
            { id: 'start', type: 'Start', position: { x: 0, y: 0 } },
            { id: 'end', type: 'End', position: { x: 260, y: 0 } },
        ],
        edges: ['start -> end'],
    };
    const edits: Overlay = { [flowFile(project, folder, name)]: flowYaml(doc) };
    const keep = `${WS}/${project}/flows/${folder}/.gitkeep`;
    if (folder && workingTree(state)[keep] !== undefined) {
        edits[keep] = null;
    }
    return editFiles(state, edits, `Flow "${name}" created`);
}

export function renameFlow(state: State, flowId: string, to: string): Result {
    const tree = workingTree(state);
    const flow = parseWorkspace(tree).flows.find(f => f.id === flowId);
    if (!flow) {
        return 'Flow not found.';
    }
    const problem = flowNameProblem(state, flow.project, flow.folder, to, flow.name);
    if (problem) {
        return problem;
    }
    return editFiles(
        state,
        { [flow.path]: null, [flowFile(flow.project, flow.folder, to)]: tree[flow.path]! },
        `Flow "${flow.name}" renamed to "${to}"`,
    );
}

export function createScript(state: State, project: string, rel: string): Result {
    const tree = workingTree(state);
    const existing = parseWorkspace(tree).scripts.filter(s => s.project === project);
    const problem =
        scriptPathProblem(rel) ??
        (existing.some(s => sameName(s.rel, rel)) ? `A script "${rel}" already exists (whatever the case).` : null);
    if (problem) {
        return problem;
    }
    return editFiles(
        state,
        { [scriptFile(project, rel)]: 'export function main(input: unknown) {\n    return input;\n}\n' },
        `Script "${rel}" created`,
    );
}

export function renameScript(state: State, project: string, rel: string, to: string): Result {
    const tree = workingTree(state);
    const view = parseWorkspace(tree);
    const problem =
        scriptPathProblem(to) ??
        (view.scripts.some(s => s.project === project && s.rel !== rel && sameName(s.rel, to))
            ? `A script "${to}" already exists (whatever the case).`
            : null);
    if (problem) {
        return problem;
    }
    const edits: Overlay = { [scriptFile(project, rel)]: null, [scriptFile(project, to)]: tree[scriptFile(project, rel)]! };
    for (const flow of view.flows.filter(f => f.project === project)) {
        if (flow.doc.nodes.some(n => n.config?.script === rel)) {
            const doc = parseFlow(tree[flow.path]!);
            doc.nodes = doc.nodes.map(n => (n.config?.script === rel ? { ...n, config: { ...n.config, script: to } } : n));
            edits[flow.path] = flowYaml(doc);
        }
    }
    return editFiles(state, edits, `Script "${rel}" renamed to "${to}" (flows that call it rewritten)`);
}

export function createConnection(state: State, name: string, type: string): Result {
    const s = server(state);
    const branch = currentBranch(state);
    const refusal = s.gitOn ? editRefusal(state, branch) : null;
    if (refusal) {
        log(state, `Connection not created: its declaration needs a branch you can write on. ${refusal}`, 'error');
        return `Its declaration needs a branch you can write on. ${refusal}`;
    }
    const id = `c-${shortHash(name + state.seq)}`;
    s.connections[id] = { id, name, type, configured: true };
    log(state, `Connection "${name}" exists in ${s.env} now (configured)`, 'ok');
    if (!s.gitOn) {
        return null;
    }
    const tree = workingTree(state);
    const doc = (YAML.parse(tree[workspaceFile] ?? 'connections: []') ?? {}) as { connections?: unknown[] };
    doc.connections = [...(doc.connections ?? []), { id, name, type }];
    return editFiles(state, { [workspaceFile]: YAML.stringify(doc) }, `Declaration of connection "${name}" added to workspace.yaml`);
}

export function createBranch(state: State, name: string, from = currentBranch(state)): Result {
    const s = server(state);
    const slug = name.trim();
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(slug)) {
        return 'A branch name: lower case letters, digits, dots, dashes, underscores (it becomes a git ref).';
    }
    const branch = `users/${state.session.user}/${slug}`;
    if (state.branches[branch]) {
        return `${branch} already exists.`;
    }
    if (!state.branches[from]) {
        return `${from} does not exist.`;
    }
    const here = currentBranch(state);
    const carried = s.working[here] ?? {};
    const paths = Object.keys(carried);
    const hereTree = headTree(state, here);
    const fromTree = headTree(state, from);
    const clash = paths.filter(p => hereTree[p] !== fromTree[p]);
    if (clash.length) {
        return `Your uncommitted changes touch ${clash.length} file(s) that differ between ${here} and ${from} (${clash[0]}${clash.length > 1 ? '…' : ''}): commit or discard them first.`;
    }
    state.branches[branch] = state.branches[from]!;
    state.branchMeta[branch] = { cutFrom: from, owner: state.session.user, createdOn: s.env };
    if (paths.length) {
        s.working[branch] = carried;
        delete s.working[here];
    }
    state.session.branchByEnvUser[`${s.env}:${state.session.user}`] = branch;
    log(
        state,
        `Branch ${branch} cut from ${from} @ ${state.branches[branch]} and pushed${paths.length ? `; ${paths.length} uncommitted change(s) came along from ${here}` : ''}`,
        'ok',
    );
    return null;
}

export function switchBranch(state: State, branch: string) {
    state.session.branchByEnvUser[`${state.session.env}:${state.session.user}`] = branch;
}

export function discard(state: State, keys: string[]) {
    const branch = currentBranch(state);
    const s = server(state);
    const overlay = { ...(s.working[branch] ?? {}) };
    for (const change of currentChanges(state).filter(c => keys.includes(c.key))) {
        delete overlay[change.path];
        if (change.from) {
            delete overlay[change.from];
        }
    }
    s.working[branch] = overlay;
    log(state, `Discarded ${keys.length} change(s) on ${branch}`);
}

export function commitChanges(state: State, keys: string[], message: string): Result {
    const branch = currentBranch(state);
    const s = server(state);
    if (branch === POSTGRES) {
        return 'Git is off.';
    }
    const refusal = editRefusal(state, branch);
    if (refusal) {
        return refusal;
    }
    if (!message.trim()) {
        return 'Write a commit message.';
    }
    const chosen = currentChanges(state).filter(c => keys.includes(c.key));
    if (chosen.length === 0) {
        return 'Choose at least one file.';
    }
    const head = headTree(state, branch);
    const tree: Tree = { ...head };
    const overlay = { ...(s.working[branch] ?? {}) };
    for (const change of chosen) {
        for (const path of [change.path, change.from].filter((p): p is string => !!p)) {
            const value = overlay[path];
            if (value === null || value === undefined) {
                delete tree[path];
            } else {
                tree[path] = value;
            }
            delete overlay[path];
        }
    }
    const sha = commitTree(state, [state.branches[branch]!], tree, message.trim(), me(state).name, 'commit');
    state.branches[branch] = sha;
    s.working[branch] = overlay;
    log(state, `Committed ${sha} on ${branch}: ${message.trim()}`, 'ok');
    branchMoved(state, branch);
    return null;
}

export function behind(state: State, branch = currentBranch(state)): Commit[] {
    const s = server(state);
    if (!isUserBranch(branch)) {
        return [];
    }
    return commitsBetween(state, state.branches[branch], state.branches[s.settings.branch]);
}

export type Conflict = { path: string; mine: string; theirs: string; base: string };

export function update(state: State): { error?: string; conflicts?: Conflict[] } {
    const branch = currentBranch(state);
    const s = server(state);
    const refusal = isUserBranch(branch)
        ? editRefusal(state, branch)
        : `Update only brings ${s.settings.branch} into a user's branch. Merging into ${branch} would be a promotion without a PR.`;
    if (refusal) {
        log(state, refusal, 'error');
        return { error: refusal };
    }
    const ours = state.branches[branch]!;
    const theirs = state.branches[s.settings.branch]!;
    if (isAncestor(state, theirs, ours)) {
        return { error: `${branch} already has everything in ${s.settings.branch}.` };
    }
    const base = mergeBase(state, ours, theirs);
    const baseTree = base ? state.commits[base]!.tree : {};
    const merged = isAncestor(state, ours, theirs)
        ? { tree: state.commits[theirs]!.tree, conflicts: [] }
        : threeWay(baseTree, state.commits[ours]!.tree, state.commits[theirs]!.tree);
    const incoming = changesBetween(state.commits[ours]!.tree, merged.tree).flatMap(c => [c.path, c.from ?? '']);
    const dirty = Object.keys(s.working[branch] ?? {}).filter(p => incoming.includes(p));
    if (dirty.length) {
        const error = `Update refused: uncommitted changes in ${dirty.join(', ')} would be overwritten. Commit or discard them first (there is no stash).`;
        log(state, error, 'error');
        return { error };
    }
    if (merged.conflicts.length) {
        return {
            conflicts: merged.conflicts.map(path => ({
                path,
                mine: state.commits[ours]!.tree[path] ?? '',
                theirs: state.commits[theirs]!.tree[path] ?? '',
                base: baseTree[path] ?? '',
            })),
        };
    }
    finishUpdate(state, merged.tree, {});
    return {};
}

export function finishUpdate(state: State, tree: Tree, choices: Record<string, 'mine' | 'theirs'>) {
    const branch = currentBranch(state);
    const s = server(state);
    const ours = state.branches[branch]!;
    const theirs = state.branches[s.settings.branch]!;
    const final = { ...tree };
    for (const [path, choice] of Object.entries(choices)) {
        const value = (choice === 'mine' ? state.commits[ours] : state.commits[theirs])!.tree[path];
        if (value === undefined) {
            delete final[path];
        } else {
            final[path] = value;
        }
    }
    if (isAncestor(state, ours, theirs)) {
        state.branches[branch] = theirs;
        log(state, `Updated ${branch}: fast-forward to ${s.settings.branch} @ ${theirs}`, 'ok');
    } else {
        const resolved = Object.keys(choices).length
            ? ` (conflicts: ${Object.entries(choices)
                  .map(([p, c]) => `${p.split('/').pop()} = ${c}`)
                  .join(', ')})`
            : '';
        const sha = commitTree(
            state,
            [ours, theirs],
            final,
            `Merge ${s.settings.branch} into ${branch}${resolved}`,
            me(state).name,
            'update',
        );
        state.branches[branch] = sha;
        log(state, `Updated ${branch} with ${s.settings.branch}: merge commit ${sha}${resolved}`, 'ok');
    }
}

export function resolveUpdate(state: State, choices: Record<string, 'mine' | 'theirs'>) {
    const branch = currentBranch(state);
    const s = server(state);
    const ours = state.branches[branch]!;
    const theirs = state.branches[s.settings.branch]!;
    const base = mergeBase(state, ours, theirs);
    const merged = threeWay(base ? state.commits[base]!.tree : {}, state.commits[ours]!.tree, state.commits[theirs]!.tree);
    finishUpdate(state, merged.tree, choices);
}

export function openPr(state: State, kind: PrKind, from: string, to: string, title: string): Pr {
    const existing = state.prs.find(p => p.state === 'open' && p.from === from && p.to === to);
    if (existing) {
        log(state, `PR !${existing.number} from ${from} to ${to} is already open`, 'warn');
        return existing;
    }
    const pr: Pr = {
        number: state.prs.length + 1,
        kind,
        from,
        to,
        title,
        state: 'open',
        openedOn: state.session.env,
        author: me(state).name,
    };
    state.prs.push(pr);
    log(state, `Opened ${kind} PR !${pr.number} on the provider: ${from} -> ${to}`, 'ok');
    return pr;
}

export function prStatus(state: State, pr: Pr) {
    const from = state.branches[pr.from];
    const to = state.branches[pr.to];
    const commits = pr.state === 'open' ? commitsBetween(state, to, from) : [];
    if (!from || !to || pr.state !== 'open') {
        return { commits, conflicts: [] as string[], canFf: false, files: [] as ReturnType<typeof changesBetween> };
    }
    const canFf = isAncestor(state, to, from);
    const base = mergeBase(state, from, to);
    const merged = canFf
        ? { tree: state.commits[from]!.tree, conflicts: [] }
        : threeWay(base ? state.commits[base]!.tree : {}, state.commits[to]!.tree, state.commits[from]!.tree);
    return {
        commits,
        conflicts: merged.conflicts,
        canFf,
        files: changesBetween(base ? state.commits[base]!.tree : {}, state.commits[from]!.tree),
        tree: merged.tree,
    };
}

export function mergePr(state: State, number: number, method: 'merge' | 'ff' | 'squash'): Result {
    const pr = state.prs.find(p => p.number === number)!;
    const status = prStatus(state, pr);
    if (status.commits.length === 0) {
        return 'Nothing to merge.';
    }
    if (status.conflicts.length) {
        return `Conflicts in ${status.conflicts.join(', ')}: update the source branch first.`;
    }
    if (method === 'squash' && pr.kind !== 'change') {
        return 'A promotion or backport PR is never squashed: it would break ancestry.';
    }
    if (method === 'ff' && !status.canFf) {
        return 'Fast-forward is not possible: the target moved.';
    }
    const from = state.branches[pr.from]!;
    const to = state.branches[pr.to]!;
    let sha: string;
    if (method === 'ff') {
        sha = from;
    } else {
        const kind: CommitKind = pr.kind === 'promotion' ? 'promotion' : pr.kind === 'backport' ? 'backport' : 'merge';
        const parents = method === 'squash' ? [to] : [to, from];
        sha = commitTree(
            state,
            parents,
            status.tree!,
            `${method === 'squash' ? '' : `Merge ${pr.from} into ${pr.to}: `}${pr.title} (!${pr.number})`,
            'provider',
            kind,
        );
    }
    state.branches[pr.to] = sha;
    pr.state = 'merged';
    pr.mergeSha = sha;
    log(state, `PR !${pr.number} merged on the provider (${method}) -> ${pr.to} @ ${sha}`, 'ok');
    branchMoved(state, pr.to);
    return null;
}

export function closePr(state: State, number: number) {
    const pr = state.prs.find(p => p.number === number)!;
    pr.state = 'closed';
    log(state, `PR !${pr.number} closed on the provider`);
}

export function promote(state: State, targetBranch: string, sha: string): Pr {
    const s = server(state);
    const source = s.settings.branch;
    let from = source;
    if (state.branches[source] !== sha) {
        from = `promote/${source}-${sha}`;
        state.branches[from] = sha;
        state.branchMeta[from] = { createdOn: s.env };
        log(state, `Created ${from} at ${sha} (not the tip of ${source})`);
    }
    const commit = state.commits[sha]!;
    return openPr(state, 'promotion', from, targetBranch, `Promote ${source} @ ${sha} to ${targetBranch} (${commit.message})`);
}

export function backport(state: State, env: string): Pr | null {
    const source = sourceOf(state, env);
    if (!source) {
        return null;
    }
    const from = state.servers[env]!.settings.branch;
    const to = state.servers[source]!.settings.branch;
    const ahead = aheadOfSource(state, env);
    return openPr(state, 'backport', from, to, `Backport ${from} to ${to}: ${ahead.map(c => c.message).join('; ')}`);
}

export function deployNoGit(state: State, flowId: string) {
    const s = server(state);
    const tree = workingTree(state);
    const flow = parseWorkspace(tree).flows.find(f => f.id === flowId);
    if (!flow) {
        return;
    }
    const row = (s.flows[flowId] ??= { id: flowId, name: flow.name, versions: [], current: null });
    const hash = shortHash(tree[flow.path]!.replace(/^deployed: .*$/m, ''));
    if (row.versions.at(-1)?.hash !== hash) {
        row.versions.push({ n: row.versions.length + 1, sha: null, message: 'Deploy button', hash, deployedField: true, at: state.clock });
    }
    row.current = row.versions.at(-1)!.n;
    s.history.unshift(`deploy ${flow.name}: v${row.current} (Deploy button, no git)`);
    log(state, `Deployed ${flow.name} v${row.current} to ${s.env} (git off: the Deploy button)`, 'ok');
}

export function setScheduleOverride(state: State, id: string, override: Partial<ScheduleDefaults>) {
    const row = server(state).schedules[id];
    if (row) {
        row.override = override;
    }
}

export function setScheduleEnabled(state: State, id: string, enabled: boolean) {
    const row = server(state).schedules[id];
    if (row) {
        row.enabled = enabled;
        log(state, `Schedule ${id} ${enabled ? 'enabled' : 'disabled'} in ${server(state).env}`, 'ok');
    }
}

export function setSettings(state: State, env: string, settings: GitSettings, gitOn: boolean) {
    const s = state.servers[env]!;
    const wasOn = s.gitOn;
    s.settings = settings;
    s.gitOn = gitOn;
    if (!state.branches[settings.branch] && gitOn) {
        const from = state.branches[state.servers.DEV!.settings.branch]!;
        state.branches[settings.branch] = from;
        log(state, `Branch ${settings.branch} did not exist: created from dev (a guess the design does not settle)`, 'warn');
    }
    if (gitOn && !wasOn) {
        s.reconciledSha = null;
        delete s.working[POSTGRES];
        log(
            state,
            `${env}: git on. Postgres drafts are dropped, the server reconciles from ${settings.branch} (a guess: the design does not say)`,
            'warn',
        );
        reconcile(state, env);
    }
    log(state, `${env}: git settings saved`, 'ok');
}

export function testAccess(state: State, env: string, settings: GitSettings): { ok: boolean; lines: string[] } {
    const lines: string[] = [];
    if (!/^(https?:\/\/|git@|ssh:\/\/)/.test(settings.repo)) {
        return { ok: false, lines: ['The repository URL is not a git URL (https://, ssh:// or git@).'] };
    }
    if (!settings.credential) {
        return { ok: false, lines: ['No credential: choose a workspace secret that holds the access token.'] };
    }
    if (!state.secrets.includes(settings.credential)) {
        return { ok: false, lines: [`The secret ${settings.credential} does not exist in this workspace.`] };
    }
    lines.push('Reached the repository (git ls-remote) with the token in ' + settings.credential + '.');
    lines.push(
        state.branches[settings.branch]
            ? `Branch ${settings.branch} exists @ ${state.branches[settings.branch]}.`
            : `Branch ${settings.branch} does not exist yet.`,
    );
    const protectedOnProvider = settings.branch === 'staging' || settings.branch === 'prod';
    if (protectedOnProvider) {
        lines.push(`The provider protects ${settings.branch}: this token cannot push to it.`);
        if (settings.directEdits) {
            lines.push(`Conflict: "direct edits" is on, but a direct commit on ${settings.branch} would be refused by the provider.`);
        }
    } else {
        lines.push(`The token can push to ${settings.branch} and to users/*.`);
    }
    for (const target of settings.promotesTo) {
        lines.push(
            state.branches[target] ? `Promotion target ${target} exists.` : `Promotion target ${target} does not exist in the repo.`,
        );
    }
    void env;
    return { ok: !(protectedOnProvider && settings.directEdits), lines };
}

export function teammateChangesSyncOrders(state: State) {
    const branch = 'dev';
    const tip = state.branches[branch]!;
    const tree = { ...state.commits[tip]!.tree };
    const path = flowFile('Shop', 'Orders', 'Sync orders');
    const doc = parseFlow(tree[path]!);
    doc.nodes = doc.nodes.map(n => (n.id === 'fetch' ? { ...n, config: { ...n.config, timeoutSeconds: 120 } } : n));
    tree[path] = flowYaml(doc);
    const sha = commitTree(state, [tip], tree, 'Sync orders: timeout 120s', 'Bruno Costa', 'merge');
    state.branches[branch] = sha;
    log(state, `Simulated: Bruno's change to Sync orders reached dev @ ${sha}`, 'warn');
    branchMoved(state, branch);
}

export function outsideCommit(state: State, branch: string) {
    const tip = state.branches[branch]!;
    const tree = { ...state.commits[tip]!.tree };
    const path = scriptFile('Shop', 'utils/money.ts');
    tree[path] = (tree[path] ?? '') + '// edited straight in git\nexport const euros = (cents: number) => cents / 100;\n';
    const sha = commitTree(state, [tip], tree, 'money.ts: add euros() (pushed straight to git)', 'someone@laptop', 'outside');
    state.branches[branch] = sha;
    log(state, `Simulated: a commit pushed straight to ${branch} @ ${sha}; the generic webhook triggers a fetch`, 'warn');
    branchMoved(state, branch);
}

export const envForBranch = envOfBranch;
