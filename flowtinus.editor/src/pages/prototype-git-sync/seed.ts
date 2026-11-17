import YAML from 'yaml';
import { flowFile, flowYaml, scriptFile, workspaceFile, WS, type FlowDoc, type Server, type State, type Tree } from './model';
import { branchMoved, commitTree } from './actions';

const project = (id: string, description: string, color: string) => YAML.stringify({ id, description, icon: 'folder', color });

const syncOrders: FlowDoc = {
    id: 'f-sync-orders',
    deployed: true,
    workerTag: 'default',
    nodes: [
        { id: 'start', type: 'Start', position: { x: 0, y: 0 } },
        {
            id: 'fetch',
            type: 'SqlQuery',
            label: 'Read new orders',
            position: { x: 260, y: 0 },
            config: { connection: 'c-shop-db', timeoutSeconds: 30 },
        },
        { id: 'map', type: 'Script', label: 'Map orders', position: { x: 520, y: 0 }, config: { script: 'transform/orders.ts' } },
        { id: 'end', type: 'End', position: { x: 780, y: 0 } },
    ],
    edges: ['start -> fetch', 'fetch -> map', 'map -> end'],
    schedules: [{ id: 's-orders-nightly', name: 'Nightly', cron: '0 2 * * *', timezone: 'UTC', parameters: '{}', input: '{}' }],
};

const refunds: FlowDoc = {
    id: 'f-refunds',
    deployed: true,
    workerTag: 'default',
    nodes: [
        { id: 'start', type: 'Start', position: { x: 0, y: 0 } },
        {
            id: 'call',
            type: 'HttpRequest',
            label: 'Payment API',
            position: { x: 260, y: 0 },
            config: { retries: 2, url: 'https://pay.example.com/refunds' },
        },
        { id: 'end', type: 'End', position: { x: 520, y: 0 } },
    ],
    edges: ['start -> call', 'call -> end'],
};

const welcome: FlowDoc = {
    id: 'f-welcome',
    deployed: false,
    workerTag: 'default',
    nodes: [
        { id: 'start', type: 'Start', position: { x: 0, y: 0 } },
        {
            id: 'mail',
            type: 'SendEmail',
            label: 'Welcome email',
            position: { x: 260, y: 0 },
            config: { connection: 'c-mailer', template: 'welcome' },
        },
        { id: 'end', type: 'End', position: { x: 520, y: 0 } },
    ],
    edges: ['start -> mail', 'mail -> end'],
};

const invoices: FlowDoc = {
    id: 'f-invoices',
    deployed: true,
    workerTag: 'billing',
    nodes: [
        { id: 'start', type: 'Start', position: { x: 0, y: 0 } },
        {
            id: 'calc',
            type: 'Script',
            label: 'Compute invoice',
            position: { x: 260, y: 0 },
            config: { script: 'invoice.ts', taxRate: 0.2 },
        },
        { id: 'end', type: 'End', position: { x: 520, y: 0 } },
    ],
    edges: ['start -> calc', 'calc -> end'],
    schedules: [
        {
            id: 's-invoices-monthly',
            name: 'Monthly',
            cron: '0 6 1 * *',
            timezone: 'Europe/Lisbon',
            parameters: '{"dryRun": false}',
            input: '{}',
        },
    ],
};

const connections = (list: { id: string; name: string; type: string }[]) => YAML.stringify({ connections: list });

const baseTree: Tree = {
    [workspaceFile]: connections([
        { id: 'c-shop-db', name: 'Shop database', type: 'postgres' },
        { id: 'c-mailer', name: 'Mailer', type: 'smtp' },
    ]),
    [`${WS}/Shop/project.yaml`]: project('p-shop', 'The online shop', 'blue'),
    [flowFile('Shop', 'Orders', 'Sync orders')]: flowYaml(syncOrders),
    [flowFile('Shop', 'Orders', 'Refunds')]: flowYaml(refunds),
    [`${WS}/Shop/flows/Archive/.gitkeep`]: '',
    [scriptFile('Shop', 'transform/orders.ts')]:
        'export function main(rows: Order[]) {\n    return rows.map(r => ({ id: r.id, total: r.total }));\n}\n',
    [scriptFile('Shop', 'utils/money.ts')]: 'export const cents = (value: number) => Math.round(value * 100);\n',
    [`${WS}/Billing/project.yaml`]: project('p-billing', 'Invoices and payments', 'green'),
    [flowFile('Billing', '', 'Invoices')]: flowYaml(invoices),
    [scriptFile('Billing', 'invoice.ts')]:
        'export function main(order: Order, taxRate: number) {\n    return order.total * (1 + taxRate);\n}\n',
};

const server = (env: string, branch: string, directEdits: boolean, promotesTo: string[]): Server => ({
    env,
    gitOn: true,
    settings: { repo: 'https://gitlab.example.com/omc-solutions/flows.git', branch, directEdits, credential: 'GIT_TOKEN', promotesTo },
    reconciledSha: null,
    flows: {},
    schedules: {},
    connections: {},
    scripts: {},
    working: {},
    history: [],
});

export function seed(): State {
    const state: State = {
        seq: 0,
        clock: Date.UTC(2026, 10, 2, 9),
        commits: {},
        branches: {},
        branchMeta: {},
        prs: [],
        servers: {
            DEV: server('DEV', 'dev', true, ['staging']),
            STAGING: server('STAGING', 'staging', false, ['prod', 'sandbox']),
            PROD: server('PROD', 'prod', true, []),
            SANDBOX: server('SANDBOX', 'sandbox', true, []),
        },
        envOrder: ['DEV', 'STAGING', 'PROD', 'SANDBOX'],
        users: [
            { slug: 'ana', name: 'Ana Silva' },
            { slug: 'bruno', name: 'Bruno Costa' },
        ],
        secrets: ['GIT_TOKEN', 'GITLAB_DEPLOY_TOKEN', 'SMTP_PASSWORD'],
        session: { env: 'DEV', user: 'ana', branchByEnvUser: {}, variant: 'A' },
        events: [],
    };

    const c1 = commitTree(state, null, baseTree, 'Initial export from DEV', 'flowtinus (DEV)', 'initial');
    for (const branch of ['dev', 'staging', 'prod', 'sandbox']) {
        state.branches[branch] = c1;
        branchMoved(state, branch);
    }

    const refundsRetry: Tree = {
        ...baseTree,
        [flowFile('Shop', 'Orders', 'Refunds')]: flowYaml({
            ...refunds,
            nodes: refunds.nodes.map(n => (n.id === 'call' ? { ...n, config: { ...n.config, retries: 3 } } : n)),
        }),
    };
    const c2 = commitTree(state, [c1], refundsRetry, 'Refunds: retry 3 times on 503', 'Ana Silva', 'commit');
    state.branches.dev = c2;
    branchMoved(state, 'dev');
    state.branches.staging = c2;
    state.branchMeta.staging = {};
    branchMoved(state, 'staging');

    const withWelcome: Tree = { ...refundsRetry, [flowFile('Shop', 'Customers', 'Welcome email')]: flowYaml(welcome) };
    const c3 = commitTree(state, [c2], withWelcome, 'Add the Welcome email flow (not deployed yet)', 'Bruno Costa', 'commit');
    state.branches.dev = c3;
    branchMoved(state, 'dev');

    const taxed: Tree = {
        ...withWelcome,
        [flowFile('Billing', '', 'Invoices')]: flowYaml({
            ...invoices,
            nodes: invoices.nodes.map(n => (n.id === 'calc' ? { ...n, config: { ...n.config, taxRate: 0.23 } } : n)),
        }),
    };
    const c4 = commitTree(state, [c3], taxed, 'Invoices: VAT 23%', 'Bruno Costa', 'commit');
    state.branches['users/bruno/vat-23'] = c4;
    state.branchMeta['users/bruno/vat-23'] = { cutFrom: 'dev', owner: 'bruno', createdOn: 'DEV' };
    state.prs.push({
        number: 1,
        kind: 'change',
        from: 'users/bruno/vat-23',
        to: 'dev',
        title: 'Invoices: VAT 23%',
        state: 'open',
        openedOn: 'DEV',
        author: 'Bruno Costa',
    });

    for (const env of state.envOrder) {
        for (const row of Object.values(state.servers[env]!.schedules)) {
            row.enabled = true;
        }
        for (const row of Object.values(state.servers[env]!.connections)) {
            row.configured = !(env === 'SANDBOX' && row.id === 'c-mailer');
        }
    }
    state.events = [];
    return state;
}
