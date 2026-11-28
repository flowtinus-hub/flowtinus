// PROTOTYPE (#86): throwaway. Builds, writes a fresh sample repository in the temp folder (git init + one commit) and
// opens it in a VS Code Extension Development Host with this extension.
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { COMPONENT_TYPE, GITATTRIBUTES, componentSettings, connectionToYaml, newFlowFile, projectToYaml, repoFlowToYaml, settingsDefaults, workspaceToYaml, type FlowFile } from '../../flowtinus.core/src/index';

const here = join(import.meta.dir, '..');
const sample = join(tmpdir(), 'flowtinus-vscode-prototype-sample-WIPE-ME');

if (!existsSync(join(here, 'node_modules'))) {
    Bun.spawnSync(['bun', 'install'], { cwd: here, stdio: ['inherit', 'inherit', 'inherit'] });
}
if (Bun.spawnSync(['bun', 'scripts/build.ts'], { cwd: here, stdio: ['inherit', 'inherit', 'inherit'] }).exitCode !== 0) {
    process.exit(1);
}

// emptied, not removed: a VS Code window may have the folder open (Windows refuses to remove it then)
mkdirSync(sample, { recursive: true });
for (const entry of readdirSync(sample)) {
    rmSync(join(sample, entry), { recursive: true, force: true });
}
const write = (path: string, text: string) => {
    mkdirSync(dirname(join(sample, path)), { recursive: true });
    writeFileSync(join(sample, path), text);
};

const salesDb = crypto.randomUUID();
const warehouse = crypto.randomUUID();
const notifyId = crypto.randomUUID();

const node = (id: string, type: string, x: number, config: Record<string, unknown> = {}, label?: string) => ({
    id,
    type,
    position: { x, y: 0 },
    config: { ...settingsDefaults(componentSettings(type)), ...config },
    ...(label ? { label } : {}),
});
const edge = (source: string, target: string) => ({ source, sourcePort: 'out-0', target, targetPort: 'in-0' });

const loadOrders: FlowFile = {
    ...newFlowFile('Load orders', crypto.randomUUID()),
    nodes: [
        node('start', COMPONENT_TYPE.start, 0),
        node('query', COMPONENT_TYPE.sqlServerQuery, 200, { connection: salesDb, sql: 'select * from orders' }, 'Read orders'),
        node('notify', COMPONENT_TYPE.flowInvoker, 420, { flowId: notifyId }, 'Notify'),
        node('end', COMPONENT_TYPE.end, 640),
    ],
    edges: [edge('start', 'query'), edge('query', 'notify'), edge('notify', 'end')],
};
const notify: FlowFile = {
    ...newFlowFile('Notify', notifyId),
    nodes: [node('start', COMPONENT_TYPE.start, 0), node('log', COMPONENT_TYPE.log, 200), node('end', COMPONENT_TYPE.end, 420)],
    edges: [edge('start', 'log'), edge('log', 'end')],
};

write('.gitattributes', GITATTRIBUTES);
write('acme/workspace.yaml', workspaceToYaml());
write('acme/connections/sales-db.yaml', connectionToYaml({ id: salesDb, type: 'sqlserver' }));
write('acme/connections/warehouse.yaml', connectionToYaml({ id: warehouse, type: 'redshift' }));
write('acme/projects/sales/project.yaml', projectToYaml({ id: crypto.randomUUID(), description: 'Sales' }));
write('acme/projects/sales/flows/orders/Load orders.flow.yaml', repoFlowToYaml(loadOrders));
write('acme/projects/sales/flows/Notify.flow.yaml', repoFlowToYaml(notify));
// written by hand: keys out of order and a comment, for the format on save
write(
    'acme/projects/sales/flows/Hand written.flow.yaml',
    `# a comment the canonical form drops
nodes:
  - type: end
    id: end
    config: {}
    position: { x: 400, y: 0 }
  - id: start
    type: start
    position: { x: 0, y: 0 }
    config: {}
  - id: log
    type: log
    position: { x: 200, y: 0 }
    config: {}
edges:
  - { source: start, sourcePort: out-0, target: log, targetPort: in-0 }
  - { source: log, sourcePort: out-0, target: end, targetPort: in-0 }
id: ${crypto.randomUUID()}
version: 1
`,
);
write('acme/projects/sales/scripts/helpers/format.ts', 'export function money(n: number) {\n    return n.toFixed(2);\n}\n');
write(
    'acme/projects/sales/scripts/main.ts',
    "import { money } from '@w/acme/sales/scripts/helpers/format';\n\nexport const total = (n: number) => money(n);\n",
);

// as a clone of a real workspace would be: the local DEV server's "dev" workspace, written from its drafts with the same
// ids, so Run (with a token) finds the flows there. Skipped when DEV does not answer.
const DEV = 'http://localhost:5190';
const devGet = async <T>(path: string): Promise<T> => {
    const response = await fetch(`${DEV}${path}`, { headers: { 'x-user-id': '00000000-0000-4000-8000-000000000002' } });
    if (!response.ok) {
        throw new Error(`${path}: ${response.status}`);
    }
    return (await response.json()) as T;
};
try {
    const ws = 'dev';
    write(`${ws}/workspace.yaml`, workspaceToYaml());
    const { items: connections } = await devGet<{ items: { id: string; name: string; type: string }[] }>(`/w/${ws}/connections`);
    for (const c of connections) {
        write(`${ws}/connections/${c.name}.yaml`, connectionToYaml({ id: c.id, type: c.type as never }));
    }
    const { items: projects } = await devGet<{ items: { id: string; handle: string; description: string }[] }>(`/w/${ws}/projects`);
    for (const p of projects) {
        write(`${ws}/projects/${p.handle}/project.yaml`, projectToYaml({ id: p.id, description: p.description }));
        const { folders, flows } = await devGet<{
            folders: { id: string; parentId: string | null; name: string; archivedAt: string | null }[];
            flows: { id: string; folderId: string | null; name: string; archivedAt: string | null }[];
        }>(`/w/${ws}/projects/${p.id}/contents`);
        const folderPath = (id: string | null): string[] => {
            const f = folders.find(x => x.id === id);
            return f ? [...folderPath(f.parentId), f.name] : [];
        };
        const { scripts } = await devGet<{ scripts: { path: string }[] }>(`/w/${ws}/projects/${p.id}/scripts`);
        for (const s of scripts) {
            const { content } = await devGet<{ content: string }>(
                `/w/${ws}/projects/${p.id}/scripts/content?path=${encodeURIComponent(s.path)}`,
            );
            write(`${ws}/projects/${p.handle}/scripts/${s.path}.ts`, content);
        }
        for (const f of flows.filter(x => !x.archivedAt)) {
            const { flow } = await devGet<{ flow: FlowFile }>(`/w/${ws}/flows/${f.id}/draft`);
            write(
                `${ws}/projects/${p.handle}/flows/${[...folderPath(f.folderId), f.name].join('/')}.flow.yaml`,
                repoFlowToYaml({ ...flow, id: f.id }),
            );
        }
    }
    console.log(`pulled the "${ws}" workspace from ${DEV}`);
} catch (e) {
    console.log(`DEV not pulled (${e instanceof Error ? e.message : String(e)})`);
}

// what an agent (Copilot, Claude Code...) reads first, and a `flowtinus` it can run here: the CLI is not installed
const cli = join(here, '..', 'flowtinus.cli', 'src', 'bin.ts');
write('flowtinus.cmd', `@bun "${cli}" %*\r\n`);
write('flowtinus', `#!/bin/sh\nexec bun "${cli.replaceAll('\\', '/')}" "$@"\n`);
const agents = `# Agents

The \`.flow.yaml\` files here are Flowtinus flows. Before editing one, run \`./flowtinus docs\` and follow it.

- New flow: \`./flowtinus new flow <path>.flow.yaml\` (it writes the \`id\`).
- After editing: \`./flowtinus fmt <the files you changed>\` then \`./flowtinus validate\`, until no errors.
`;
write('AGENTS.md', agents);
write('.github/copilot-instructions.md', agents);

const git = (...args: string[]) => Bun.spawnSync(['git', ...args], { cwd: sample, stdout: 'ignore', stderr: 'inherit' });
git('init', '-q', '-b', 'main');
git('add', '-A');
git('-c', 'user.name=prototype', '-c', 'user.email=prototype@example.invalid', 'commit', '-q', '-m', 'sample');
console.log(`sample repository: ${sample}`);

const code = ['code', '--new-window', `--extensionDevelopmentPath=${here}`, sample];
// wait for it: when bun exits first, Windows ends the cmd that is still handing over to VS Code
if (!process.argv.includes('--no-open')) {
    const opened = Bun.spawn(process.platform === 'win32' ? ['cmd', '/c', ...code] : code, { stdio: ['ignore', 'inherit', 'inherit'] });
    console.log(`code exited with ${await opened.exited}`);
}
