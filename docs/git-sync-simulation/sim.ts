// Throwaway simulation of the git-sync branching design (docs/GIT-BRAINSTORM.md).
// Run: bun sim.ts            (from this directory; writes out/results.md and out/summary.json)
// Local repos only, under ./repos. No remote is ever contacted.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { flowChanges, flowFromYaml, flowToYaml, type FlowFile, type FlowFileNode } from '../../flowtinus.core/src/flows/flow-file.ts';
import { parse, stringify } from '../../flowtinus.core/node_modules/yaml/dist/index.js';

const ROOT = import.meta.dir;
const REPOS = join(ROOT, 'repos');
const OUT = join(ROOT, 'out');
rmSync(REPOS, { recursive: true, force: true });
rmSync(OUT, { recursive: true, force: true });
mkdirSync(REPOS, { recursive: true });
mkdirSync(OUT, { recursive: true });
writeFileSync(join(ROOT, 'empty.gitconfig'), '');

// ---------------------------------------------------------------- recording
const buf: string[] = [];
const summary: { id: string; outcome: string }[] = [];
const say = (s = '') => buf.push(s);
const section = (t: string) => say(`\n## ${t}\n`);
const sub = (t: string) => say(`\n### ${t}\n`);
const verdict = (id: string, outcome: string) => {
    summary.push({ id, outcome });
    say(`\n**RESULT ${id}:** ${outcome}\n`);
};
const trim = (s: string, max = 30) => {
    const lines = s.replace(/\s+$/, '').split('\n');
    return lines.length > max ? [...lines.slice(0, max), `... (${lines.length - max} more lines)`].join('\n') : lines.join('\n');
};

// ---------------------------------------------------------------- git
let clock = Date.parse('2026-01-01T00:00:00Z') / 1000;
function git(dir: string, args: string[], extraEnv: Record<string, string> = {}) {
    clock += 60;
    const r = Bun.spawnSync(['git', ...args], {
        cwd: dir,
        env: {
            ...process.env,
            GIT_CONFIG_GLOBAL: join(ROOT, 'empty.gitconfig'),
            GIT_CONFIG_NOSYSTEM: '1',
            GIT_TERMINAL_PROMPT: '0',
            GIT_AUTHOR_DATE: `${clock} +0000`,
            GIT_COMMITTER_DATE: `${clock} +0000`,
            LC_ALL: 'C',
            ...extraEnv,
        },
    });
    return { code: r.exitCode, out: (r.stdout.toString() + r.stderr.toString()).replace(/\r/g, '') };
}
/** run and record */
function run(dir: string, args: string[], max = 30) {
    const r = git(dir, args);
    say('```');
    say(`$ git ${args.map(a => (/\s/.test(a) ? `"${a}"` : a)).join(' ')}    [exit ${r.code}]`);
    if (r.out.trim()) {
        say(trim(r.out, max));
    }
    say('```');
    return r;
}
const q = (dir: string, args: string[]) => git(dir, args).out.trim();

function newRepo(name: string): string {
    const dir = join(REPOS, name);
    mkdirSync(dir, { recursive: true });
    git(dir, ['init', '-q', '-b', 'dev']);
    git(dir, ['config', 'user.name', 'sim']);
    git(dir, ['config', 'user.email', 'sim@example.invalid']);
    git(dir, ['config', 'core.autocrlf', 'false']);
    git(dir, ['config', 'commit.gpgsign', 'false']);
    return dir;
}
function commit(dir: string, msg: string): string {
    git(dir, ['add', '-A']);
    const r = git(dir, ['commit', '-q', '-m', msg]);
    if (r.code !== 0) {
        throw new Error(`commit failed in ${dir}: ${r.out}`);
    }
    return q(dir, ['rev-parse', '--short', 'HEAD']);
}
const checkout = (dir: string, branch: string, create = false, from?: string) => {
    const r = git(dir, ['checkout', '-q', ...(create ? ['-B', branch, ...(from ? [from] : [])] : [branch])]);
    if (r.code !== 0) {
        throw new Error(`checkout ${branch}: ${r.out}`);
    }
};
const conflicted = (dir: string) => q(dir, ['diff', '--name-only', '--diff-filter=U']).split('\n').filter(Boolean);

function hunks(text: string, maxHunks = 2, maxLines = 24): string {
    const lines = text.split('\n');
    const out: string[] = [];
    let n = 0;
    for (let i = 0; i < lines.length; i++) {
        if (lines[i]!.startsWith('<<<<<<<')) {
            n++;
            if (n > maxHunks) {
                continue;
            }
            let j = i;
            while (j < lines.length && !lines[j]!.startsWith('>>>>>>>')) {
                j++;
            }
            const h = lines.slice(Math.max(0, i - 2), j + 2);
            out.push(`@@ line ${i + 1}`, ...(h.length > maxLines ? [...h.slice(0, maxLines), `... (${h.length - maxLines} more)`] : h));
        }
    }
    return `${n} conflict hunk(s)\n${out.join('\n')}`;
}
const showHunks = (dir: string, file: string, maxHunks = 2) => {
    say('```');
    say(`# ${file}`);
    say(hunks(readFileSync(join(dir, file), 'utf8'), maxHunks));
    say('```');
};

type MergeResult = { clean: boolean; files: string[]; out: string };
/** `git merge --no-ff` = a merged PR; squash = a squashed PR; ff = fast-forward only */
function merge(
    dir: string,
    into: string,
    from: string,
    how: 'no-ff' | 'squash' | 'ff' = 'no-ff',
    cfg: string[] = [],
    max = 12,
): MergeResult {
    checkout(dir, into);
    const flags = how === 'no-ff' ? ['--no-ff', '-m', `Merge ${from} into ${into}`] : how === 'squash' ? ['--squash'] : ['--ff-only'];
    const r = run(dir, [...cfg, 'merge', ...flags, from], max);
    const files = conflicted(dir);
    const clean = r.code === 0 && files.length === 0;
    if (clean && how === 'squash') {
        git(dir, ['commit', '-q', '-m', `Squash ${from} into ${into}`]);
    }
    return { clean, files, out: r.out };
}

// ---------------------------------------------------------------- fake data
function rng(seed: number) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
const uuid = (r: () => number) => {
    const h = (n: number) => Array.from({ length: n }, () => Math.floor(r() * 16).toString(16)).join('');
    return `${h(8)}-${h(4)}-4${h(3)}-a${h(3)}-${h(12)}`;
};

type Mode = 'sorted' | 'insertion';
const WS = 'acme';
const PROJECT = 'Billing';
const P = `${WS}/${PROJECT}`;
const CONN = {
    erp: '11111111-aaaa-4aaa-aaaa-000000000001',
    dwh: '55555555-bbbb-4bbb-bbbb-000000000002',
    crm: '99999999-cccc-4ccc-cccc-000000000003',
    mail: 'dddddddd-dddd-4ddd-addd-000000000004'.replace(' ', ''),
};

const sql = (i: number) =>
    [
        'SELECT o.id, o.customerId, o.total, o.updatedAt',
        `FROM dbo.Orders_${i} o`,
        'JOIN dbo.Customer c ON c.id = o.customerId',
        'WHERE o.updatedAt > @since',
        "  AND o.status IN ('paid', 'shipped')",
        'ORDER BY o.updatedAt',
        '',
    ].join('\n');
const code = (i: number) =>
    [
        "import { toIso } from 'lib/dates';",
        '',
        'export default function (data: Record<string, unknown>) {',
        `    const total = Number(data.total ?? 0) * ${i};`,
        '    return { ...data, total, at: toIso(new Date()) };',
        '}',
        '',
    ].join('\n');

const KINDS: { type: string; label: string; config: (i: number) => Record<string, unknown> }[] = [
    {
        type: 'sqlserver',
        label: 'Query',
        config: i => ({
            connection: i % 2 ? CONN.erp : CONN.dwh,
            sql: sql(i),
            parameters: [{ name: 'since', value: '$PARAMETERS.since', expression: true }],
            timeoutS: 30,
        }),
    },
    { type: 'filter', label: 'Filter', config: i => ({ condition: `$total > ${i * 10} && $customerId != null` }) },
    {
        type: 'mapper',
        label: 'Map',
        config: i => ({
            fields: [
                { target: 'net', value: `$total / 1.${i}`, expression: true },
                { target: 'source', value: 'erp', expression: false },
            ],
        }),
    },
    { type: 'typescript', label: 'Code', config: i => ({ code: code(i) }) },
    {
        type: 'script',
        label: 'Tax',
        config: () => ({ function: 'pricing/tax#total', arguments: [{ name: 'amount', value: '$net', expression: true }] }),
    },
    {
        type: 'http-request',
        label: 'Send',
        config: i => ({
            connection: CONN.crm,
            method: 'POST',
            url: { value: `https://crm.example.invalid/orders/${i}`, expression: false },
            body: { value: '{id: $id, total: $total}', expression: true },
        }),
    },
    { type: 'log', label: 'Log', config: i => ({ level: 'info', message: `\`step ${i}: order \${$id}\`` }) },
];

function makeNode(r: () => number, kind: number, i: number, x: number, y: number): FlowFileNode {
    const k = KINDS[kind % KINDS.length]!;
    return { id: uuid(r), type: k.type, label: `${k.label} ${i}`, position: { x, y }, config: k.config(i) };
}

/** a chain start -> n1 -> ... -> nk -> end, with a few side Log branches; nodes and edges in creation (insertion) order */
function makeFlow(name: string, total: number, seed: number): FlowFile {
    const r = rng(seed);
    const flow: FlowFile = {
        version: 1,
        id: uuid(r),
        name,
        nodes: [
            {
                id: 'start',
                type: 'start',
                position: { x: 0, y: 0 },
                config: { parameters: [{ name: 'since', type: 'text', default: '2026-01-01' }] },
            },
            { id: 'end', type: 'end', position: { x: 300 * total, y: 0 }, config: {} },
        ],
        edges: [],
        groups: [
            { id: uuid(r), title: 'Extract', color: '#2563eb', position: { x: 250, y: -80 }, size: { width: 900, height: 320 } },
            { id: uuid(r), title: 'Deliver', color: '#16a34a', position: { x: 1200, y: -80 }, size: { width: 1500, height: 320 } },
        ],
    };
    const side = Math.max(1, Math.floor((total - 2) / 6));
    const chain = total - 2 - side;
    let prev = 'start';
    for (let i = 1; i <= chain; i++) {
        const n = makeNode(r, i - 1, i, 300 * i, 0);
        flow.nodes.push(n);
        flow.edges.push({ source: prev, sourcePort: 'out-0', target: n.id, targetPort: 'in-0' });
        prev = n.id;
    }
    flow.edges.push({ source: prev, sourcePort: 'out-0', target: 'end', targetPort: 'in-0' });
    for (let s = 0; s < side; s++) {
        const at = flow.nodes[2 + s * 5]!;
        const n = makeNode(r, 6, 100 + s, at.position.x + 150, 200);
        flow.nodes.push(n);
        flow.edges.push({ source: at.id, sourcePort: 'out-0', target: n.id, targetPort: 'in-0' });
        flow.edges.push({ source: n.id, sourcePort: 'out-0', target: 'end', targetPort: 'in-0' });
    }
    return flow;
}

const sortKeys = (v: unknown): unknown =>
    Array.isArray(v)
        ? v.map(sortKeys)
        : v && typeof v === 'object'
          ? Object.fromEntries(
                Object.keys(v as object)
                    .sort()
                    .map(k => [k, sortKeys((v as Record<string, unknown>)[k])]),
            )
          : v;
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const edgeKey = (e: { source: string; sourcePort: string; target: string; targetPort: string }) =>
    [e.source, e.sourcePort, e.target, e.targetPort].join('|');

/** the git writer: `sorted` is the design's canonical order (nodes by id, edges by source/target, config keys a-z, no pinned) */
function serialize(flow: FlowFile, mode: Mode): string {
    const nodes = flow.nodes.map(({ pinned: _p, ...n }) =>
        mode === 'sorted' ? { ...n, config: sortKeys(n.config) as Record<string, unknown> } : n,
    );
    const edges = [...flow.edges];
    if (mode === 'sorted') {
        nodes.sort((a, b) => cmp(a.id, b.id));
        edges.sort((a, b) => cmp(edgeKey(a), edgeKey(b)));
    }
    return flowToYaml({ ...flow, nodes, edges });
}

const readFlow = (dir: string, path: string) => parse(readFileSync(join(dir, path), 'utf8')) as FlowFile;
function writeFlow(dir: string, path: string, flow: FlowFile, mode: Mode) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), serialize(flow, mode));
}
function edit(dir: string, path: string, mode: Mode, fn: (f: FlowFile) => void) {
    const f = readFlow(dir, path);
    fn(f);
    writeFlow(dir, path, f, mode);
}
const node = (f: FlowFile, label: string) => {
    const n = f.nodes.find(x => x.label === label || x.id === label);
    if (!n) {
        throw new Error(`no node ${label} in ${f.name}`);
    }
    return n;
};
function setLine(f: FlowFile, label: string, key: string, line: number, text: string) {
    const n = node(f, label);
    const lines = String(n.config[key]).split('\n');
    lines[line] = text;
    n.config[key] = lines.join('\n');
}
/** between: src -> new -> (src's first chain target); otherwise a side branch src -> new -> end */
function addNode(f: FlowFile, srcLabel: string, n: FlowFileNode, between: boolean) {
    const src = node(f, srcLabel);
    f.nodes.push(n);
    if (between) {
        const i = f.edges.findIndex(e => e.source === src.id);
        const old = f.edges[i]!;
        f.edges.splice(i, 1);
        f.edges.push({ source: src.id, sourcePort: 'out-0', target: n.id, targetPort: 'in-0' });
        f.edges.push({ source: n.id, sourcePort: 'out-0', target: old.target, targetPort: old.targetPort });
    } else {
        f.edges.push({ source: src.id, sourcePort: 'out-0', target: n.id, targetPort: 'in-0' });
        f.edges.push({ source: n.id, sourcePort: 'out-0', target: 'end', targetPort: 'in-0' });
    }
}
function removeNode(f: FlowFile, label: string) {
    const n = node(f, label);
    const ins = f.edges.filter(e => e.target === n.id);
    const outs = f.edges.filter(e => e.source === n.id);
    f.nodes = f.nodes.filter(x => x.id !== n.id);
    f.edges = f.edges.filter(e => e.source !== n.id && e.target !== n.id);
    for (const i of ins) {
        for (const o of outs) {
            if (!f.edges.some(e => e.source === i.source && e.target === o.target)) {
                f.edges.push({ source: i.source, sourcePort: i.sourcePort, target: o.target, targetPort: o.targetPort });
            }
        }
    }
}

const F = {
    orders: `${P}/flows/Sales/Load orders.yaml`,
    customers: `${P}/flows/Sales/Sync customers.yaml`,
    invoices: `${P}/flows/Finance/Monthly invoices.yaml`,
};
type Conn = { id: string; name: string; type: string };
const BASE_CONNS: Conn[] = [
    { id: CONN.erp, name: 'ERP', type: 'sqlserver' },
    { id: CONN.dwh, name: 'Warehouse', type: 'sqlserver' },
    { id: CONN.crm, name: 'CRM API', type: 'http' },
    { id: CONN.mail, name: 'Mail API', type: 'http' },
];
type WsFormat = 'list-append' | 'list-sorted' | 'map-sorted' | 'file-per';
function writeConns(dir: string, conns: Conn[], format: WsFormat) {
    const file = join(dir, WS, 'workspace.yaml');
    mkdirSync(dirname(file), { recursive: true });
    if (format === 'file-per') {
        writeFileSync(file, stringify({ name: WS }));
        mkdirSync(join(dir, WS, 'connections'), { recursive: true });
        for (const c of conns) {
            writeFileSync(join(dir, WS, 'connections', `${c.id}.yaml`), stringify(c));
        }
        return;
    }
    const sorted = format === 'list-append' ? conns : [...conns].sort((a, b) => cmp(a.id, b.id));
    const connections = format === 'map-sorted' ? Object.fromEntries(sorted.map(c => [c.id, { name: c.name, type: c.type }])) : sorted;
    writeFileSync(file, stringify({ name: WS, connections }));
}
function readConns(dir: string): Conn[] {
    const d = join(dir, WS, 'connections');
    if (existsSync(d)) {
        return readdirSync(d).map(f => parse(readFileSync(join(d, f), 'utf8')) as Conn);
    }
    const w = parse(readFileSync(join(dir, WS, 'workspace.yaml'), 'utf8')) as { connections: Conn[] | Record<string, Omit<Conn, 'id'>> };
    return Array.isArray(w.connections) ? w.connections : Object.entries(w.connections).map(([id, c]) => ({ id, ...c }));
}

function seed(dir: string, mode: Mode, format: WsFormat = 'list-append') {
    writeConns(dir, BASE_CONNS, format);
    writeFileSync(join(dir, P, '..', '.keep'), '');
    mkdirSync(join(dir, P, 'scripts/lib'), { recursive: true });
    mkdirSync(join(dir, P, 'scripts/pricing'), { recursive: true });
    writeFileSync(
        join(dir, P, 'project.yaml'),
        stringify({ id: 'p-billing', description: 'Billing flows', icon: 'receipt', color: '#2563eb' }),
    );
    writeFileSync(join(dir, P, 'scripts/lib/dates.ts'), 'export const toIso = (d: Date) => d.toISOString();\n');
    writeFileSync(
        join(dir, P, 'scripts/pricing/tax.ts'),
        "import { toIso } from '../lib/dates';\n\nexport function total(amount: number) {\n    return { amount: amount * 1.23, at: toIso(new Date()) };\n}\n",
    );
    writeFlow(dir, F.orders, makeFlow('Load orders', 20, 1), mode);
    writeFlow(dir, F.customers, makeFlow('Sync customers', 12, 2), mode);
    writeFlow(dir, F.invoices, makeFlow('Monthly invoices', 28, 3), mode);
    commit(dir, 'seed workspace');
}

// ---------------------------------------------------------------- validation
function walk(dir: string, out: string[] = []): string[] {
    for (const f of readdirSync(dir)) {
        if (f === '.git') {
            continue;
        }
        const p = join(dir, f);
        if (statSync(p).isDirectory()) {
            walk(p, out);
        } else {
            out.push(p.slice(0).replace(/\\/g, '/'));
        }
    }
    return out;
}
/** is this text a valid flow file (the core's own reader: parses, ids unique, edges on existing nodes and ports) */
function flowIssues(text: string): string[] {
    if (/^(<<<<<<<|>>>>>>>|=======)/m.test(text)) {
        return ['has conflict markers'];
    }
    const r = flowFromYaml(text);
    return r.ok ? [] : r.errors;
}
/** what a post-merge validation of the whole tree finds */
function repoIssues(dir: string): string[] {
    const issues: string[] = [];
    const root = dir.replace(/\\/g, '/');
    const files = walk(dir).map(f => f.slice(root.length + 1));
    let conns: Conn[] = [];
    try {
        conns = readConns(dir);
    } catch (e) {
        issues.push(`workspace.yaml: ${(e as Error).message.split('\n')[0]}`);
    }
    const connIds = new Set(conns.map(c => c.id));
    const names = conns.map(c => c.name.toLowerCase());
    for (const n of new Set(names.filter((x, i) => names.indexOf(x) !== i))) {
        issues.push(`connection name "${n}" declared twice`);
    }
    const flows = files.filter(f => /\/flows\/.*\.yaml$/.test(f));
    const byId = new Map<string, string[]>();
    const parsed: { path: string; flow: FlowFile }[] = [];
    for (const path of flows) {
        const text = readFileSync(join(dir, path), 'utf8');
        const bad = flowIssues(text);
        if (bad.length) {
            issues.push(...bad.map(b => `${path}: ${b}`));
            if (bad[0] === 'has conflict markers') {
                continue;
            }
        }
        let flow: FlowFile;
        try {
            flow = parse(text) as FlowFile;
        } catch {
            continue;
        }
        parsed.push({ path, flow });
        byId.set(flow.id ?? '', [...(byId.get(flow.id ?? '') ?? []), path]);
        if (`${flow.name}.yaml` !== path.split('/').pop()) {
            issues.push(`${path}: file name does not match the flow's name "${flow.name}"`);
        }
    }
    for (const [id, paths] of byId) {
        if (paths.length > 1) {
            issues.push(`flow id ${id} is in ${paths.length} files: ${paths.join(', ')}`);
        }
    }
    for (const { path, flow } of parsed) {
        const project = path.split('/flows/')[0]!;
        for (const n of flow.nodes ?? []) {
            const c = n.config?.connection;
            if (typeof c === 'string' && c && c !== '$dynamic' && !connIds.has(c)) {
                issues.push(`${path}: node "${n.label}" uses connection ${c}, not declared in workspace.yaml`);
            }
            if (n.type === 'script' && typeof n.config?.function === 'string') {
                const script = `${project}/scripts/${n.config.function.split('#')[0]}.ts`;
                if (!files.includes(script)) {
                    issues.push(`${path}: node "${n.label}" calls ${n.config.function}, but ${script} does not exist`);
                }
            }
            if (n.type === 'flow' && typeof n.config?.flowId === 'string' && !byId.has(n.config.flowId)) {
                issues.push(`${path}: node "${n.label}" calls flow ${n.config.flowId}, which is not in the repo`);
            }
        }
    }
    for (const s of files.filter(f => /\/scripts\/.*\.ts$/.test(f))) {
        for (const m of readFileSync(join(dir, s), 'utf8').matchAll(/from '(\.[^']+)'/g)) {
            const target = join(dirname(s), `${m[1]}.ts`).replace(/\\/g, '/');
            if (!files.includes(target)) {
                issues.push(`${s}: imports ${m[1]}, but ${target} does not exist`);
            }
        }
    }
    return issues;
}
const sayIssues = (label: string, issues: string[]) => {
    say(`${label}: ${issues.length ? `${issues.length} issue(s)` : 'valid (0 issues)'}`);
    for (const i of issues.slice(0, 6)) {
        say(`- ${i}`);
    }
    say('');
};
const validity = (dir: string) => {
    const i = repoIssues(dir);
    return i.length ? `INVALID (${i[0]})` : 'valid';
};

/** is `env` ahead of `source`? commits that are not merges, and whether merging env into source would change source's tree */
function ahead(dir: string, source: string, env: string) {
    const commits = Number(q(dir, ['rev-list', '--count', '--no-merges', `${source}..${env}`]));
    const all = Number(q(dir, ['rev-list', '--count', `${source}..${env}`]));
    const mt = git(dir, ['merge-tree', '--write-tree', source, env]);
    const tree = mt.out.split('\n')[0]!.trim();
    const changes = mt.code !== 0 ? 'conflict' : tree === q(dir, ['rev-parse', `${source}^{tree}`]) ? 'no' : 'yes';
    return { all, commits, changes };
}
const aheadText = (dir: string, source: string, env: string) => {
    const a = ahead(dir, source, env);
    return `${env} vs ${source}: rev-list ${source}..${env} = ${a.all} (no-merges: ${a.commits}); merging ${env} into ${source} would change ${source}: ${a.changes}`;
};

// ---------------------------------------------------------------- shared rounds of dev work
const R = rng(99);
const AUDIT = makeNode(R, 6, 900, 450, -200);
AUDIT.label = 'Audit';
const rounds: ((dir: string, mode: Mode) => void)[] = [
    (dir, mode) => {
        edit(dir, F.orders, mode, f => {
            setLine(f, 'Query 1', 'sql', 3, 'WHERE o.updatedAt >= @since');
            addNode(f, 'Query 1', structuredClone(AUDIT), true);
        });
        commit(dir, 'round 1: Load orders: >= since, add Audit after Query 1');
    },
    (dir, mode) => {
        edit(dir, F.orders, mode, f => setLine(f, 'Query 1', 'sql', 3, 'WHERE o.updatedAt >= DATEADD(day, -1, @since)'));
        edit(dir, F.customers, mode, f => (node(f, 'Filter 2').config.condition = '$total > 50'));
        commit(dir, 'round 2: Load orders: one day of overlap; Sync customers: filter');
    },
    (dir, mode) => {
        edit(dir, F.orders, mode, f => removeNode(f, 'Audit'));
        edit(dir, F.invoices, mode, f => setLine(f, 'Code 4', 'code', 3, '    const total = Number(data.total ?? 0) * 1.5;'));
        commit(dir, 'round 3: Load orders: remove Audit again; Monthly invoices: code');
    },
];
function envs(dir: string) {
    git(dir, ['branch', 'staging', 'dev']);
    git(dir, ['branch', 'prod', 'dev']);
}
const same = (dir: string, a: string, b: string) => (git(dir, ['diff', '--quiet', a, b]).code === 0 ? 'identical' : 'DIFFERENT');

// ================================================================ 1
function s1() {
    section('Scenario 1: promotion chain with merge commits, three rounds');
    for (const how of ['no-ff', 'ff'] as const) {
        sub(`1 (${how === 'no-ff' ? 'merge commits' : 'fast-forward only'})`);
        const dir = newRepo(`s1-${how}`);
        seed(dir, 'sorted');
        envs(dir);
        const res: string[] = [];
        for (let i = 0; i < 3; i++) {
            checkout(dir, 'dev');
            rounds[i]!(dir, 'sorted');
            say(`Round ${i + 1}: before promotion, commits on dev not in staging: ${q(dir, ['rev-list', '--count', 'staging..dev'])}`);
            const a = merge(dir, 'staging', 'dev', how, [], 4);
            const b = merge(dir, 'prod', 'staging', how, [], 4);
            res.push(`r${i + 1}: staging ${a.clean ? 'clean' : 'CONFLICT'}, prod ${b.clean ? 'clean' : 'CONFLICT'}`);
            say(
                `Round ${i + 1}: trees dev/staging ${same(dir, 'dev', 'staging')}, staging/prod ${same(dir, 'staging', 'prod')}; staging..dev = ${q(dir, ['rev-list', '--count', 'staging..dev'])}; ${validity(dir)}`,
            );
        }
        say('\nWhat has been promoted, from git alone:');
        checkout(dir, 'dev');
        edit(dir, F.customers, 'sorted', f => (node(f, 'Filter 2').config.condition = '$total > 75'));
        const pending = commit(dir, 'round 4 (not promoted yet)');
        run(dir, ['log', '--oneline', 'staging..dev']);
        run(dir, ['diff', '--stat', 'staging...dev']);
        run(dir, ['merge-base', '--is-ancestor', pending, 'staging']);
        run(dir, ['merge-base', '--is-ancestor', 'dev~1', 'prod']);
        run(dir, ['branch', '--contains', 'dev~1']);
        run(dir, ['log', '--oneline', '--graph', '-8', 'prod']);
        say(aheadText(dir, 'dev', 'staging'));
        say(aheadText(dir, 'staging', 'prod'));
        verdict(`1-${how}`, res.join('; '));
    }
}

// ================================================================ 2
function s2() {
    section('Scenario 2: the same chain, promotion PRs squashed');
    const dir = newRepo('s2-squash');
    seed(dir, 'sorted');
    envs(dir);
    const res: string[] = [];
    for (let i = 0; i < 3; i++) {
        sub(`2 round ${i + 1}`);
        checkout(dir, 'dev');
        rounds[i]!(dir, 'sorted');
        for (const [into, from] of [
            ['staging', 'dev'],
            ['prod', 'staging'],
        ] as const) {
            const m = merge(dir, into, from, 'squash', [], 6);
            if (!m.clean) {
                for (const f of m.files) {
                    showHunks(dir, f, 1);
                    git(dir, ['checkout', '--theirs', '--', f]);
                }
                say(`(resolved by taking the whole file from ${from})`);
                commit(dir, `Squash ${from} into ${into} (conflict resolved: theirs)`);
            }
            res.push(`r${i + 1} ${from}->${into}: ${m.clean ? 'clean' : `CONFLICT in ${m.files.length} file(s)`}`);
        }
        say(
            `After round ${i + 1}: trees dev/staging ${same(dir, 'dev', 'staging')}, staging/prod ${same(dir, 'staging', 'prod')}; rev-list staging..dev = ${q(dir, ['rev-list', '--count', 'staging..dev'])}; merge-base(dev, staging) = ${q(dir, ['log', '-1', '--format=%h %s', q(dir, ['merge-base', 'dev', 'staging'])])}`,
        );
    }
    sub('2 after round 3: the silent wrong result');
    run(dir, ['diff', '--stat', 'dev', 'staging']);
    const dev = parse(q(dir, ['show', `dev:${F.orders}`])) as FlowFile;
    const stg = parse(q(dir, ['show', `staging:${F.orders}`])) as FlowFile;
    say(
        `Audit node on dev: ${dev.nodes.some(n => n.label === 'Audit')}; on staging: ${stg.nodes.some(n => n.label === 'Audit')}; on prod: ${(parse(q(dir, ['show', `prod:${F.orders}`])) as FlowFile).nodes.some(n => n.label === 'Audit')}`,
    );
    checkout(dir, 'staging');
    sayIssues('staging tree', repoIssues(dir));
    verdict('2', res.join('; ') + `; after r3 dev/staging trees ${same(dir, 'dev', 'staging')}`);
}

// ================================================================ 3
function s3() {
    section('Scenario 3: hotfix committed directly on prod');
    const HOT = "  AND o.status IN ('paid', 'shipped', 'refunded')";
    const base = (name: string) => {
        const dir = newRepo(name);
        seed(dir, 'sorted');
        envs(dir);
        rounds[0]!(dir, 'sorted');
        git(dir, ['checkout', '-q', 'staging']);
        git(dir, ['merge', '-q', '--no-ff', '-m', 'Merge dev into staging', 'dev']);
        git(dir, ['checkout', '-q', 'prod']);
        git(dir, ['merge', '-q', '--no-ff', '-m', 'Merge staging into prod', 'staging']);
        edit(dir, F.orders, 'sorted', f => setLine(f, 'Query 1', 'sql', 4, HOT));
        commit(dir, 'HOTFIX on prod: include refunded orders');
        return dir;
    };
    const promote = (dir: string) => {
        const a = merge(dir, 'staging', 'dev', 'no-ff', [], 5);
        const b = merge(dir, 'prod', 'staging', 'no-ff', [], 5);
        if (!b.clean) {
            for (const f of b.files) {
                showHunks(dir, f, 1);
            }
        }
        return { a, b };
    };
    const hot = (dir: string, ref: string) => q(dir, ['show', `${ref}:${F.orders}`]).includes("'refunded'");
    const where = (dir: string) => `hotfix present in dev: ${hot(dir, 'dev')}, staging: ${hot(dir, 'staging')}, prod: ${hot(dir, 'prod')}`;

    sub('3a: back-ported to dev by a merge, then dev changes the same query, then promotion');
    {
        const dir = base('s3a');
        say(aheadText(dir, 'staging', 'prod'));
        say(aheadText(dir, 'dev', 'prod'));
        const bp = merge(dir, 'dev', 'prod', 'no-ff', [], 5);
        say(aheadText(dir, 'dev', 'prod'));
        run(dir, ['merge-base', '--is-ancestor', 'staging', 'dev']);
        run(dir, ['merge-base', '--is-ancestor', 'prod', 'dev']);
        edit(dir, F.orders, 'sorted', f => setLine(f, 'Query 1', 'sql', 4, "  AND o.status IN ('paid', 'shipped', 'refunded', 'partial')"));
        commit(dir, 'dev: also partial orders (builds on the hotfix)');
        const { a, b } = promote(dir);
        say(where(dir));
        say(`trees dev/staging ${same(dir, 'dev', 'staging')}, staging/prod ${same(dir, 'staging', 'prod')}; ${validity(dir)}`);
        verdict(
            '3a',
            `backport merge ${bp.clean ? 'clean' : 'CONFLICT'}; next promotion: staging ${a.clean ? 'clean' : 'CONFLICT'}, prod ${b.clean ? 'clean' : 'CONFLICT'}; all three trees end identical`,
        );
    }
    sub('3b1: never back-ported, dev changes the same line of the same flow');
    {
        const dir = base('s3b1');
        checkout(dir, 'dev');
        edit(dir, F.orders, 'sorted', f => setLine(f, 'Query 1', 'sql', 4, "  AND o.status IN ('paid', 'shipped', 'partial')"));
        commit(dir, 'dev: also partial orders (does not know the hotfix)');
        const { a, b } = promote(dir);
        say(where(dir).replace('prod: true', 'prod: (conflicted)'));
        verdict('3b1', `staging ${a.clean ? 'clean' : 'CONFLICT'}; prod ${b.clean ? 'clean' : `CONFLICT in ${b.files.join(', ')}`}`);
    }
    sub('3b2: never back-ported, dev changes another node of the same flow');
    {
        const dir = base('s3b2');
        checkout(dir, 'dev');
        edit(dir, F.orders, 'sorted', f => (node(f, 'Filter 2').config.condition = '$total > 100'));
        commit(dir, 'dev: filter threshold');
        const { a, b } = promote(dir);
        say(where(dir));
        say(aheadText(dir, 'staging', 'prod'));
        run(dir, ['log', '--oneline', '--no-merges', 'staging..prod']);
        run(dir, ['diff', '--stat', 'staging', 'prod']);
        verdict(
            '3b2',
            `staging ${a.clean ? 'clean' : 'CONFLICT'}; prod ${b.clean ? 'clean' : 'CONFLICT'}; ${where(dir)}; ${validity(dir)}`,
        );
    }
    sub('3c: never back-ported, dev changes a different flow');
    {
        const dir = base('s3c');
        checkout(dir, 'dev');
        edit(dir, F.invoices, 'sorted', f => (node(f, 'Filter 2').config.condition = '$total > 100'));
        commit(dir, 'dev: invoices filter threshold');
        const { a, b } = promote(dir);
        say(where(dir));
        say(aheadText(dir, 'staging', 'prod'));
        verdict('3c', `staging ${a.clean ? 'clean' : 'CONFLICT'}; prod ${b.clean ? 'clean' : 'CONFLICT'}; ${where(dir)}`);
    }
    sub('3d: back-ported by cherry-pick (or a squashed backport PR) instead of a merge');
    {
        const dir = base('s3d');
        checkout(dir, 'dev');
        run(dir, ['cherry-pick', 'prod'], 4);
        const { a, b } = promote(dir);
        say(where(dir));
        say(aheadText(dir, 'dev', 'prod'));
        run(dir, ['cherry', 'dev', 'prod']);
        verdict(
            '3d',
            `staging ${a.clean ? 'clean' : 'CONFLICT'}; prod ${b.clean ? 'clean' : 'CONFLICT'}; but ${aheadText(dir, 'dev', 'prod')}`,
        );
    }
}

// ================================================================ 4
type Case = { id: string; what: string; alice: (f: FlowFile, r: () => number) => void; bob: (f: FlowFile, r: () => number) => void };
const moveAll = (f: FlowFile) => {
    for (const n of f.nodes) {
        n.position = { x: n.position.x + 40, y: n.position.y + 120 };
    }
};
const CASES: Case[] = [
    {
        id: '4a',
        what: 'different nodes (config of Query 1 vs config of Filter 9)',
        alice: f => setLine(f, 'Query 1', 'sql', 3, 'WHERE o.updatedAt >= @since'),
        bob: f => (node(f, 'Filter 9').config.condition = '$total > 999'),
    },
    {
        id: '4b1',
        what: "the same node's config, the same SQL line",
        alice: f => setLine(f, 'Query 1', 'sql', 3, 'WHERE o.updatedAt >= @since'),
        bob: f => setLine(f, 'Query 1', 'sql', 3, 'WHERE o.updatedAt > DATEADD(day, -7, @since)'),
    },
    {
        id: '4b2',
        what: "the same node's config, different existing keys (a middle SQL line vs timeoutS)",
        alice: f => setLine(f, 'Query 1', 'sql', 2, 'LEFT JOIN dbo.Customer c ON c.id = o.customerId'),
        bob: f => (node(f, 'Query 1').config.timeoutS = 120),
    },
    {
        id: '4b3',
        what: "the same node's config, each adds a new key (onError vs outputKey-like `retries`)",
        alice: f => (node(f, 'Query 1').config.onError = 'continue'),
        bob: f => (node(f, 'Query 1').config.retries = 3),
    },
    {
        id: '4b4',
        what: "the same node's config, the last SQL line vs timeoutS (adjacent lines in sorted order)",
        alice: f => setLine(f, 'Query 1', 'sql', 5, 'ORDER BY o.updatedAt DESC'),
        bob: f => (node(f, 'Query 1').config.timeoutS = 120),
    },
    {
        id: '4c1',
        what: 'one moves every node (positions), the other changes a SQL line',
        alice: moveAll,
        bob: f => setLine(f, 'Query 1', 'sql', 3, 'WHERE o.updatedAt >= @since'),
    },
    {
        id: '4c2',
        what: "one moves every node, the other changes the node's first config key (the line right after `config:`)",
        alice: moveAll,
        bob: f => {
            node(f, 'Query 1').config.connection = CONN.dwh;
            node(f, 'Filter 2').config.condition = '$total > 1';
        },
    },
    {
        id: '4c3',
        what: 'one moves every node, the other renames a node (label, the line right before `position:`)',
        alice: moveAll,
        bob: f => (node(f, 'Query 1').label = 'Read paid orders'),
    },
    {
        id: '4d1',
        what: 'both add a node and its edges, as side branches off different nodes',
        alice: (f, r) => addNode(f, 'Map 3', makeNode(r, 6, 201, 1000, 400), false),
        bob: (f, r) => addNode(f, 'Query 8', makeNode(r, 1, 202, 2500, 400), false),
    },
    {
        id: '4d2',
        what: 'both add a node as a side branch off the same node',
        alice: (f, r) => addNode(f, 'Map 3', makeNode(r, 6, 201, 1000, 400), false),
        bob: (f, r) => addNode(f, 'Map 3', makeNode(r, 1, 202, 1000, 600), false),
    },
    {
        id: '4d3',
        what: 'both insert a node into the same link (Map 3 -> Code 4)',
        alice: (f, r) => addNode(f, 'Map 3', makeNode(r, 6, 201, 1050, 0), true),
        bob: (f, r) => addNode(f, 'Map 3', makeNode(r, 1, 202, 1050, 0), true),
    },
    {
        id: '4d4',
        what: 'both insert a node into different links (Map 3 -> Code 4, Query 8 -> Filter 9)',
        alice: (f, r) => addNode(f, 'Map 3', makeNode(r, 6, 201, 1050, 0), true),
        bob: (f, r) => addNode(f, 'Query 8', makeNode(r, 1, 202, 2550, 0), true),
    },
];

function userBranches(name: string, mode: Mode, c: Case, seedNo = 7) {
    const dir = newRepo(name);
    seed(dir, mode);
    const r = rng(seedNo);
    checkout(dir, 'users/alice/work', true, 'dev');
    edit(dir, F.orders, mode, f => c.alice(f, r));
    commit(dir, `alice: ${c.id}`);
    checkout(dir, 'users/bob/work', true, 'dev');
    edit(dir, F.orders, mode, f => c.bob(f, r));
    commit(dir, `bob: ${c.id}`);
    return dir;
}

function s4() {
    section('Scenario 4: two user branches from dev edit the same flow (sorted by id vs insertion order)');
    const table: string[] = ['| case | edits | canonical (sorted) | insertion order |', '|---|---|---|---|'];
    for (const c of CASES) {
        const cell: string[] = [];
        for (const mode of ['sorted', 'insertion'] as Mode[]) {
            sub(`${c.id} [${mode}]: ${c.what}`);
            const dir = userBranches(`s${c.id}-${mode}`, mode, c);
            git(dir, ['checkout', '-q', 'dev']);
            git(dir, ['merge', '-q', '--no-ff', '-m', 'Merge users/alice/work into dev', 'users/alice/work']);
            const m = merge(dir, 'dev', 'users/bob/work', 'no-ff', [], 4);
            if (!m.clean) {
                showHunks(dir, F.orders, 1);
                cell.push(`CONFLICT (${(readFileSync(join(dir, F.orders), 'utf8').match(/^<<<<<<</gm) ?? []).length} hunk)`);
            } else {
                const issues = flowIssues(readFileSync(join(dir, F.orders), 'utf8'));
                say(`merged flow: ${issues.length ? `INVALID: ${issues.join('; ')}` : 'valid'}`);
                cell.push(`clean, ${issues.length ? `INVALID: ${issues[0]}` : 'valid'}`);
            }
        }
        table.push(`| ${c.id} | ${c.what} | ${cell[0]} | ${cell[1]} |`);
    }
    sub('4 summary table');
    say(table.join('\n'));

    sub('4 trials: both add one node (random uuid) as a side branch off a random node, 150 trials, `git merge-file`');
    const tmp = join(REPOS, 'mergefile');
    mkdirSync(tmp, { recursive: true });
    const r = rng(4242);
    const stats: Record<string, { conflict: number; invalid: number }> = {};
    for (const variant of ['side branch off random nodes', 'inserted into random links']) {
        for (const mode of ['sorted', 'insertion'] as Mode[]) {
            let conflict = 0;
            let invalid = 0;
            for (let t = 0; t < 150; t++) {
                const base = makeFlow('Trial', 20, 1000 + t);
                const labels = base.nodes.filter(n => n.label && !n.label.startsWith('Log 10')).map(n => n.label!);
                const pick = () => labels[Math.floor(r() * labels.length)]!;
                const a = structuredClone(base);
                const b = structuredClone(base);
                const between = variant.startsWith('inserted');
                addNode(a, pick(), makeNode(r, 6, 301, 0, 400), between);
                addNode(b, pick(), makeNode(r, 1, 302, 0, 600), between);
                writeFileSync(join(tmp, 'base.yaml'), serialize(base, mode));
                writeFileSync(join(tmp, 'a.yaml'), serialize(a, mode));
                writeFileSync(join(tmp, 'b.yaml'), serialize(b, mode));
                const m = git(tmp, ['merge-file', '-p', 'a.yaml', 'base.yaml', 'b.yaml']);
                if (m.code !== 0) {
                    conflict++;
                } else if (flowIssues(m.out).length) {
                    invalid++;
                }
            }
            stats[`${variant} / ${mode}`] = { conflict, invalid };
            say(`- ${variant}, ${mode}: ${conflict}/150 conflict, ${invalid}/150 clean but invalid`);
        }
    }
    verdict(
        '4',
        table
            .slice(2)
            .map(l =>
                l
                    .split('|')
                    .slice(1, 2)
                    .concat(l.split('|').slice(3, 5))
                    .map(s => s.trim())
                    .join(': '),
            )
            .join(' // ') +
            ' // trials: ' +
            JSON.stringify(stats),
    );
}

// ================================================================ 5
function s5() {
    section('Scenario 5: renames');
    const renamed = `${P}/flows/Sales/Load sales orders.yaml`;
    sub('5a1: alice renames the flow (file move + its `name:` line), bob edits its content');
    {
        const dir = newRepo('s5a1');
        seed(dir, 'sorted');
        checkout(dir, 'users/alice/rename', true, 'dev');
        git(dir, ['mv', F.orders, renamed]);
        edit(dir, renamed, 'sorted', f => (f.name = 'Load sales orders'));
        commit(dir, 'alice: rename Load orders -> Load sales orders');
        checkout(dir, 'users/bob/edit', true, 'dev');
        edit(dir, F.orders, 'sorted', f => setLine(f, 'Query 1', 'sql', 3, 'WHERE o.updatedAt >= @since'));
        commit(dir, 'bob: edit Load orders');
        merge(dir, 'dev', 'users/alice/rename', 'no-ff', [], 6);
        const m = merge(dir, 'dev', 'users/bob/edit', 'no-ff', [], 6);
        const ok =
            existsSync(join(dir, renamed)) &&
            readFileSync(join(dir, renamed), 'utf8').includes('>= @since') &&
            !existsSync(join(dir, F.orders));
        say(`new path has bob's edit and the old path is gone: ${ok}`);
        sayIssues('dev tree', repoIssues(dir));
        verdict('5a1', `${m.clean ? 'clean' : 'CONFLICT'}; git followed the rename: ${ok}`);
    }
    for (const heavy of [false, true]) {
        sub(
            `5a2${heavy ? 'b' : 'a'}: alice renames AND ${heavy ? 'rebuilds (most nodes replaced)' : 'reworks (every node touched)'} the flow in the same branch, bob edits its content`,
        );
        const dir = newRepo(`s5a2${heavy ? 'b' : 'a'}`);
        seed(dir, 'sorted');
        const to = `${P}/flows/Sales/Sync accounts.yaml`;
        checkout(dir, 'users/alice/rename', true, 'dev');
        git(dir, ['mv', F.customers, to]);
        edit(dir, to, 'sorted', f => {
            f.name = 'Sync accounts';
            moveAll(f);
            for (const n of f.nodes) {
                if (n.type === 'sqlserver') {
                    n.config.sql = 'SELECT a.id, a.name, a.email\nFROM crm.Account a\nWHERE a.changedAt > @since\n';
                    n.config.timeoutS = 90;
                }
                if (n.type === 'typescript') {
                    n.config.code = 'export default (data: Record<string, unknown>) => ({\n    ...data,\n    kind: "account",\n});\n';
                }
                if (n.label) {
                    n.label = n.label.replace(/^(\w+)/, '$1 account');
                }
                if (n.type === 'log') {
                    n.config.message = '`account ${$id}`';
                    n.config.level = 'debug';
                }
                if (n.type === 'http-request') {
                    n.config.url = { value: 'https://crm.example.invalid/accounts', expression: false };
                    n.config.method = 'PUT';
                }
                if (n.type === 'mapper') {
                    n.config.fields = [{ target: 'account', value: '$name', expression: true }];
                }
                if (n.type === 'filter') {
                    n.config.condition = '$email != null';
                }
            }
            f.groups = [];
            if (heavy) {
                const g = makeFlow('Sync accounts', 14, 500);
                f.nodes = [
                    ...f.nodes.filter(n => n.id === 'start' || n.id === 'end'),
                    ...g.nodes.filter(n => n.id !== 'start' && n.id !== 'end'),
                ];
                f.edges = g.edges;
            }
        });
        commit(dir, 'alice: rename Sync customers -> Sync accounts and rework it');
        run(dir, ['diff', '-M', '--summary', 'dev', 'users/alice/rename']);
        checkout(dir, 'users/bob/edit', true, 'dev');
        edit(dir, F.customers, 'sorted', f => (node(f, 'Filter 2').config.condition = '$total > 1'));
        commit(dir, 'bob: edit Sync customers (one filter condition)');
        merge(dir, 'dev', 'users/alice/rename', 'no-ff', [], 6);
        const m = merge(dir, 'dev', 'users/bob/edit', 'no-ff', [], 8);
        run(dir, ['status', '--short']);
        const kind = m.out.includes('modify/delete')
            ? 'CONFLICT (modify/delete): git did not follow the rename'
            : m.clean
              ? 'clean, rename followed'
              : 'rename followed, CONFLICT (content)';
        if (m.out.includes('modify/delete')) {
            say('After keeping both files (the easy way out of a modify/delete conflict):');
            git(dir, ['add', '-A']);
            sayIssues('dev tree', repoIssues(dir));
        } else if (m.clean) {
            sayIssues('dev tree', repoIssues(dir));
        }
        verdict(
            `5a2${heavy ? 'b' : 'a'}`,
            `similarity ${(q(dir, ['diff', '-M', '--summary', 'users/alice/rename~1', 'users/alice/rename']).match(/\((\d+%)\)/) ?? [])[1] ?? 'below 50% (no rename detected)'}; ${kind}`,
        );
    }
    sub('5c: alice deletes a flow and adds an unrelated new flow (other id, other name) in the same branch; bob edits the deleted flow');
    {
        const dir = newRepo('s5c');
        seed(dir, 'sorted');
        checkout(dir, 'users/alice/a', true, 'dev');
        git(dir, ['rm', '-q', F.customers]);
        writeFlow(dir, `${P}/flows/Finance/Refund report.yaml`, makeFlow('Refund report', 12, 501), 'sorted');
        commit(dir, 'alice: delete Sync customers, add Finance/Refund report');
        run(dir, ['diff', '-M', '--summary', 'dev', 'users/alice/a']);
        checkout(dir, 'users/bob/b', true, 'dev');
        edit(dir, F.customers, 'sorted', f => (node(f, 'Filter 2').config.condition = '$total > 1'));
        commit(dir, 'bob: edit Sync customers (one filter condition)');
        merge(dir, 'dev', 'users/alice/a', 'no-ff', [], 6);
        const m = merge(dir, 'dev', 'users/bob/b', 'no-ff', [], 8);
        run(dir, ['status', '--short']);
        if (!m.clean && existsSync(join(dir, P, 'flows/Finance/Refund report.yaml'))) {
            showHunks(dir, `${P}/flows/Finance/Refund report.yaml`, 1);
        }
        verdict(
            '5c',
            `${m.clean ? 'clean' : m.out.includes('modify/delete') ? 'CONFLICT (modify/delete), as expected for a deleted flow' : 'CONFLICT (content) in the unrelated new flow: git took delete + add for a rename'}`,
        );
    }
    sub('5a3: both branches rename the same flow, to different names');
    {
        const dir = newRepo('s5a3');
        seed(dir, 'sorted');
        for (const [who, name] of [
            ['alice', 'Load sales orders'],
            ['bob', 'Import orders'],
        ] as const) {
            checkout(dir, `users/${who}/rename`, true, 'dev');
            const to = `${P}/flows/Sales/${name}.yaml`;
            git(dir, ['mv', F.orders, to]);
            edit(dir, to, 'sorted', f => (f.name = name));
            commit(dir, `${who}: rename to ${name}`);
        }
        merge(dir, 'dev', 'users/alice/rename', 'no-ff', [], 3);
        const m = merge(dir, 'dev', 'users/bob/rename', 'no-ff', [], 8);
        run(dir, ['status', '--short']);
        verdict('5a3', m.clean ? 'clean' : 'CONFLICT (rename/rename): three paths involved, not a "mine or theirs for this file" conflict');
    }
    sub('5b: alice renames the folder Sales -> Revenue, bob adds a flow inside Sales');
    {
        const dir = newRepo('s5b');
        seed(dir, 'sorted');
        checkout(dir, 'users/alice/folder', true, 'dev');
        git(dir, ['mv', `${P}/flows/Sales`, `${P}/flows/Revenue`]);
        commit(dir, 'alice: rename folder Sales -> Revenue');
        checkout(dir, 'users/bob/new', true, 'dev');
        writeFlow(dir, `${P}/flows/Sales/Refund report.yaml`, makeFlow('Refund report', 10, 55), 'sorted');
        commit(dir, 'bob: add Sales/Refund report');
        git(dir, ['checkout', '-q', 'dev']);
        git(dir, ['merge', '-q', '--no-ff', '-m', 'Merge alice', 'users/alice/folder']);
        const out: string[] = [];
        for (const setting of ['conflict', 'true', 'false']) {
            checkout(dir, `try-${setting}`, true, 'dev');
            say(`merge.directoryRenames=${setting}${setting === 'conflict' ? ' (git default)' : ''}:`);
            const r = run(dir, ['-c', `merge.directoryRenames=${setting}`, 'merge', '--no-ff', '-m', 'Merge bob', 'users/bob/new'], 8);
            run(dir, ['status', '--short']);
            const folders = readdirSync(join(dir, P, 'flows')).join(', ');
            say(`folders under flows/: ${folders}`);
            out.push(`directoryRenames=${setting}: ${r.code === 0 ? 'clean' : 'CONFLICT (file location)'}, folders: ${folders}`);
            git(dir, ['merge', '--abort']);
            git(dir, ['reset', '-q', '--hard']);
        }
        verdict('5b', out.join('; '));
    }
}

// ================================================================ 6
function s6() {
    section('Scenario 6: silent semantic breakage (git merges cleanly, the result is broken)');
    sub('6.1: alice deletes a node, bob adds an edge to that node');
    {
        const base = makeFlow('Load orders', 20, 1);
        const victim = 'Filter 9';
        const a = structuredClone(base);
        removeNode(a, victim);
        const vid = node(base, victim).id;
        const tmp = join(REPOS, 'mergefile6');
        mkdirSync(tmp, { recursive: true });
        let clean = 0;
        let conflict = 0;
        let invalidWhenClean = 0;
        let firstClean: string | undefined;
        const sources = base.nodes.filter(
            n => n.id !== 'end' && n.id !== vid && !base.edges.some(e => e.source === n.id && e.target === vid),
        );
        for (const s of sources) {
            const b = structuredClone(base);
            b.edges.push({ source: s.id, sourcePort: 'out-0', target: vid, targetPort: 'in-0' });
            writeFileSync(join(tmp, 'base.yaml'), serialize(base, 'sorted'));
            writeFileSync(join(tmp, 'a.yaml'), serialize(a, 'sorted'));
            writeFileSync(join(tmp, 'b.yaml'), serialize(b, 'sorted'));
            const m = git(tmp, ['merge-file', '-p', 'a.yaml', 'base.yaml', 'b.yaml']);
            if (m.code === 0) {
                clean++;
                invalidWhenClean += flowIssues(m.out).length ? 1 : 0;
                firstClean ??= s.label ?? s.id;
            } else {
                conflict++;
            }
        }
        say(
            `bob's new edge from each of the ${sources.length} other nodes to "${victim}" (git merge-file): ${clean} merge cleanly (${invalidWhenClean} of them give an invalid flow), ${conflict} conflict (the edge sorts next to a removed one).`,
        );
        const dir = newRepo('s6-1');
        seed(dir, 'sorted');
        checkout(dir, 'users/alice/a', true, 'dev');
        edit(dir, F.orders, 'sorted', f => removeNode(f, victim));
        commit(dir, `alice: delete ${victim}`);
        checkout(dir, 'users/bob/b', true, 'dev');
        edit(dir, F.orders, 'sorted', f =>
            f.edges.push({ source: node(f, firstClean!).id, sourcePort: 'out-0', target: vid, targetPort: 'in-0' }),
        );
        commit(dir, `bob: edge ${firstClean} -> ${victim}`);
        merge(dir, 'dev', 'users/alice/a', 'no-ff', [], 3);
        const m = merge(dir, 'dev', 'users/bob/b', 'no-ff', [], 3);
        const issues = repoIssues(dir);
        sayIssues('dev tree after both merges', issues);
        verdict('6.1', `${m.clean ? 'clean merge' : 'CONFLICT'}; merged flow: ${issues.length ? `INVALID (${issues[0]})` : 'valid'}`);
    }
    sub('6.2: alice renames a script file (and fixes its users), bob adds a flow that references the old path');
    {
        const dir = newRepo('s6-2');
        seed(dir, 'sorted');
        checkout(dir, 'users/alice/a', true, 'dev');
        git(dir, ['mv', `${P}/scripts/pricing/tax.ts`, `${P}/scripts/pricing/vat.ts`]);
        for (const p of Object.values(F)) {
            edit(dir, p, 'sorted', f => {
                for (const n of f.nodes) {
                    if (n.type === 'script') {
                        n.config.function = 'pricing/vat#total';
                    }
                }
            });
        }
        commit(dir, 'alice: rename pricing/tax -> pricing/vat, update the flows');
        sayIssues('alice branch alone', repoIssues(dir));
        checkout(dir, 'users/bob/b', true, 'dev');
        writeFlow(dir, `${P}/flows/Finance/Tax report.yaml`, makeFlow('Tax report', 12, 77), 'sorted');
        commit(dir, 'bob: add Tax report (calls pricing/tax#total)');
        sayIssues('bob branch alone', repoIssues(dir));
        merge(dir, 'dev', 'users/alice/a', 'no-ff', [], 3);
        const m = merge(dir, 'dev', 'users/bob/b', 'no-ff', [], 3);
        const issues = repoIssues(dir);
        sayIssues('dev tree after both merges', issues);
        verdict('6.2', `${m.clean ? 'clean merge' : 'CONFLICT'}; ${issues.length ? `INVALID (${issues[0]})` : 'valid'}`);
    }
    sub('6.3: alice removes a connection from workspace.yaml (no flow uses it), bob adds a flow that uses it');
    {
        const dir = newRepo('s6-3');
        seed(dir, 'sorted');
        checkout(dir, 'users/alice/a', true, 'dev');
        writeConns(
            dir,
            BASE_CONNS.filter(c => c.id !== CONN.mail),
            'list-append',
        );
        commit(dir, 'alice: remove the unused Mail API connection');
        checkout(dir, 'users/bob/b', true, 'dev');
        const f = makeFlow('Send reminders', 10, 78);
        node(f, 'Send 6').config.connection = CONN.mail;
        writeFlow(dir, `${P}/flows/Finance/Send reminders.yaml`, f, 'sorted');
        commit(dir, 'bob: add Send reminders (uses Mail API)');
        merge(dir, 'dev', 'users/alice/a', 'no-ff', [], 3);
        const m = merge(dir, 'dev', 'users/bob/b', 'no-ff', [], 3);
        const issues = repoIssues(dir);
        sayIssues('dev tree after both merges', issues);
        verdict('6.3', `${m.clean ? 'clean merge' : 'CONFLICT'}; ${issues.length ? `INVALID (${issues[0]})` : 'valid'}`);
    }
    sub('6.4: alice deletes a flow, bob adds a Flow Invoker calling it by id; and both add a flow file with the same flow id');
    {
        const dir = newRepo('s6-4');
        seed(dir, 'sorted');
        const target = readFlow(dir, F.customers).id!;
        checkout(dir, 'users/alice/a', true, 'dev');
        git(dir, ['rm', '-q', F.customers]);
        writeFileSync(
            join(dir, P, 'flows/Sales/Copy of orders.yaml'),
            readFileSync(join(dir, F.orders), 'utf8').replace('name: Load orders', 'name: Copy of orders'),
        );
        commit(dir, 'alice: delete Sync customers; copy Load orders by hand (same id)');
        checkout(dir, 'users/bob/b', true, 'dev');
        edit(dir, F.invoices, 'sorted', f =>
            addNode(
                f,
                'Map 3',
                {
                    id: uuid(rng(5)),
                    type: 'flow',
                    label: 'Call sync',
                    position: { x: 1000, y: 400 },
                    config: { flowId: target, call: 'wait' },
                },
                false,
            ),
        );
        commit(dir, 'bob: Monthly invoices calls Sync customers');
        merge(dir, 'dev', 'users/alice/a', 'no-ff', [], 3);
        const m = merge(dir, 'dev', 'users/bob/b', 'no-ff', [], 3);
        const issues = repoIssues(dir);
        sayIssues('dev tree after both merges', issues);
        verdict(
            '6.4',
            `${m.clean ? 'clean merge' : 'CONFLICT'}; ${issues.length} issue(s): ${issues
                .map(i => i.replace(/^[^:]+: /, ''))
                .join(' | ')
                .slice(0, 300)}`,
        );
    }
}

// ================================================================ 7
function s7() {
    section('Scenario 7: two branches each add a connection to workspace.yaml');
    const A: Conn = { id: '3c0ffee0-1111-4111-a111-00000000000a', name: 'Billing DB', type: 'sqlserver' };
    const B: Conn = { id: 'e7777777-2222-4222-a222-00000000000b', name: 'Slack webhook', type: 'http' };
    const B2: Conn = { id: '3d000000-2222-4222-a222-00000000000b', name: 'Slack webhook', type: 'http' };
    const out: string[] = [];
    for (const [format, b, note] of [
        ['list-append', B, 'a list, new entries appended'],
        ['list-sorted', B, 'a list sorted by id, the two ids far apart'],
        ['list-sorted', B2, 'a list sorted by id, the two ids next to each other'],
        ['map-sorted', B, 'a map keyed by id, sorted, ids far apart'],
        ['map-sorted', B2, 'a map keyed by id, sorted, ids next to each other'],
        ['file-per', B2, 'one file per connection'],
    ] as const) {
        sub(`7 ${format}: ${note}`);
        const dir = newRepo(`s7-${format}-${b.id.slice(0, 2)}`);
        seed(dir, 'sorted', format);
        checkout(dir, 'users/alice/a', true, 'dev');
        writeConns(dir, [...readConns(dir), A], format);
        commit(dir, 'alice: add Billing DB');
        checkout(dir, 'users/bob/b', true, 'dev');
        writeConns(dir, [...readConns(dir), b], format);
        commit(dir, 'bob: add Slack webhook');
        git(dir, ['checkout', '-q', 'dev']);
        git(dir, ['merge', '-q', '--no-ff', '-m', 'Merge alice', 'users/alice/a']);
        const m = merge(dir, 'dev', 'users/bob/b', 'no-ff', [], 4);
        if (!m.clean) {
            showHunks(dir, `${WS}/workspace.yaml`, 1);
        } else {
            say(`connections after the merge: ${readConns(dir).length} (expected 6)`);
        }
        out.push(`${note}: ${m.clean ? `clean (${readConns(dir).length} connections)` : 'CONFLICT'}`);
    }
    sub('7 trials: both add one connection with a random uuid to a workspace of 4 / 12 connections, 150 trials, `git merge-file`');
    const tmp = join(REPOS, 'mergefile7');
    mkdirSync(join(tmp, WS), { recursive: true });
    const r = rng(777);
    for (const size of [4, 12]) {
        for (const format of ['list-append', 'list-sorted', 'map-sorted'] as WsFormat[]) {
            let conflict = 0;
            for (let t = 0; t < 150; t++) {
                const base = Array.from({ length: size }, (_, i) => ({ id: uuid(r), name: `Conn ${i}`, type: 'sqlserver' }));
                const texts = [
                    base,
                    [...base, { id: uuid(r), name: 'A', type: 'http' }],
                    [...base, { id: uuid(r), name: 'B', type: 'http' }],
                ].map(c => {
                    writeConns(tmp, c, format);
                    return readFileSync(join(tmp, WS, 'workspace.yaml'), 'utf8');
                });
                writeFileSync(join(tmp, 'base.yaml'), texts[0]!);
                writeFileSync(join(tmp, 'a.yaml'), texts[1]!);
                writeFileSync(join(tmp, 'b.yaml'), texts[2]!);
                conflict += git(tmp, ['merge-file', '-p', 'a.yaml', 'base.yaml', 'b.yaml']).code !== 0 ? 1 : 0;
            }
            say(`- ${size} existing connections, ${format}: ${conflict}/150 conflict`);
            out.push(`trials n=${size} ${format}: ${conflict}/150 conflict`);
        }
    }
    verdict('7', out.join('; '));
}

// ================================================================ 8
function s8() {
    section('Scenario 8: "mine or theirs per file"');
    sub('8a: bob updates his branch from dev (alice already merged), one line conflicts');
    const dir = newRepo('s8a');
    seed(dir, 'sorted');
    const r = rng(8);
    checkout(dir, 'users/alice/work', true, 'dev');
    edit(dir, F.orders, 'sorted', f => {
        setLine(f, 'Query 1', 'sql', 3, 'WHERE o.updatedAt >= @since');
        node(f, 'Filter 9').config.condition = '$total > 999';
        addNode(f, 'Map 3', makeNode(r, 6, 201, 1050, 0), true);
        for (const n of f.nodes.slice(0, 6)) {
            n.position.y += 150;
        }
    });
    commit(dir, 'alice: 1 SQL line, 1 filter, 1 new node (2 edges), 6 nodes moved');
    checkout(dir, 'users/bob/work', true, 'dev');
    edit(dir, F.orders, 'sorted', f => {
        setLine(f, 'Query 1', 'sql', 3, 'WHERE o.updatedAt > DATEADD(day, -7, @since)');
        node(f, 'Log 14').config.message = '`delivered ${$id}`';
        node(f, 'Query 15').config.timeoutS = 300;
    });
    commit(dir, 'bob: the same SQL line, 1 log message, 1 timeout');
    git(dir, ['checkout', '-q', 'dev']);
    git(dir, ['merge', '-q', '--no-ff', '-m', 'Merge users/alice/work into dev', 'users/alice/work']);
    const flowAt = (ref: string) => parse(q(dir, ['show', `${ref}:${F.orders}`])) as FlowFile;
    const describe = (from: FlowFile, to: FlowFile) => {
        const c = flowChanges(from, to);
        const moved = to.nodes.filter(n => {
            const o = from.nodes.find(x => x.id === n.id);
            return o && (o.position.x !== n.position.x || o.position.y !== n.position.y);
        }).length;
        return `nodes added ${c.added.length}, removed ${c.removed.length}, changed ${c.changed.length} (${c.changed.map(x => `${x.label}: ${x.fields.join(',')}`).join('; ')}), edges +${c.edgesAdded.length} -${c.edgesRemoved.length}, moved ${moved}`;
    };
    /** how many of the changes base -> side are in the result */
    const kept = (from: FlowFile, side: FlowFile, result: FlowFile) => {
        const missing: string[] = [];
        let total = 0;
        const j = (v: unknown) => JSON.stringify(v);
        const check = (ok: boolean, what: string) => {
            total++;
            if (!ok) {
                missing.push(what);
            }
        };
        for (const n of side.nodes) {
            const b = from.nodes.find(x => x.id === n.id);
            const r = result.nodes.find(x => x.id === n.id);
            if (!b) {
                check(!!r, `new node ${n.label}`);
                continue;
            }
            if (j(b.position) !== j(n.position)) {
                check(!!r && j(r.position) === j(n.position), `move of ${n.label}`);
            }
            for (const k of new Set([...Object.keys(b.config), ...Object.keys(n.config)])) {
                if (j(b.config[k]) !== j(n.config[k])) {
                    check(!!r && j(r.config[k]) === j(n.config[k]), `${n.label}.${k}`);
                }
            }
        }
        const keys = (f: FlowFile) => new Set(f.edges.map(edgeKey));
        for (const k of keys(side)) {
            if (!keys(from).has(k)) {
                check(keys(result).has(k), 'new edge');
            }
        }
        for (const k of keys(from)) {
            if (!keys(side).has(k)) {
                check(!keys(result).has(k), 'removed edge');
            }
        }
        return `${total - missing.length}/${total} changes kept${missing.length ? ` (lost: ${missing.join(', ')})` : ''}`;
    };
    const base = flowAt('dev~1');
    const alice = flowAt('users/alice/work');
    const bob = flowAt('users/bob/work');
    say(`alice's work (base -> alice): ${describe(base, alice)}`);
    say(`bob's work (base -> bob): ${describe(base, bob)}`);
    const out: string[] = [];
    for (const how of [
        'mine (whole file)',
        'theirs (whole file)',
        'mine per hunk (-X ours)',
        'theirs per hunk (-X theirs)',
        'union per hunk',
    ]) {
        say(`\n**${how}**`);
        const br = `try-${how.split(' ')[0]}-${how.includes('hunk') ? 'hunk' : 'file'}`;
        checkout(dir, br, true, 'users/bob/work');
        if (how.includes('whole')) {
            const m = git(dir, ['merge', '--no-ff', '-m', 'Update from dev', 'dev']);
            if (how.startsWith('mine')) {
                say('```');
                say(`$ git merge dev   [exit ${m.code}]`);
                say(hunks(readFileSync(join(dir, F.orders), 'utf8'), 1));
                say('```');
            }
            git(dir, ['checkout', how.startsWith('mine') ? '--ours' : '--theirs', '--', F.orders]);
            commit(dir, `Update from dev (${how})`);
        } else if (how.startsWith('union')) {
            git(dir, ['merge', '--no-ff', '-m', 'Update from dev', 'dev']);
            for (const [n, ref] of [
                ['o', 'users/bob/work'],
                ['b', 'dev~1'],
                ['t', 'dev'],
            ] as const) {
                writeFileSync(join(dir, `${n}.tmp`), q(dir, ['show', `${ref}:${F.orders}`]) + '\n');
            }
            const u = git(dir, ['merge-file', '-p', '--union', 'o.tmp', 'b.tmp', 't.tmp']);
            for (const n of ['o', 'b', 't']) {
                rmSync(join(dir, `${n}.tmp`));
            }
            writeFileSync(join(dir, F.orders), u.out);
            commit(dir, `Update from dev (${how})`);
        } else {
            git(dir, ['merge', '--no-ff', '-X', how.startsWith('mine') ? 'ours' : 'theirs', '-m', `Update from dev (${how})`, 'dev']);
        }
        const text = readFileSync(join(dir, F.orders), 'utf8');
        const issues = flowIssues(text);
        let res: FlowFile | undefined;
        try {
            res = parse(text) as FlowFile;
        } catch {
            res = undefined;
        }
        const lostA = res ? kept(base, alice, res) : 'n/a';
        const lostB = res ? kept(base, bob, res) : 'n/a';
        say(`result is a valid flow: ${issues.length ? `NO (${issues[0]})` : 'yes'}`);
        say(`on bob's branch after the update: alice's work ${lostA}; bob's work ${lostB}`);
        say(
            `Query 1 SQL line: ${
                res
                    ? String(node(res, 'Query 1').config.sql)
                          .split('\n')
                          .filter(l => l.startsWith('WHERE'))
                          .join(' | ')
                    : 'n/a'
            }`,
        );
        // then the PR of that branch into dev
        checkout(dir, `dev-${br}`, true, 'dev');
        const pr = git(dir, ['merge', '--no-ff', '-m', `Merge ${br} into dev`, br]);
        const after = parse(readFileSync(join(dir, F.orders), 'utf8')) as FlowFile;
        const ka = kept(base, alice, after);
        const kb = kept(base, bob, after);
        say(
            `then bob's PR into dev: ${pr.code === 0 ? 'clean' : 'CONFLICT'}; on dev: alice's (already merged) work ${ka}; bob's work ${kb}`,
        );
        out.push(`${how}: ${issues.length ? 'INVALID flow' : 'valid flow'}; dev after bob's PR: alice ${ka}, bob ${kb}`);
    }
    verdict('8a', out.join(' // '));

    sub('8b: the promotion conflict of 3b1 (hotfix on prod vs dev change on the same line), whole file taken from one side');
    for (const side of ['ours', 'theirs'] as const) {
        const d = newRepo(`s8b-${side}`);
        seed(d, 'sorted');
        envs(d);
        rounds[0]!(d, 'sorted');
        git(d, ['checkout', '-q', 'staging']);
        git(d, ['merge', '-q', '--no-ff', '-m', 'Merge dev into staging', 'dev']);
        git(d, ['checkout', '-q', 'prod']);
        git(d, ['merge', '-q', '--no-ff', '-m', 'Merge staging into prod', 'staging']);
        edit(d, F.orders, 'sorted', f => setLine(f, 'Query 1', 'sql', 4, "  AND o.status IN ('paid', 'shipped', 'refunded')"));
        commit(d, 'HOTFIX on prod: include refunded orders');
        checkout(d, 'dev');
        edit(d, F.orders, 'sorted', f => {
            setLine(f, 'Query 1', 'sql', 4, "  AND o.status IN ('paid', 'shipped', 'partial')");
            node(f, 'Filter 9').config.condition = '$total > 999';
            node(f, 'Query 15').config.timeoutS = 300;
        });
        commit(d, 'dev: partial orders, filter 9, timeout 15');
        git(d, ['checkout', '-q', 'staging']);
        git(d, ['merge', '-q', '--no-ff', '-m', 'Merge dev into staging', 'dev']);
        git(d, ['checkout', '-q', 'prod']);
        git(d, ['merge', '--no-ff', '-m', 'Merge staging into prod', 'staging']);
        git(d, ['checkout', `--${side}`, '--', F.orders]);
        commit(d, `Merge staging into prod (${side === 'ours' ? "prod's" : "staging's"} file)`);
        const prod = parse(readFileSync(join(d, F.orders), 'utf8')) as FlowFile;
        const sqlLine = String(node(prod, 'Query 1').config.sql).split('\n')[4];
        say(`\n**prod keeps ${side === 'ours' ? 'its own file (mine)' : "staging's file (theirs)"}**`);
        say(
            `prod Query 1: \`${sqlLine?.trim()}\`; Filter 9: \`${node(prod, 'Filter 9').config.condition}\`; Query 15 timeoutS: ${node(prod, 'Query 15').config.timeoutS}`,
        );
        say(
            `rev-list --count prod..staging = ${q(d, ['rev-list', '--count', 'prod..staging'])} (git says everything on staging is promoted); trees staging/prod ${same(d, 'staging', 'prod')}`,
        );
        say(aheadText(d, 'staging', 'prod'));
        // next promotion of an unrelated change
        checkout(d, 'dev');
        edit(d, F.invoices, 'sorted', f => (node(f, 'Filter 2').config.condition = '$total > 5'));
        commit(d, 'dev: unrelated');
        git(d, ['checkout', '-q', 'staging']);
        git(d, ['merge', '-q', '--no-ff', '-m', 'Merge dev into staging', 'dev']);
        git(d, ['checkout', '-q', 'prod']);
        const next = git(d, ['merge', '--no-ff', '-m', 'Merge staging into prod', 'staging']);
        const prod2 = parse(readFileSync(join(d, F.orders), 'utf8')) as FlowFile;
        say(
            `next promotion: ${next.code === 0 ? 'clean' : 'CONFLICT'}; prod Filter 9 is still \`${node(prod2, 'Filter 9').config.condition}\` (dev has \`$total > 999\`), SQL line still \`${String(node(prod2, 'Query 1').config.sql).split('\n')[4]?.trim()}\``,
        );
        verdict(
            `8b-${side}`,
            `prod SQL: ${sqlLine?.trim()}; Filter 9 on prod: ${node(prod2, 'Filter 9').config.condition}; prod..staging after = 0; next promotion ${next.code === 0 ? 'clean' : 'CONFLICT'} and does not bring the dropped side back`,
        );
    }

    sub('8c: workspace.yaml (appended list) conflict of scenario 7, whole file from one side');
    {
        const d = newRepo('s8c');
        seed(d, 'sorted');
        const A: Conn = { id: '3c0ffee0-1111-4111-a111-00000000000a', name: 'Billing DB', type: 'sqlserver' };
        const B: Conn = { id: 'e7777777-2222-4222-a222-00000000000b', name: 'Slack webhook', type: 'http' };
        checkout(d, 'users/alice/a', true, 'dev');
        writeConns(d, [...BASE_CONNS, A], 'list-append');
        edit(d, F.orders, 'sorted', f => (node(f, 'Query 1').config.connection = A.id));
        commit(d, 'alice: add Billing DB and use it');
        checkout(d, 'users/bob/b', true, 'dev');
        writeConns(d, [...BASE_CONNS, B], 'list-append');
        edit(d, F.customers, 'sorted', f => (node(f, 'Send 6').config.connection = B.id));
        commit(d, 'bob: add Slack webhook and use it');
        git(d, ['checkout', '-q', 'dev']);
        git(d, ['merge', '-q', '--no-ff', '-m', 'Merge alice', 'users/alice/a']);
        checkout(d, 'users/bob/b');
        run(d, ['merge', '--no-ff', '-m', 'Update from dev', 'dev'], 4);
        git(d, ['checkout', '--ours', '--', `${WS}/workspace.yaml`]);
        commit(d, 'Update from dev (mine)');
        const issues = repoIssues(d);
        sayIssues("bob's branch after `mine` on workspace.yaml", issues);
        verdict('8c', `mine on workspace.yaml: ${issues.length ? issues[0] : 'valid'}`);
    }
}

// ================================================================ 9
function s9() {
    section('Scenario 9: promoting a commit that is not the tip');
    const dir = newRepo('s9');
    seed(dir, 'sorted');
    envs(dir);
    rounds[0]!(dir, 'sorted');
    rounds[1]!(dir, 'sorted');
    const c2 = q(dir, ['rev-parse', '--short', 'HEAD']);
    rounds[2]!(dir, 'sorted');
    run(dir, ['log', '--oneline', 'staging..dev']);
    git(dir, ['branch', `promote/dev-${c2}`, c2]);
    const a = merge(dir, 'staging', `promote/dev-${c2}`, 'no-ff', [], 5);
    say(`staging tree equals dev at ${c2}: ${same(dir, 'staging', c2)}; ${validity(dir)}`);
    run(dir, ['log', '--oneline', 'staging..dev']);
    run(dir, ['merge-base', '--is-ancestor', c2, 'staging']);
    const p = merge(dir, 'prod', 'staging', 'no-ff', [], 5);
    checkout(dir, 'dev');
    edit(dir, F.orders, 'sorted', f => setLine(f, 'Query 1', 'sql', 3, 'WHERE o.updatedAt >= DATEADD(day, -2, @since)'));
    commit(dir, 'round 4: two days of overlap (same line as rounds 1 and 2)');
    git(dir, ['branch', '-d', `promote/dev-${c2}`]);
    const b = merge(dir, 'staging', 'dev', 'no-ff', [], 5);
    const p2 = merge(dir, 'prod', 'staging', 'no-ff', [], 5);
    say(
        `trees dev/staging ${same(dir, 'dev', 'staging')}, staging/prod ${same(dir, 'staging', 'prod')}; staging..dev = ${q(dir, ['rev-list', '--count', 'staging..dev'])}; ${validity(dir)}`,
    );
    verdict(
        '9',
        `promote/dev-${c2} into staging ${a.clean ? 'clean' : 'CONFLICT'}, on to prod ${p.clean ? 'clean' : 'CONFLICT'}; later tip into staging ${b.clean ? 'clean' : 'CONFLICT'}, prod ${p2.clean ? 'clean' : 'CONFLICT'}; trees end ${same(dir, 'dev', 'prod')}`,
    );

    sub('9b: the same, but staging also got a hotfix between the two promotions (not back-ported)');
    const d = newRepo('s9b');
    seed(d, 'sorted');
    envs(d);
    rounds[0]!(d, 'sorted');
    const c1 = q(d, ['rev-parse', '--short', 'HEAD']);
    rounds[1]!(d, 'sorted');
    git(d, ['branch', `promote/dev-${c1}`, c1]);
    merge(d, 'staging', `promote/dev-${c1}`, 'no-ff', [], 3);
    edit(d, F.orders, 'sorted', f => setLine(f, 'Query 1', 'sql', 3, 'WHERE o.updatedAt >= @since -- staging hotfix'));
    commit(d, 'HOTFIX on staging, on the line round 2 already changed on dev');
    const m = merge(d, 'staging', 'dev', 'no-ff', [], 5);
    if (!m.clean) {
        showHunks(d, F.orders, 1);
    }
    verdict(
        '9b',
        `tip promotion after a partial promotion + a hotfix on the line a not-yet-promoted commit changed: ${m.clean ? 'clean' : 'CONFLICT'}`,
    );
}

// ================================================================ 10
function s10() {
    section('Scenario 10: a hotfix on prod while staging and dev both have unpromoted work; backport to the root vs one hop at a time');
    // round 1 is in prod; round 2 reached staging only (being tested); round 3 is on dev only (not ready)
    const base = (name: string, hotfix: (dir: string) => void) => {
        const dir = newRepo(name);
        seed(dir, 'sorted');
        envs(dir);
        rounds[0]!(dir, 'sorted');
        merge(dir, 'staging', 'dev', 'no-ff', [], 3);
        merge(dir, 'prod', 'staging', 'no-ff', [], 3);
        checkout(dir, 'dev');
        rounds[1]!(dir, 'sorted');
        merge(dir, 'staging', 'dev', 'no-ff', [], 3);
        checkout(dir, 'dev');
        rounds[2]!(dir, 'sorted');
        checkout(dir, 'prod');
        hotfix(dir);
        return dir;
    };
    const hotOther = (dir: string) => {
        edit(dir, F.customers, 'sorted', f => (node(f, 'Filter 9').config.condition = '$total > 0 -- hotfix'));
        commit(dir, 'HOTFIX on prod: Sync customers, Filter 9 (no other branch touches it)');
    };
    const hotSame = (dir: string) => {
        edit(dir, F.orders, 'sorted', f => setLine(f, 'Query 1', 'sql', 3, 'WHERE o.updatedAt >= @since -- hotfix'));
        commit(dir, 'HOTFIX on prod: Load orders, Query 1 line 3 (the line round 2 changed on staging)');
    };
    const has = (dir: string, ref: string) => ({
        r2: q(dir, ['show', `${ref}:${F.customers}`]).includes('$total > 50'),
        r3: q(dir, ['show', `${ref}:${F.invoices}`]).includes('* 1.5'),
    });
    const content = (dir: string, ref: string) => {
        const h = has(dir, ref);
        return `${ref} has round 2: ${h.r2}, round 3: ${h.r3}`;
    };
    const blocked = (dir: string, source: string, env: string) => (ahead(dir, source, env).changes === 'no' ? 'open' : 'BLOCKED');
    const resolveTheirs = (dir: string, files: string[]) => {
        for (const f of files) {
            showHunks(dir, f, 1);
            git(dir, ['checkout', '--theirs', f]);
            git(dir, ['add', f]);
        }
        git(dir, ['commit', '-q', '--no-edit']);
    };
    const backport = (dir: string, from: string, into: string) => {
        const sha = q(dir, ['rev-parse', '--short', from]);
        const br = `backport/${from}-${sha}`;
        checkout(dir, br, true, into);
        const m = merge(dir, br, from, 'no-ff', [], 5);
        if (!m.clean) {
            say(`conflict in ${br}, resolved by taking ${from}'s side of each hunk`);
            resolveTheirs(dir, m.files);
        }
        merge(dir, into, br, 'no-ff', [], 3);
        return m;
    };

    for (const [id, what, hot] of [
        ['a', 'the hotfix touches a flow nobody else changed', hotOther],
        ['b', 'the hotfix changes the line round 2 changed on staging', hotSame],
    ] as const) {
        sub(`10${id}1: ${what}; backport to the root (dev)`);
        {
            const dir = base(`s10${id}1`, hot);
            say(`before: staging -> prod ${blocked(dir, 'staging', 'prod')}`);
            const bp = backport(dir, 'prod', 'dev');
            say(
                `after the backport into dev: staging -> prod ${blocked(dir, 'staging', 'prod')}, dev -> staging ${blocked(dir, 'dev', 'staging')}`,
            );
            say('the only dev commits that carry the hotfix are the backport merge and later; the promotion takes the tip:');
            const a = merge(dir, 'staging', 'dev', 'no-ff', [], 5);
            say(`after dev -> staging: ${content(dir, 'staging')}; staging -> prod ${blocked(dir, 'staging', 'prod')}`);
            const b = merge(dir, 'prod', 'staging', 'no-ff', [], 5);
            say(`after staging -> prod: ${content(dir, 'prod')}; ${validity(dir)}`);
            verdict(
                `10${id}1`,
                `backport ${bp.clean ? 'clean' : 'CONFLICT'}; staging -> prod unblocked only after dev -> staging (${a.clean ? 'clean' : 'CONFLICT'}), which brought round 3 into staging: ${has(dir, 'staging').r3}; next prod promotion (${b.clean ? 'clean' : 'CONFLICT'}) carries round 3: ${has(dir, 'prod').r3}`,
            );
        }
        sub(`10${id}2: ${what}; backport one hop at a time (prod into staging, then staging into dev)`);
        {
            const dir = base(`s10${id}2`, hot);
            const h1 = backport(dir, 'prod', 'staging');
            say(
                `after hop 1: staging -> prod ${blocked(dir, 'staging', 'prod')}, dev -> staging ${blocked(dir, 'dev', 'staging')}; ${content(dir, 'staging')}`,
            );
            const p = merge(dir, 'prod', 'staging', 'no-ff', [], 5);
            const prodNow = has(dir, 'prod');
            say(`staging -> prod right away (${p.clean ? 'clean' : 'CONFLICT'}): ${content(dir, 'prod')}`);
            const h2 = backport(dir, 'staging', 'dev');
            say(`after hop 2: dev -> staging ${blocked(dir, 'dev', 'staging')}`);
            const a = merge(dir, 'staging', 'dev', 'no-ff', [], 5);
            const b = merge(dir, 'prod', 'staging', 'no-ff', [], 5);
            say(
                `then the ordinary promotions: dev -> staging ${a.clean ? 'clean' : 'CONFLICT'}, staging -> prod ${b.clean ? 'clean' : 'CONFLICT'}; trees dev/prod ${same(dir, 'dev', 'prod')}; ${validity(dir)}`,
            );
            verdict(
                `10${id}2`,
                `hop 1 ${h1.clean ? 'clean' : 'CONFLICT'}, staging -> prod open at once and (${p.clean ? 'clean' : 'CONFLICT'}) carries round 2: ${prodNow.r2}, round 3: ${prodNow.r3}; hop 2 ${h2.clean ? 'clean' : 'CONFLICT'}; later promotions ${a.clean && b.clean ? 'clean' : 'CONFLICT'}, trees end ${same(dir, 'dev', 'prod')}`,
            );
        }
    }
}

// ---------------------------------------------------------------- main
const only = process.argv.slice(2);
const all: Record<string, () => void> = { '1': s1, '2': s2, '3': s3, '4': s4, '5': s5, '6': s6, '7': s7, '8': s8, '9': s9, '10': s10 };
say('# git-sim raw results');
say(
    `\n${git(ROOT, ['--version']).out.trim()}, bun ${Bun.version}. Flow files written by the core's flowToYaml; validity checked by the core's flowFromYaml plus repo-wide checks.`,
);
{
    const d = newRepo('s0-format');
    seed(d, 'sorted');
    const sizes = Object.values(F).map(
        p => `${p.split('/').pop()}: ${readFlow(d, p).nodes.length} nodes, ${readFileSync(join(d, p), 'utf8').split('\n').length} lines`,
    );
    say(`Seed workspace: ${sizes.join('; ')}. Seed tree: ${validity(d)}.`);
    const a = readFileSync(join(d, F.orders), 'utf8');
    writeFlow(d, F.orders, readFlow(d, F.orders), 'sorted');
    say(`Canonical writer is stable (read + write again gives no diff): ${a === readFileSync(join(d, F.orders), 'utf8')}`);
}
for (const [k, fn] of Object.entries(all)) {
    if (only.length === 0 || only.includes(k)) {
        fn();
    }
}
say('\n## Summary\n');
for (const s of summary) {
    say(`- **${s.id}**: ${s.outcome}`);
}
writeFileSync(join(OUT, only.length ? `results-${only.join('-')}.md` : 'results.md'), buf.join('\n') + '\n');
writeFileSync(join(OUT, 'summary.json'), JSON.stringify(summary, null, 2));
console.log(summary.map(s => `${s.id}: ${s.outcome}`).join('\n'));
