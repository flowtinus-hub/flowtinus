import { applyOverlay, aheadFiles, backportTarget, branchKind, branchOf, brokenLineage, changesBetween, commitsBetween, CONFIG_BRANCH, connectionFile, connectionYaml, envDecl, envOfBranch, FLOW_EXT, flowFile, flowYaml, isAncestor, isDeployed, isWorkBranch, joinSegments, labelOf, merge3, mergeBase, mergeTrees, modeOf, nameProblem, ownerOf, parseFlow, parseWorkspace, POSTGRES, projectDir, rootOf, sameName, scriptFile, scriptPathProblem, shortHash, sourceOf, TOPOLOGY_FILE, topologyProblems, topologyYaml, treeAt, validateTree, versionHash, WS, type Commit, type CommitKind, type EnvDecl, type FileMeta, type FlowDoc, type GitSettings, type Overlay, type PendingMerge, type Pr, type PrKind, type ScheduleDefaults, type State, type Tree, type TreeConflict } from './model';

export type Result = string | null;

const rel = (path: string) => (path.startsWith(`${WS}/`) ? path.slice(WS.length + 1) : path);

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

export const me = (state: State) => state.users.find(u => u.slug === state.session.user)!;
export const server = (state: State) => state.servers[state.session.env]!;
export const envBranch = (state: State) => branchOf(state, state.session.env);

// ---------- reconcile ----------

export function reconcile(state: State, env: string) {
    const s = state.servers[env]!;
    const branch = branchOf(state, env);
    const sha = state.branches[branch];
    if (!s.gitOn || !sha || sha === s.reconciledSha || sha === s.refused?.sha) {
        return;
    }
    const commit = state.commits[sha]!;
    const errors = validateTree(commit.tree);
    if (errors.length) {
        s.refused = { sha, errors };
        log(
            state,
            `${env} refused ${branch} @ ${sha}: the tree is not valid (${errors.length} error${errors.length === 1 ? '' : 's'}). It stays on ${s.reconciledSha ?? 'nothing'}.`,
            'error',
        );
        return;
    }
    s.refused = null;
    const view = parseWorkspace(commit.tree);
    const seen = new Set<string>();
    const changed: string[] = [];
    for (const flow of view.flows) {
        seen.add(flow.id);
        const content = commit.tree[flow.path]!;
        const row = (s.flows[flow.id] ??= { id: flow.id, name: flow.name, versions: [], current: null });
        row.name = flow.name;
        const hash = versionHash(content);
        const deployed = isDeployed(flow.doc);
        const last = row.versions.at(-1);
        if (!last || last.hash !== hash) {
            row.versions.push({ n: row.versions.length + 1, sha, message: commit.message, hash, deployedField: deployed, at: commit.at });
            changed.push(flow.name);
            if (s.pins[flow.id] !== undefined) {
                delete s.pins[flow.id];
                s.history.unshift(`${sha} ${flow.name}: emergency pin cleared, new content arrived from git`);
            }
        } else if (last.deployedField !== deployed) {
            last.deployedField = deployed;
            changed.push(flow.name);
        }
        const before = row.current;
        row.current = s.pins[flow.id] ?? (deployed ? row.versions.at(-1)!.n : null);
        if (before !== row.current) {
            s.history.unshift(
                `${sha} ${flow.name}: ${row.current === null ? 'undeployed (deployed: false)' : `v${row.current} deployed`}${commit.kind === 'promotion' ? ' (promote)' : ''}`,
            );
        }
        for (const schedule of flow.doc.schedules ?? []) {
            if (!s.schedules[schedule.id]) {
                s.schedules[schedule.id] = { id: schedule.id, flowId: flow.id, enabled: false, override: {} };
                s.history.unshift(`${sha} schedule "${schedule.name}" of ${flow.name} arrived disabled`);
            }
        }
    }
    for (const row of Object.values(s.flows)) {
        if (!seen.has(row.id) && row.current !== null) {
            row.current = null;
            delete s.pins[row.id];
            s.history.unshift(`${sha} ${row.name}: gone from git, no longer running`);
        }
    }
    for (const decl of view.connections) {
        if (!s.connections[decl.id]) {
            s.connections[decl.id] = { id: decl.id, name: decl.name, type: decl.type, configured: false };
            s.history.unshift(`${sha} connection "${decl.name}" arrived: not configured`);
        } else {
            s.connections[decl.id]!.name = decl.name;
        }
    }
    s.scripts = Object.fromEntries(view.scripts.map(x => [x.path, shortHash(x.content)]));
    s.reconciledSha = sha;
    log(
        state,
        `${env} fetched ${branch} @ ${sha} and reconciled${changed.length ? `: ${changed.join(', ')}` : ' (no flow changed)'}`,
        'ok',
    );
}

/** the working copies of a branch that moved: each pending file is merged three ways with what arrived */
function rebaseWorkingCopies(state: State, branch: string) {
    const head = treeAt(state, state.branches[branch]);
    for (const s of Object.values(state.servers)) {
        const overlay = s.working[branch];
        const metas = s.workingMeta[branch];
        if (!overlay || !metas) {
            continue;
        }
        for (const [path, mine] of Object.entries(overlay)) {
            const meta = metas[path];
            const now = head[path] ?? null;
            if (!meta || meta.conflict || now === meta.base) {
                continue;
            }
            if (mine === now) {
                delete overlay[path];
                delete metas[path];
                continue;
            }
            if (mine !== null && now !== null && meta.base !== null) {
                const segments = merge3(meta.base, mine, now);
                if (!segments.some(x => x.kind === 'conflict')) {
                    overlay[path] = joinSegments(segments);
                    meta.base = now;
                    log(state, `${s.env}: the pending edit to ${rel(path)} was merged with what arrived on ${branch}`, 'info');
                    continue;
                }
            }
            meta.conflict = true;
            meta.theirs = now;
            log(
                state,
                `${s.env}: the pending edit to ${rel(path)} conflicts with what arrived on ${branch}. It cannot be committed until it is resolved.`,
                'warn',
            );
        }
    }
}

export function branchMoved(state: State, branch: string) {
    rebaseWorkingCopies(state, branch);
    const env = envOfBranch(state, branch);
    if (env && state.servers[env]) {
        reconcile(state, env);
    }
}

// ---------- the working copy ----------

const userKey = (state: State) => `${state.session.env}:${state.session.user}`;

export function currentBranch(state: State): string {
    const s = server(state);
    if (!s.gitOn) {
        return POSTGRES;
    }
    const chosen = state.session.branchByEnvUser[userKey(state)];
    if (chosen && (state.branches[chosen] || Object.keys(s.working[chosen] ?? {}).length)) {
        return chosen;
    }
    return envBranch(state);
}

export function headTree(state: State, branch: string): Tree {
    if (branch === POSTGRES) {
        return treeAt(state, server(state).reconciledSha);
    }
    return treeAt(state, state.branches[branch] ?? state.branches[envBranch(state)]);
}

export const workingTree = (state: State, branch = currentBranch(state)) =>
    applyOverlay(headTree(state, branch), server(state).working[branch]);

export const currentChanges = (state: State, branch = currentBranch(state)) =>
    changesBetween(headTree(state, branch), workingTree(state, branch));

export const fileMeta = (state: State, path: string, branch = currentBranch(state)): FileMeta | undefined =>
    server(state).workingMeta[branch]?.[path];

export function editRefusal(state: State, branch = currentBranch(state)): string | null {
    const s = server(state);
    if (branch === POSTGRES) {
        return null;
    }
    const label = labelOf(state, s.env);
    const mode = modeOf(state, s.env);
    if (!state.branches[branch]) {
        return `${branch} was removed on the remote. Your uncommitted changes are kept: create a branch with them, or discard them.`;
    }
    const kind = branchKind(state, branch);
    if (branch === envBranch(state)) {
        if (mode === 'direct') {
            return null;
        }
        return mode === 'pull-request'
            ? `${label} takes changes only by pull request: create a branch (users/${state.session.user}/...) and open a PR to ${branch}.`
            : `${label} is protected: only promotion and hotfix PRs reach ${branch}. For an urgent fix, create a hotfix branch.`;
    }
    if (kind === 'environment' || kind === 'config' || kind === 'promotion') {
        return `${branch} is read only here.`;
    }
    if (kind === 'backport' && backportTarget(state, branch) !== s.env) {
        return `${branch} is edited on the server of the environment it goes into.`;
    }
    if (mode === 'protected' && kind !== 'hotfix' && kind !== 'backport') {
        return `On ${label}'s server only hotfix and backport branches are edited.`;
    }
    if (mode !== 'protected' && kind === 'hotfix') {
        return `A hotfix branch is edited on the server of the environment it fixes.`;
    }
    const owner = ownerOf(branch);
    if (kind === 'user' && owner !== state.session.user) {
        return `${branch} is ${owner}'s branch: only they write on it.`;
    }
    return null;
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
    const overlay = { ...(s.working[branch] ?? {}) };
    const metas = { ...(s.workingMeta[branch] ?? {}) };
    for (const [path, content] of Object.entries(edits)) {
        overlay[path] = content;
        metas[path] = { ...(metas[path] ?? { base: head[path] ?? null }), editor: state.session.user };
    }
    for (const [path, content] of Object.entries(overlay)) {
        if (content === (head[path] ?? null) && !metas[path]?.conflict) {
            delete overlay[path];
            delete metas[path];
        }
    }
    s.working[branch] = overlay;
    s.workingMeta[branch] = metas;
    if (!quiet) {
        log(state, `${what} (working copy of ${branch === POSTGRES ? 'the Postgres draft' : branch} on ${s.env})`);
    }
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
        );
    if (problem) {
        return problem;
    }
    return editFiles(
        state,
        {
            [`${projectDir(name)}/project.yaml`]: `id: p-${shortHash(name + state.seq)}\ndescription: ""\nicon: folder\ncolor: gray\n`,
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
        );
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

const folderProblem = (name: string) =>
    nameProblem(name, 'folder') ??
    (name.toLowerCase().endsWith(FLOW_EXT) ? `A folder name cannot end in ${FLOW_EXT}: it would read as a flow.` : null);

export function createFolder(state: State, project: string, parent: string, name: string): Result {
    const { folders } = folderChildren(state, project, parent);
    const problem = folderProblem(name) ?? siblingClash(folders, name, 'folder');
    if (problem) {
        return problem;
    }
    const path = parent ? `${parent}/${name}` : name;
    return editFiles(state, { [`${projectDir(project)}/flows/${path}/.gitkeep`]: '' }, `Folder "${path}" created in ${project}`);
}

export function renameFolder(state: State, project: string, path: string, to: string): Result {
    const parent = path.split('/').slice(0, -1).join('/');
    const { folders } = folderChildren(state, project, parent);
    const old = path.split('/').pop()!;
    const problem =
        folderProblem(to) ??
        siblingClash(
            folders.filter(f => f !== old),
            to,
            'folder',
        );
    if (problem) {
        return problem;
    }
    const target = parent ? `${parent}/${to}` : to;
    return editFiles(
        state,
        moveAll(workingTree(state), `${projectDir(project)}/flows/${path}/`, `${projectDir(project)}/flows/${target}/`),
        `Folder "${path}" renamed to "${target}"`,
    );
}

function flowNameProblem(state: State, project: string, folder: string, name: string, except?: string): Result {
    const { flows } = folderChildren(state, project, folder);
    return (
        nameProblem(name, 'flow') ??
        siblingClash(
            flows.filter(f => f !== except),
            name,
            'flow',
        )
    );
}

export function createFlow(state: State, project: string, folder: string, name: string): Result {
    const problem = flowNameProblem(state, project, folder, name);
    if (problem) {
        return problem;
    }
    const doc: FlowDoc = {
        id: `f-${shortHash(`${project}/${folder}/${name}/${state.seq}`)}`,
        workerTag: 'default',
        nodes: [
            { id: 'end', type: 'End', position: { x: 260, y: 0 } },
            { id: 'start', type: 'Start', position: { x: 0, y: 0 } },
        ],
        edges: ['start -> end'],
    };
    const edits: Overlay = { [flowFile(project, folder, name)]: flowYaml(doc) };
    const keep = `${projectDir(project)}/flows/${folder}/.gitkeep`;
    if (folder && workingTree(state)[keep] !== undefined) {
        edits[keep] = null;
    }
    return editFiles(state, edits, `Flow "${name}" created (no deployed field: it runs once merged)`);
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

export function createScript(state: State, project: string, path: string): Result {
    const tree = workingTree(state);
    const existing = parseWorkspace(tree).scripts.filter(s => s.project === project);
    const problem =
        scriptPathProblem(path) ??
        (existing.some(s => sameName(s.rel, path)) ? `A script "${path}" already exists (whatever the case).` : null);
    if (problem) {
        return problem;
    }
    return editFiles(
        state,
        { [scriptFile(project, path)]: 'export function main(input: unknown) {\n    return input;\n}\n' },
        `Script "${path}" created`,
    );
}

export function renameScript(state: State, project: string, path: string, to: string): Result {
    const tree = workingTree(state);
    const view = parseWorkspace(tree);
    const problem =
        scriptPathProblem(to) ??
        (view.scripts.some(s => s.project === project && s.rel !== path && sameName(s.rel, to))
            ? `A script "${to}" already exists (whatever the case).`
            : null);
    if (problem) {
        return problem;
    }
    const edits: Overlay = { [scriptFile(project, path)]: null, [scriptFile(project, to)]: tree[scriptFile(project, path)]! };
    for (const flow of view.flows.filter(f => f.project === project)) {
        if (flow.doc.nodes.some(n => n.config?.script === path)) {
            const doc = parseFlow(tree[flow.path]!);
            doc.nodes = doc.nodes.map(n => (n.config?.script === path ? { ...n, config: { ...n.config, script: to } } : n));
            edits[flow.path] = flowYaml(doc);
        }
    }
    return editFiles(state, edits, `Script "${path}" renamed to "${to}" (the flows that call it, in the same change)`);
}

export function createConnection(state: State, name: string, type: string): Result {
    const s = server(state);
    const declared = s.gitOn ? parseWorkspace(workingTree(state)).connections.map(c => c.name) : [];
    const problem =
        nameProblem(name, 'connection') ??
        siblingClash([...declared, ...Object.values(s.connections).map(c => c.name)], name, 'connection');
    if (problem) {
        return problem;
    }
    if (s.gitOn) {
        const refusal = editRefusal(state);
        if (refusal) {
            const message =
                modeOf(state, s.env) === 'protected'
                    ? `On ${labelOf(state, s.env)} a connection is created only inside a hotfix branch. Otherwise create it in ${rootOf(state, s.env)}: it arrives here as not configured.`
                    : `Its declaration needs a branch you can write on. ${refusal}`;
            log(state, `Connection not created. ${message}`, 'error');
            return message;
        }
    }
    const id = `c-${shortHash(name + state.seq)}`;
    s.connections[id] = { id, name, type, configured: true };
    log(state, `Connection "${name}" exists in ${s.env} now (configured)`, 'ok');
    return s.gitOn ? editFiles(state, { [connectionFile(name)]: connectionYaml(id, type) }, `Connection "${name}" declared`) : null;
}

// ---------- branches ----------

const slugProblem = (slug: string) =>
    /^[a-z0-9][a-z0-9._-]*$/.test(slug)
        ? null
        : 'A branch name: lower case letters, digits, dots, dashes, underscores (it becomes a git ref).';

export function createBranch(state: State, name: string, from = currentBranch(state)): Result {
    const s = server(state);
    if (modeOf(state, s.env) === 'protected') {
        return `${labelOf(state, s.env)} is protected: create a hotfix branch instead.`;
    }
    const slug = name.trim();
    const problem = slugProblem(slug);
    if (problem) {
        return problem;
    }
    const branch = `users/${state.session.user}/${slug}`;
    if (state.branches[branch]) {
        return `${branch} already exists.`;
    }
    if (!state.branches[from]) {
        return `${from} does not exist.`;
    }
    const here = currentBranch(state);
    const removed = !state.branches[here];
    const own = removed || ownerOf(here) === state.session.user;
    const overlay = s.working[here] ?? {};
    const metas = s.workingMeta[here] ?? {};
    const paths = Object.keys(overlay).filter(p => own || metas[p]?.editor === state.session.user);
    const left = Object.keys(overlay).length - paths.length;
    const hereTree = headTree(state, here);
    const fromTree = treeAt(state, state.branches[from]);
    const clash = paths.filter(p => hereTree[p] !== fromTree[p]);
    if (clash.length) {
        return `Your uncommitted changes touch ${clash.length} file(s) that differ between ${here} and ${from} (${rel(clash[0]!)}${clash.length > 1 ? '…' : ''}): commit or discard them first.`;
    }
    state.branches[branch] = state.branches[from]!;
    if (paths.length) {
        s.working[branch] = Object.fromEntries(paths.map(p => [p, overlay[p]!]));
        s.workingMeta[branch] = Object.fromEntries(paths.map(p => [p, { ...metas[p]!, editor: state.session.user }]));
        for (const p of paths) {
            delete overlay[p];
            delete metas[p];
        }
    }
    state.session.branchByEnvUser[userKey(state)] = branch;
    log(
        state,
        `Branch ${branch} cut from ${from} @ ${state.branches[branch]} and pushed${paths.length ? `; ${paths.length} uncommitted change(s) of yours came along from ${here}` : ''}${left ? `; ${left} change(s) last edited by someone else stayed on ${here}` : ''}`,
        'ok',
    );
    return null;
}

export function createHotfix(state: State, name: string): Result {
    const s = server(state);
    if (modeOf(state, s.env) !== 'protected') {
        return 'Hotfix branches are for a protected environment.';
    }
    const slug = name.trim();
    const problem = slugProblem(slug);
    if (problem) {
        return problem;
    }
    const branch = `hotfix/${slug}`;
    if (state.branches[branch]) {
        return `${branch} already exists.`;
    }
    state.branches[branch] = state.branches[envBranch(state)]!;
    state.session.branchByEnvUser[userKey(state)] = branch;
    log(state, `Hotfix branch ${branch} cut from ${envBranch(state)} @ ${state.branches[branch]}`, 'ok');
    return null;
}

export function switchBranch(state: State, branch: string) {
    state.session.branchByEnvUser[userKey(state)] = branch;
}

export function discard(state: State, keys: string[]) {
    const branch = currentBranch(state);
    const s = server(state);
    const overlay = { ...(s.working[branch] ?? {}) };
    const metas = { ...(s.workingMeta[branch] ?? {}) };
    for (const change of currentChanges(state).filter(c => keys.includes(c.key))) {
        for (const path of [change.path, change.from]) {
            if (path) {
                delete overlay[path];
                delete metas[path];
            }
        }
    }
    s.working[branch] = overlay;
    s.workingMeta[branch] = metas;
    log(state, `Discarded ${keys.length} change(s) on ${branch}`);
}

/** a pending file that conflicts with what arrived on its branch, as the conflict screen shows it */
export function workingConflict(state: State, path: string): TreeConflict | null {
    const meta = fileMeta(state, path);
    if (!meta?.conflict) {
        return null;
    }
    const mine = server(state).working[currentBranch(state)]?.[path] ?? null;
    const theirs = meta.theirs ?? null;
    if (mine !== null && theirs !== null && meta.base !== null) {
        return { key: path, kind: 'content', path, segments: merge3(meta.base, mine, theirs) };
    }
    return mine === null
        ? { key: path, kind: 'modify-delete', path, deleted: 'mine', content: theirs ?? '' }
        : { key: path, kind: 'modify-delete', path, deleted: 'theirs', content: mine };
}

export function resolveWorkingConflict(state: State, path: string, content: string | null) {
    const branch = currentBranch(state);
    const s = server(state);
    const meta = s.workingMeta[branch]![path]!;
    const head = headTree(state, branch)[path] ?? null;
    s.working[branch]![path] = content;
    s.workingMeta[branch]![path] = { base: meta.theirs ?? null, editor: state.session.user };
    if (content === head) {
        delete s.working[branch]![path];
        delete s.workingMeta[branch]![path];
    }
    log(state, `Resolved the conflict in ${rel(path)} on ${branch}`, 'ok');
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
    const metas = { ...(s.workingMeta[branch] ?? {}) };
    const paths = chosen.flatMap(c => [c.path, c.from]).filter((p): p is string => !!p);
    const conflicted = paths.find(p => metas[p]?.conflict);
    if (conflicted) {
        return `${rel(conflicted)} conflicts with what arrived on ${branch}: resolve it first.`;
    }
    const tree: Tree = { ...headTree(state, branch) };
    const overlay = { ...(s.working[branch] ?? {}) };
    for (const path of paths) {
        const value = overlay[path];
        if (value === null || value === undefined) {
            delete tree[path];
        } else {
            tree[path] = value;
        }
    }
    const errors = validateTree(tree);
    if (errors.length) {
        return `Not committed: the workspace would not be valid. ${errors.join(' ')}`;
    }
    if (branchKind(state, branch) === 'environment' && state.providerProtected.includes(branch)) {
        const error = `The provider refused the push: it protects ${branch}, but the topology says ${labelOf(state, s.env)} is "direct". Fix one of the two. Your changes stay in the working copy; you can also create a branch with them.`;
        log(state, error, 'error');
        return error;
    }
    for (const path of paths) {
        delete overlay[path];
        delete metas[path];
    }
    const sha = commitTree(state, [state.branches[branch]!], tree, message.trim(), me(state).name, 'commit');
    state.branches[branch] = sha;
    s.working[branch] = overlay;
    s.workingMeta[branch] = metas;
    log(state, `Committed ${sha} on ${branch}: ${message.trim()}`, 'ok');
    branchMoved(state, branch);
    return null;
}

export function behind(state: State, branch = currentBranch(state)): Commit[] {
    if (!state.branches[branch] || !isWorkBranch(state, branch) || branchKind(state, branch) === 'backport') {
        return [];
    }
    return commitsBetween(state, state.branches[branch], state.branches[envBranch(state)]);
}

// ---------- merges in the app: Update and backport ----------

export function pendingMergeResult(state: State) {
    const p = state.session.pendingMerge!;
    const ours = state.branches[p.branch]!;
    if (isAncestor(state, ours, p.theirs)) {
        return { tree: treeAt(state, p.theirs), conflicts: [] as TreeConflict[], ff: true, ours };
    }
    const base = mergeBase(state, ours, p.theirs);
    return { ...mergeTrees(treeAt(state, base), treeAt(state, ours), treeAt(state, p.theirs)), ff: false, ours };
}

function startMerge(state: State, pending: Omit<PendingMerge, 'env'>): { error?: string } {
    state.session.pendingMerge = { ...pending, env: state.session.env };
    const { conflicts } = pendingMergeResult(state);
    if (conflicts.length === 0) {
        const error = finishMerge(state, {});
        return error ? { error } : {};
    }
    log(state, `${pending.message}: ${conflicts.length} conflict(s) to resolve`, 'warn');
    return {};
}

export function finishMerge(state: State, resolution: Overlay): Result {
    const p = state.session.pendingMerge;
    if (!p) {
        return 'Nothing to merge.';
    }
    const { tree, ff, ours } = pendingMergeResult(state);
    if (ff && Object.keys(resolution).length === 0) {
        state.branches[p.branch] = p.theirs;
        log(state, `${p.message}: fast-forward to ${p.theirs}`, 'ok');
    } else {
        const final = applyOverlay(tree, resolution);
        const errors = validateTree(final);
        if (errors.length) {
            return `The result is not valid yet: ${errors.join(' ')}`;
        }
        const sha = commitTree(state, [ours, p.theirs], final, p.message, me(state).name, p.kind);
        state.branches[p.branch] = sha;
        log(state, `${p.message}: merge commit ${sha}`, 'ok');
    }
    state.session.pendingMerge = null;
    branchMoved(state, p.branch);
    if (p.pr) {
        openPr(state, p.pr.kind, p.branch, p.pr.to, p.pr.title);
    }
    return null;
}

export function cancelMerge(state: State) {
    const p = state.session.pendingMerge;
    if (p?.kind === 'backport' && state.branches[p.branch] && !state.prs.some(x => x.from === p.branch)) {
        delete state.branches[p.branch];
        state.session.branchByEnvUser[userKey(state)] = envBranch(state);
    }
    state.session.pendingMerge = null;
}

export function update(state: State): { error?: string } {
    const branch = currentBranch(state);
    const env = envBranch(state);
    if (!isWorkBranch(state, branch) || branchKind(state, branch) === 'backport') {
        const error = `Update brings ${env} into a work branch. Merging into ${branch} would be a promotion without a PR.`;
        log(state, error, 'error');
        return { error };
    }
    const refusal = editRefusal(state, branch);
    if (refusal) {
        return { error: refusal };
    }
    const ours = state.branches[branch]!;
    const theirs = state.branches[env]!;
    if (isAncestor(state, theirs, ours)) {
        return { error: `${branch} already has everything in ${env}.` };
    }
    const base = mergeBase(state, ours, theirs);
    const merged = mergeTrees(treeAt(state, base), treeAt(state, ours), treeAt(state, theirs));
    const incoming = new Set(changesBetween(treeAt(state, ours), merged.tree).flatMap(c => [c.path, c.from ?? '']));
    const dirty = Object.keys(server(state).working[branch] ?? {}).filter(p => incoming.has(p));
    if (dirty.length) {
        const error = `Update refused: it brings ${dirty.map(rel).join(', ')}, which you changed and did not commit. Commit or discard first.`;
        log(state, error, 'error');
        return { error };
    }
    return startMerge(state, { branch, theirs, kind: 'update', message: `Merge ${env} into ${branch}` });
}

// ---------- pull requests ----------

export function openPr(state: State, kind: PrKind, from: string, to: string, title: string, promotedSha?: string): Pr {
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
        promotedSha,
    };
    state.prs.push(pr);
    log(state, `Opened ${kind} PR !${pr.number} on the provider: ${from} -> ${to} (squash off, remove the source branch on merge)`, 'ok');
    return pr;
}

export function prStatus(state: State, pr: Pr) {
    const from = state.branches[pr.from];
    const to = state.branches[pr.to];
    const commits = pr.state === 'open' ? commitsBetween(state, to, from) : [];
    if (!from || !to || pr.state !== 'open') {
        return { commits, conflicts: [] as TreeConflict[], canFf: false, files: [] as ReturnType<typeof changesBetween>, tree: undefined };
    }
    const canFf = isAncestor(state, to, from);
    const base = mergeBase(state, from, to);
    const merged = canFf
        ? { tree: treeAt(state, from), conflicts: [] as TreeConflict[] }
        : mergeTrees(treeAt(state, base), treeAt(state, to), treeAt(state, from));
    return { commits, conflicts: merged.conflicts, canFf, files: changesBetween(treeAt(state, to), merged.tree), tree: merged.tree };
}

/** commits of the PR that come from another unmerged work branch (a branch cut from another user's branch) */
export function borrowedCommits(state: State, branch: string, target: string): { branch: string; count: number }[] {
    const tip = state.branches[branch];
    const targetTip = state.branches[target];
    if (!tip || !targetTip) {
        return [];
    }
    return Object.keys(state.branches)
        .filter(b => b !== branch && isWorkBranch(state, b) && isAncestor(state, state.branches[b]!, tip))
        .map(b => ({ branch: b, count: commitsBetween(state, targetTip, state.branches[b]).length }))
        .filter(x => x.count > 0);
}

export function mergePr(state: State, number: number, method: 'merge' | 'ff' | 'squash'): Result {
    const pr = state.prs.find(p => p.number === number)!;
    const status = prStatus(state, pr);
    if (status.commits.length === 0) {
        return 'Nothing to merge.';
    }
    if (status.conflicts.length) {
        return 'Conflicts: update the source branch first.';
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
        const kind: CommitKind = pr.kind === 'change' ? 'merge' : pr.kind;
        sha = commitTree(
            state,
            method === 'squash' ? [to] : [to, from],
            status.tree!,
            `${method === 'squash' ? '' : `Merge ${pr.from} into ${pr.to}: `}${pr.title} (!${pr.number})`,
            'provider',
            kind,
        );
    }
    state.branches[pr.to] = sha;
    pr.state = 'merged';
    pr.mergeSha = sha;
    pr.method = method;
    log(state, `PR !${pr.number} merged on the provider (${method}) -> ${pr.to} @ ${sha}`, 'ok');
    if (branchKind(state, pr.from) !== 'environment') {
        delete state.branches[pr.from];
        log(state, `The provider removed the source branch ${pr.from}`);
    }
    branchMoved(state, pr.to);
    const env = envOfBranch(state, pr.to);
    if (pr.kind === 'promotion' && env && brokenLineage(state, env)) {
        log(
            state,
            `${env}: lineage broken, ${pr.promotedSha} is not an ancestor of ${pr.to} after a ${method}. Promotions into and out of ${env} are blocked until a repair.`,
            'error',
        );
    }
    return null;
}

export function closePr(state: State, number: number) {
    const pr = state.prs.find(p => p.number === number)!;
    pr.state = 'closed';
    log(state, `PR !${pr.number} closed on the provider`);
}

// ---------- promotion, backport, hotfix ----------

export function promotionBlockers(state: State, sourceEnv: string, targetEnv: string): string[] {
    const blockers: string[] = [];
    const ahead = aheadFiles(state, targetEnv);
    if (ahead.length) {
        blockers.push(
            `${targetEnv} is ahead of ${sourceEnv} (${ahead.length} file${ahead.length === 1 ? '' : 's'}): back-port it into ${sourceEnv} first.`,
        );
    }
    for (const env of [sourceEnv, targetEnv]) {
        if (brokenLineage(state, env)) {
            blockers.push(`${env}'s lineage is broken (a promotion was squashed or rebased): repair it first.`);
        }
    }
    return blockers;
}

export function promote(state: State, targetEnv: string, sha: string): Result {
    const sourceEnv = state.session.env;
    const blockers = promotionBlockers(state, sourceEnv, targetEnv);
    if (blockers.length) {
        return blockers.join(' ');
    }
    const source = envBranch(state);
    const from = `promote/${source}-${sha}`;
    state.branches[from] = sha;
    const commit = state.commits[sha]!;
    openPr(
        state,
        'promotion',
        from,
        branchOf(state, targetEnv),
        `Promote ${source} @ ${sha} to ${branchOf(state, targetEnv)} (${commit.message})`,
        sha,
    );
    return null;
}

export function repairLineage(state: State, env: string): Result {
    const pr = brokenLineage(state, env);
    if (!pr) {
        return null;
    }
    const branch = branchOf(state, env);
    const sha = commitTree(
        state,
        [state.branches[branch]!, pr.promotedSha!],
        treeAt(state, pr.promotedSha),
        `Repair lineage: ${branch} contains ${pr.promotedSha}`,
        me(state).name,
        'repair',
    );
    const from = `promote/${envBranch(state)}-${pr.promotedSha}-repair`;
    state.branches[from] = sha;
    openPr(
        state,
        'promotion',
        from,
        branch,
        `Repair the lineage of ${branch} (after !${pr.number} was ${pr.method === 'squash' ? 'squashed' : 'rebased'})`,
        pr.promotedSha,
    );
    return null;
}

export function startBackport(state: State, env: string): { error?: string } {
    const source = sourceOf(state, env);
    if (!source || source !== state.session.env) {
        return { error: `The backport is opened on ${source ?? env}'s server.` };
    }
    const tip = state.branches[branchOf(state, env)]!;
    const into = envBranch(state);
    const branch = `backport/${branchOf(state, env)}-${tip}`;
    if (state.prs.some(p => p.state === 'open' && p.from === branch)) {
        return { error: `The backport of ${env} @ ${tip} is already open.` };
    }
    state.branches[branch] = state.branches[into]!;
    state.session.branchByEnvUser[userKey(state)] = branch;
    const title = `Backport ${env} @ ${tip} into ${into}`;
    return startMerge(state, { branch, theirs: tip, kind: 'backport', message: title, pr: { kind: 'backport', to: into, title } });
}

// ---------- the environment's own state ----------

export function deployNoGit(state: State, flowId: string) {
    const s = server(state);
    const tree = workingTree(state);
    const flow = parseWorkspace(tree).flows.find(f => f.id === flowId);
    if (!flow) {
        return;
    }
    const content = tree[flow.path]!;
    const deployedTree = { ...treeAt(state, s.reconciledSha), [flow.path]: content };
    s.reconciledSha = commitTree(state, null, deployedTree, `Deploy ${flow.name}`, me(state).name, 'commit');
    delete s.working[POSTGRES]?.[flow.path];
    delete s.workingMeta[POSTGRES]?.[flow.path];
    const row = (s.flows[flowId] ??= { id: flowId, name: flow.name, versions: [], current: null });
    const hash = versionHash(content);
    if (row.versions.at(-1)?.hash !== hash) {
        row.versions.push({ n: row.versions.length + 1, sha: null, message: 'Deploy button', hash, deployedField: true, at: state.clock });
    }
    row.current = row.versions.at(-1)!.n;
    s.history.unshift(`deploy ${flow.name}: v${row.current} (Deploy button, no git)`);
    log(state, `Deployed ${flow.name} v${row.current} to ${s.env} (git off: the Deploy button)`, 'ok');
}

export function pinFlow(state: State, flowId: string, n: number) {
    const s = server(state);
    const row = s.flows[flowId];
    if (!row) {
        return;
    }
    s.pins[flowId] = n;
    row.current = n;
    s.history.unshift(`pin ${row.name}: v${n} (emergency, differs from git until a commit changes this flow)`);
    log(state, `${s.env}: ${row.name} pinned to v${n}. It differs from git until a commit changes this flow; the fix is a hotfix.`, 'warn');
}

export function unpinFlow(state: State, flowId: string) {
    const s = server(state);
    const row = s.flows[flowId];
    if (!row) {
        return;
    }
    delete s.pins[flowId];
    const last = row.versions.at(-1);
    row.current = last?.deployedField ? last.n : null;
    log(state, `${s.env}: pin of ${row.name} removed, back to what git says`, 'ok');
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

// ---------- settings ----------

export function saveLocalSettings(state: State, env: string, settings: GitSettings) {
    state.servers[env]!.settings = settings;
    log(state, `${env}: git settings saved`, 'ok');
}

export function saveTopology(state: State, environments: EnvDecl[]): Result {
    const problems = topologyProblems(environments);
    if (problems.length) {
        return problems.join(' ');
    }
    const tip = state.branches[CONFIG_BRANCH];
    const sha = commitTree(
        state,
        tip ? [tip] : null,
        { [TOPOLOGY_FILE]: topologyYaml(environments) },
        tip ? 'Topology changed' : 'Create the topology',
        me(state).name,
        'config',
    );
    state.branches[CONFIG_BRANCH] = sha;
    log(state, `Topology committed to ${CONFIG_BRANCH} @ ${sha}: every server reads it on its next fetch`, 'ok');
    return null;
}

export type TurnOn = { error?: string; needs?: 'branch' | 'choice'; lines?: string[] };

export function turnGitOn(state: State, env: string, opts: { createBranch?: boolean; choice?: 'git' | 'server' } = {}): TurnOn {
    const s = state.servers[env]!;
    const decl = envDecl(state, env);
    if (!decl) {
        return { error: `${env} is not in the topology on ${CONFIG_BRANCH}: add it there first.` };
    }
    const drafts = Object.keys(s.working[POSTGRES] ?? {});
    if (decl.mode === 'protected' && drafts.length) {
        return {
            error: `${env} is protected and has no working copy: publish or discard these drafts first: ${drafts.map(rel).join(', ')}.`,
        };
    }
    const branch = decl.branch;
    const source = sourceOf(state, env);
    if (!state.branches[branch]) {
        if (!opts.createBranch) {
            return {
                needs: 'branch',
                lines: [
                    source
                        ? `${branch} does not exist. It would be created from ${source}'s branch at ${state.branches[branchOf(state, source)]}: a promotion of everything on it.`
                        : `${branch} does not exist. It would be created empty: ${env} is the root of the pipeline.`,
                ],
            };
        }
        state.branches[branch] = source
            ? state.branches[branchOf(state, source)]!
            : commitTree(state, null, {}, `Create ${branch}`, me(state).name, 'initial');
        log(state, `${branch} created${source ? ` from ${branchOf(state, source)}` : ' empty'}, on confirmation`, 'ok');
    }
    const gitTree = treeAt(state, state.branches[branch]);
    const pgTree = treeAt(state, s.reconciledSha);
    const inWs = (tree: Tree) => Object.keys(tree).some(p => p.startsWith(`${WS}/`));
    const hasWs = inWs(gitTree);
    const pgHas = inWs(pgTree);
    if (hasWs && pgHas && !opts.choice) {
        return {
            needs: 'choice',
            lines: [
                `Git replaces ${env}: ${changesBetween(pgTree, gitTree).length} file(s) of what runs here change.`,
                `${env} replaces git: ${changesBetween(gitTree, pgTree).length} file(s) on ${branch} change, in one commit.`,
            ],
        };
    }
    if (!hasWs || opts.choice === 'server') {
        const outside = Object.fromEntries(Object.entries(gitTree).filter(([p]) => !p.startsWith(`${WS}/`)));
        const tree = { ...outside, '.gitattributes': '* text=auto eol=lf\n', ...pgTree };
        const sha = commitTree(
            state,
            [state.branches[branch]!],
            tree,
            hasWs ? `${env} replaces the workspace in git` : `First export from ${env}`,
            me(state).name,
            'commit',
        );
        state.branches[branch] = sha;
    } else if (opts.choice === 'git') {
        s.flows = {};
        s.pins = {};
        s.schedules = {};
    }
    s.gitOn = true;
    s.reconciledSha = null;
    s.refused = null;
    if (drafts.length) {
        const head = treeAt(state, state.branches[branch]);
        s.working[branch] = { ...s.working[POSTGRES] };
        s.workingMeta[branch] = Object.fromEntries(
            drafts.map(p => [p, { base: head[p] ?? null, editor: s.workingMeta[POSTGRES]?.[p]?.editor ?? state.session.user }]),
        );
        delete s.working[POSTGRES];
        delete s.workingMeta[POSTGRES];
        log(state, `${env}: ${drafts.length} draft(s) became the working copy of ${branch}`, 'info');
    }
    branchMoved(state, branch);
    log(state, `${env}: git on, on ${branch}`, 'ok');
    return {};
}

export function turnGitOff(state: State, env: string) {
    state.servers[env]!.gitOn = false;
    log(state, `${env}: git off, the app as today`, 'warn');
}

export function testAccess(state: State, env: string, settings: GitSettings): { ok: boolean; lines: string[] } {
    if (!/^(https?:\/\/)/.test(settings.repo)) {
        return { ok: false, lines: ['The repository URL is not an HTTP(S) git URL (SSH comes later).'] };
    }
    if (!settings.credential || !state.secrets.includes(settings.credential)) {
        return { ok: false, lines: ['Choose a workspace secret that holds the access token.'] };
    }
    const lines = [
        `Reached the repository (git ls-remote) with the token in ${settings.credential}.`,
        'Pushed and deleted flowtinus/access-check: the token can write. That does not tell whether a given branch is protected.',
    ];
    if (!state.branches[CONFIG_BRANCH]) {
        lines.push(`${CONFIG_BRANCH} does not exist: the topology has to be created first.`);
        return { ok: false, lines };
    }
    const decl = envDecl(state, settings.env);
    if (!decl) {
        lines.push(`${settings.env} is not in the topology on ${CONFIG_BRANCH}.`);
        return { ok: false, lines };
    }
    lines.push(`In the topology: ${decl.label}, branch ${decl.branch}, mode ${decl.mode}.`);
    lines.push(
        state.branches[decl.branch] ? `${decl.branch} exists @ ${state.branches[decl.branch]}.` : `${decl.branch} does not exist yet.`,
    );
    const providerProtects = state.providerProtected.includes(decl.branch);
    lines.push(`GitLab adapter: the provider ${providerProtects ? 'protects' : 'does not protect'} ${decl.branch}.`);
    let ok = true;
    if (providerProtects && decl.mode === 'direct') {
        lines.push(`They disagree: the topology says "direct", the provider refuses direct pushes. Fix one of the two.`);
        ok = false;
    }
    if (!providerProtects && decl.mode !== 'direct') {
        lines.push(
            `They disagree: the topology says "${decl.mode}", but anyone with git can push to ${decl.branch}. Protect it on the provider.`,
        );
    }
    void env;
    return { ok, lines };
}

// ---------- simulations ----------

export function teammateChangesSyncOrders(state: State) {
    const branch = branchOf(state, 'DEV');
    const tip = state.branches[branch]!;
    const tree = { ...treeAt(state, tip) };
    const path = flowFile('Shop', 'Orders', 'Sync orders');
    if (!tree[path]) {
        return;
    }
    const doc = parseFlow(tree[path]);
    doc.nodes = doc.nodes.map(n => (n.id === 'fetch' ? { ...n, config: { ...n.config, timeoutSeconds: 120 } } : n));
    tree[path] = flowYaml(doc);
    const sha = commitTree(state, [tip], tree, 'Sync orders: timeout 120s', 'Bruno Costa', 'merge');
    state.branches[branch] = sha;
    log(state, `Simulated: Bruno's change to Sync orders reached ${branch} @ ${sha}`, 'warn');
    branchMoved(state, branch);
}

export function outsideCommit(state: State, branch: string) {
    const tip = state.branches[branch]!;
    const tree = { ...treeAt(state, tip) };
    const path = scriptFile('Shop', 'utils/money.ts');
    tree[path] = (tree[path] ?? '') + '// edited straight in git\nexport const euros = (cents: number) => cents / 100;\n';
    const sha = commitTree(state, [tip], tree, 'money.ts: add euros() (pushed straight to git)', 'someone@laptop', 'outside');
    state.branches[branch] = sha;
    log(state, `Simulated: a commit pushed straight to ${branch} @ ${sha}; the generic webhook triggers a fetch`, 'warn');
    branchMoved(state, branch);
}

export function brokenPush(state: State, branch: string) {
    const tip = state.branches[branch]!;
    const tree = { ...treeAt(state, tip) };
    delete tree[scriptFile('Shop', 'transform/orders.ts')];
    const sha = commitTree(state, [tip], tree, 'Remove transform/orders.ts (still called by Sync orders)', 'someone@laptop', 'outside');
    state.branches[branch] = sha;
    log(state, `Simulated: a push to ${branch} @ ${sha} deletes a script a flow still calls`, 'warn');
    branchMoved(state, branch);
}

export function laptopBranch(state: State) {
    const name = 'fix/refunds-timeout';
    const base = state.branches[branchOf(state, 'DEV')]!;
    const tree = { ...treeAt(state, base) };
    const path = flowFile('Shop', 'Orders', 'Refunds');
    if (!tree[path]) {
        return;
    }
    const doc = parseFlow(tree[path]);
    doc.nodes = doc.nodes.map(n => (n.id === 'call' ? { ...n, config: { ...n.config, timeoutSeconds: 20 } } : n));
    tree[path] = flowYaml(doc);
    state.branches[name] = commitTree(state, [base], tree, 'Refunds: 20s timeout (from VS Code)', 'Carla (laptop)', 'outside');
    log(state, `Simulated: ${name} pushed from a laptop. The app did not create it: a shared work branch`, 'warn');
}
