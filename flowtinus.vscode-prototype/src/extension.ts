// PROTOTYPE (#86): throwaway. A thin slice of the VS Code extension: the canvas, the names behind ids, explorer commands.
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, sep } from 'node:path';
import * as vscode from 'vscode';
import { CONNECTION_TYPES, componentSettings, connectionToYaml, newFlowFile, repoEntry, repoFlowFromYaml, repoFlowToYaml, scriptImport, settingsDefaults, validateWorkspaceTree, COMPONENTS, handleOf, SCRIPT_GLOBALS, scriptImportPrefix, type FlowFile, type RepoFlow } from '../../flowtinus.core/src/index';
import { answer, projectIdOf, type ApiHost } from './fake-api';
import { acceptedConnectionTypes, buildIndex, componentLabel, formatRepoFile, ports, REFERENCE_KEYS, workspaceOf, type Index, type Named } from './repo';

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const FLOW_SELECTOR: vscode.DocumentSelector = { scheme: 'file', pattern: '**/*.flow.yaml' };

let index: Index | undefined;
let root = '';
const indexChanged = new vscode.EventEmitter<void>();
const log = vscode.window.createOutputChannel('Flowtinus prototype');

const repoPath = (uri: vscode.Uri) => relative(root, uri.fsPath).split(sep).join('/');
const repoUri = (path: string) => vscode.Uri.file(join(root, path));
const inRepo = (uri: vscode.Uri) => uri.scheme === 'file' && root !== '' && !relative(root, uri.fsPath).startsWith('..');

function rebuild() {
    const unsaved: Record<string, string> = {};
    for (const doc of vscode.workspace.textDocuments) {
        if (doc.isDirty && inRepo(doc.uri)) {
            unsaved[repoPath(doc.uri)] = doc.getText();
        }
    }
    const started = Date.now();
    index = buildIndex(root, unsaved);
    root = index.root;
    log.appendLine(`index: ${Object.keys(index.files).length} files, ${index.workspaces.size} workspace(s), ${Date.now() - started} ms`);
    publishDiagnostics();
    syncScriptTypes();
    indexChanged.fire();
}

// ---------- scripts: VS Code's own TypeScript resolves @w/ imports and knows the runtime's globals ----------

const TSCONFIG_MARK = '// Written by the Flowtinus extension (PROTOTYPE), kept out of git by .git/info/exclude: do not edit.';

/**
 * A tsconfig.json at the repository's root, as the editor's Monaco is set up (monaco-setup.ts): `paths` from each
 * project's import prefix (@w/<workspace>/<project handle>/scripts/) to its folder, and the runtime's globals
 * (SCRIPT_GLOBALS) in .flowtinus/globals.d.ts. Neither is the developer's: both go in .git/info/exclude, never in a commit.
 * A tsconfig.json someone else wrote is left alone.
 */
function syncScriptTypes() {
    if (!index) {
        return;
    }
    const projects = new Set(
        Object.keys(index.files).flatMap(p => {
            const e = repoEntry(p);
            return e.kind === 'project' ? [`${e.workspace}\0${e.project}`] : [];
        }),
    );
    const paths = Object.fromEntries(
        [...projects].sort().map(key => {
            const [workspace, project] = key.split('\0') as [string, string];
            return [`${scriptImportPrefix(workspace, handleOf(project))}*`, [`./${workspace}/projects/${project}/scripts/*`]];
        }),
    );
    const tsconfig = `${TSCONFIG_MARK}\n${JSON.stringify(
        {
            compilerOptions: {
                target: 'esnext',
                lib: ['esnext'],
                strict: false,
                noEmit: true,
                moduleDetection: 'force',
                moduleResolution: 'bundler',
                module: 'esnext',
                paths,
            },
            include: ['*/projects/*/scripts/**/*.ts', '.flowtinus/globals.d.ts'],
        },
        null,
        2,
    )}\n`;
    const write = (path: string, text: string) => {
        const file = join(root, path);
        if (existsSync(file) && readFileSync(file, 'utf8') === text) {
            return;
        }
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, text);
        log.appendLine(`wrote ${path}`);
    };
    const tsconfigPath = join(root, 'tsconfig.json');
    if (existsSync(tsconfigPath) && !readFileSync(tsconfigPath, 'utf8').startsWith(TSCONFIG_MARK)) {
        log.appendLine("tsconfig.json is the repository's own: left alone, @w/ imports may not resolve");
        return;
    }
    write('tsconfig.json', tsconfig);
    write('.flowtinus/globals.d.ts', `${SCRIPT_GLOBALS}\n`);
    const exclude = join(root, '.git', 'info', 'exclude');
    if (existsSync(join(root, '.git'))) {
        const now = existsSync(exclude) ? readFileSync(exclude, 'utf8') : '';
        const missing = ['/tsconfig.json', '/.flowtinus/'].filter(l => !now.split(/\r?\n/).includes(l));
        if (missing.length) {
            mkdirSync(dirname(exclude), { recursive: true });
            writeFileSync(
                exclude,
                `${now}${now && !now.endsWith('\n') ? '\n' : ''}# the Flowtinus extension's (PROTOTYPE)\n${missing.join('\n')}\n`,
            );
        }
    }
}

let timer: ReturnType<typeof setTimeout> | undefined;
const scheduleRebuild = () => {
    clearTimeout(timer);
    timer = setTimeout(rebuild, 300);
};

function resolveId(path: string, id: string): { kind: 'connection' | 'flow'; named: Named } | undefined {
    const ws = index?.workspaces.get(workspaceOf(path) ?? '');
    const connection = ws?.connections.get(id);
    if (connection) {
        return { kind: 'connection', named: connection };
    }
    const flow = ws?.flows.get(id);
    return flow ? { kind: 'flow', named: flow } : undefined;
}

// ---------- diagnostics: the core's tree validation, per file ----------

const diagnostics = vscode.languages.createDiagnosticCollection('flowtinus');

function publishDiagnostics() {
    diagnostics.clear();
    const byPath = new Map<string, vscode.Diagnostic[]>();
    for (const ws of index?.workspaces.values() ?? []) {
        const all = [
            ...ws.validation.errors.map(i => ({ ...i, severity: vscode.DiagnosticSeverity.Error })),
            ...ws.validation.warnings.map(i => ({ ...i, severity: vscode.DiagnosticSeverity.Warning })),
        ];
        for (const issue of all) {
            const text = index!.files[issue.path] ?? '';
            // the issue has no position: the first quoted value of the message found in the file, else the first line
            const quoted = [...issue.message.matchAll(/"([^"]+)"/g)].map(m => m[1]!).find(q => text.includes(q));
            const yamlLine = issue.message.match(/at line (\d+)/)?.[1];
            const line = yamlLine ? Number(yamlLine) - 1 : quoted ? text.slice(0, text.indexOf(quoted)).split('\n').length - 1 : 0;
            const d = new vscode.Diagnostic(new vscode.Range(line, 0, line, 1000), issue.message, issue.severity);
            d.source = 'flowtinus';
            byPath.set(issue.path, [...(byPath.get(issue.path) ?? []), d]);
        }
    }
    for (const [path, text] of Object.entries(index?.files ?? {})) {
        if (repoEntry(path).kind !== 'script') {
            continue;
        }
        for (const r of relativeImports(text)) {
            const at = (offset: number) => {
                const before = text.slice(0, offset).split('\n');
                return new vscode.Position(before.length - 1, before.at(-1)!.length);
            };
            const d = new vscode.Diagnostic(
                new vscode.Range(at(r.start), at(r.end)),
                `Flowtinus finds a script only by its import path: write ${toImportPath(path, r.specifier) ?? "'@w/<workspace>/<project>/scripts/<path>'"}.`,
                vscode.DiagnosticSeverity.Error,
            );
            d.source = 'flowtinus';
            d.code = RELATIVE_IMPORT;
            byPath.set(path, [...(byPath.get(path) ?? []), d]);
        }
    }
    for (const [path, list] of byPath) {
        diagnostics.set(repoUri(path), list);
    }
}

// a script's relative import ('./x', '../y'): the runner only follows @w/ import paths (the core's scriptImports)
const RELATIVE_IMPORT = 'relative-import';

function relativeImports(code: string): { specifier: string; start: number; end: number }[] {
    const found: { specifier: string; start: number; end: number }[] = [];
    for (const m of code.matchAll(/(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"])(\.{1,2}\/[^'"]*)\2/g)) {
        const start = m.index + m[1]!.length + 1;
        found.push({ specifier: m[3]!, start, end: start + m[3]!.length });
    }
    return found;
}

/** the @w/ import path of a relative import in the script at `path`, when it lands on a script of the repository */
function toImportPath(path: string, specifier: string): string | undefined {
    const target = join(dirname(path), specifier).split(sep).join('/').replace(/\.ts$/, '');
    const entry = repoEntry(`${target}.ts`);
    return entry.kind === 'script' && index?.files[`${target}.ts`] !== undefined
        ? scriptImport(entry.workspace, handleOf(entry.project), entry.path)
        : undefined;
}

const relativeImportFix: vscode.CodeActionProvider = {
    provideCodeActions(doc, _range, context) {
        return context.diagnostics
            .filter(d => d.code === RELATIVE_IMPORT)
            .flatMap(d => {
                const to = toImportPath(repoPath(doc.uri), doc.getText(d.range));
                if (!to) {
                    return [];
                }
                const fix = new vscode.CodeAction(`Use '${to}'`, vscode.CodeActionKind.QuickFix);
                fix.edit = new vscode.WorkspaceEdit();
                fix.edit.replace(doc.uri, d.range, to);
                fix.diagnostics = [d];
                fix.isPreferred = true;
                return [fix];
            });
    },
};

/** auto import writes `@w/...` (the tsconfig's paths) instead of `../x`: a workspace setting, kept out of git when it is ours */
async function preferImportPaths() {
    const config = vscode.workspace.getConfiguration('typescript');
    if (config.inspect('preferences.importModuleSpecifier')?.workspaceValue === 'non-relative') {
        return;
    }
    const settings = join(root, '.vscode', 'settings.json');
    const ours = !existsSync(settings);
    await config.update('preferences.importModuleSpecifier', 'non-relative', vscode.ConfigurationTarget.Workspace);
    log.appendLine('set typescript.preferences.importModuleSpecifier to non-relative (.vscode/settings.json)');
    const exclude = join(root, '.git', 'info', 'exclude');
    if (ours && existsSync(join(root, '.git'))) {
        const now = existsSync(exclude) ? readFileSync(exclude, 'utf8') : '';
        if (!now.split(/\r?\n/).includes('/.vscode/settings.json')) {
            writeFileSync(exclude, `${now}${now && !now.endsWith('\n') ? '\n' : ''}/.vscode/settings.json\n`);
        }
    }
}

// ---------- names behind ids: hover, inlay hints, go to definition, completion ----------

const ownIdLine = (line: string) => /^id:/.test(line);

const hover: vscode.HoverProvider = {
    provideHover(doc, position) {
        const range = doc.getWordRangeAtPosition(position, UUID);
        if (!range || ownIdLine(doc.lineAt(position.line).text)) {
            return undefined;
        }
        const found = resolveId(repoPath(doc.uri), doc.getText(range));
        const md = found
            ? `**${found.kind === 'connection' ? 'Connection' : 'Flow'}** ${found.named.name}` +
              (found.named.type ? ` · \`${found.named.type}\`` : '') +
              `\n\n[${found.named.path}](${repoUri(found.named.path).toString()})`
            : '**Unknown id**: no connection or flow of this workspace has it.';
        return new vscode.Hover(new vscode.MarkdownString(md), range);
    },
};

const inlayHints: vscode.InlayHintsProvider = {
    onDidChangeInlayHints: indexChanged.event,
    provideInlayHints(doc, range) {
        const hints: vscode.InlayHint[] = [];
        for (let i = range.start.line; i <= range.end.line && i < doc.lineCount; i++) {
            const text = doc.lineAt(i).text;
            if (ownIdLine(text)) {
                continue;
            }
            for (const m of text.matchAll(UUID)) {
                const found = resolveId(repoPath(doc.uri), m[0]);
                if (found) {
                    const hint = new vscode.InlayHint(
                        new vscode.Position(i, m.index + m[0].length),
                        `${found.kind === 'connection' ? '🔌' : '↪'} ${found.named.name}`,
                    );
                    hint.paddingLeft = true;
                    hints.push(hint);
                }
            }
        }
        return hints;
    },
};

const definition: vscode.DefinitionProvider = {
    provideDefinition(doc, position) {
        const range = doc.getWordRangeAtPosition(position, UUID);
        const found = range && resolveId(repoPath(doc.uri), doc.getText(range));
        return found ? new vscode.Location(repoUri(found.named.path), new vscode.Position(0, 0)) : undefined;
    },
};

const propertyIndent = (line: string) => {
    const m = line.match(/^(\s*)(-\s+)?/)!;
    return m[1]!.length + (m[2]?.length ?? 0);
};

/** the `type:` of the node whose config holds this line: the nearest list item above, at a smaller indent */
function nodeTypeAt(doc: vscode.TextDocument, line: number): string | undefined {
    const indent = propertyIndent(doc.lineAt(line).text);
    for (let i = line - 1; i >= 0; i--) {
        const text = doc.lineAt(i).text;
        if (/^\s*-\s/.test(text) && propertyIndent(text) < indent) {
            const level = propertyIndent(text);
            for (let j = i; j < line; j++) {
                const t = doc.lineAt(j).text;
                const m = t.match(/^\s*(?:-\s+)?type:\s*["']?([\w-]+)/);
                if (m && propertyIndent(t) === level) {
                    return m[1];
                }
            }
            return undefined;
        }
    }
    return undefined;
}

const completion: vscode.CompletionItemProvider = {
    provideCompletionItems(doc, position) {
        const before = doc.lineAt(position.line).text.slice(0, position.character);
        const m = before.match(/^\s*(?:-\s+)?([\w]+):\s*["']?([\w-]*)$/);
        if (!m) {
            return undefined;
        }
        const [, key, typed] = m;
        const ws = index?.workspaces.get(workspaceOf(repoPath(doc.uri)) ?? '');
        if (!ws) {
            return undefined;
        }
        const range = new vscode.Range(position.translate(0, -typed!.length), position);
        let candidates: Named[] = [];
        let kind = '';
        if (REFERENCE_KEYS.connection.has(key!)) {
            const accepted = acceptedConnectionTypes(nodeTypeAt(doc, position.line) ?? '');
            candidates = [...ws.connections.values()].filter(c => !accepted || accepted.includes(c.type ?? ''));
            kind = accepted ? `connection (${accepted.join(', ')})` : 'connection';
        } else if (REFERENCE_KEYS.flow.has(key!)) {
            candidates = [...ws.flows.values()].filter(f => f.path !== repoPath(doc.uri));
            kind = 'flow';
        } else {
            return undefined;
        }
        return candidates.map(c => {
            const item = new vscode.CompletionItem({ label: c.name, description: c.type }, vscode.CompletionItemKind.Reference);
            item.insertText = c.id;
            item.filterText = `${c.name} ${c.id}`;
            item.range = range;
            item.detail = `${kind}: ${c.path}`;
            item.documentation = c.id;
            return item;
        });
    },
};

// ---------- the canonical form: format on save and on demand ----------

function formatEdits(doc: vscode.TextDocument, quiet: boolean): vscode.TextEdit[] {
    if (!inRepo(doc.uri)) {
        return [];
    }
    const text = doc.getText();
    const result = formatRepoFile(repoPath(doc.uri), text);
    if (!result) {
        return [];
    }
    if (!result.ok) {
        if (!quiet) {
            void vscode.window.showWarningMessage(`Not formatted: ${result.errors.join(' ')}`);
        }
        return [];
    }
    if (result.value === text) {
        return [];
    }
    if (result.droppedComment) {
        void vscode.window.showWarningMessage(
            `${basename(doc.fileName)}: its comments were dropped (a node's notes keep what a comment would).`,
        );
    }
    return [vscode.TextEdit.replace(new vscode.Range(0, 0, doc.lineCount, 0), result.value)];
}

// ---------- the canvas: a custom editor over the text document ----------

type WebviewMessage =
    | { type: 'ready' }
    | { type: 'move'; moves: { id: string; x: number; y: number }[] }
    | { type: 'connect'; edge: { source: string; sourcePort: string; target: string; targetPort: string } }
    | { type: 'delete'; nodes: string[]; edges: { source: string; sourcePort: string; target: string; targetPort: string }[] }
    | { type: 'rename'; id: string }
    | { type: 'add'; x: number; y: number }
    | { type: 'openText' }
    | { type: 'open'; id: string };

let activeCanvas: vscode.Uri | undefined;

class FlowCanvas implements vscode.CustomTextEditorProvider {
    constructor(private readonly context: vscode.ExtensionContext) {}

    resolveCustomTextEditor(doc: vscode.TextDocument, panel: vscode.WebviewPanel): void {
        const out = vscode.Uri.joinPath(this.context.extensionUri, 'out');
        panel.webview.options = { enableScripts: true, localResourceRoots: [out] };
        const asset = (file: string) => panel.webview.asWebviewUri(vscode.Uri.joinPath(out, file));
        panel.webview.html = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${panel.webview.cspSource} 'unsafe-inline'; script-src ${panel.webview.cspSource};">
<link rel="stylesheet" href="${asset('xyflow.css')}"><link rel="stylesheet" href="${asset('webview.css')}">
</head><body><div id="root"></div><script type="module" src="${asset('webview.js')}"></script></body></html>`;

        const name = () => {
            const entry = repoEntry(repoPath(doc.uri));
            return entry.kind === 'flow' ? entry.name : basename(doc.fileName, '.flow.yaml');
        };
        const read = () => repoFlowFromYaml(doc.getText(), name());

        const post = () => {
            const result = read();
            if (!result.ok) {
                void panel.webview.postMessage({ type: 'state', errors: result.errors, flow: null });
                return;
            }
            const { flow } = result.value;
            const nodes = flow.nodes.map(n => {
                const refs = [...REFERENCE_KEYS.connection, ...REFERENCE_KEYS.flow]
                    .map(key => n.config[key])
                    .filter((v): v is string => typeof v === 'string' && v !== '')
                    .map(id => resolveId(repoPath(doc.uri), id)?.named.name ?? `unknown id ${id.slice(0, 8)}…`);
                return {
                    id: n.id,
                    type: n.type,
                    typeLabel: componentLabel(n.type),
                    label: n.label,
                    position: n.position,
                    refs,
                    ...ports(n.type, n.config),
                };
            });
            const issues = index?.workspaces.get(workspaceOf(repoPath(doc.uri)) ?? '')?.validation;
            const fileIssues = issues ? issues.errors.filter(i => i.path === repoPath(doc.uri)).map(i => i.message) : [];
            void panel.webview.postMessage({ type: 'state', flow: { nodes, edges: flow.edges }, errors: fileIssues });
        };

        const edit = async (change: (flow: FlowFile) => void) => {
            const result = read();
            if (!result.ok) {
                return;
            }
            const { flow, ...triggers }: RepoFlow = result.value;
            change(flow);
            const text = repoFlowToYaml(flow, triggers);
            if (text === doc.getText()) {
                return;
            }
            const we = new vscode.WorkspaceEdit();
            we.replace(doc.uri, new vscode.Range(0, 0, doc.lineCount, 0), text);
            await vscode.workspace.applyEdit(we);
        };

        type PortEdge = { source: string; sourcePort: string; target: string; targetPort: string };
        const sameEdge = (a: PortEdge, b: PortEdge) =>
            a.source === b.source && a.target === b.target && a.sourcePort === b.sourcePort && a.targetPort === b.targetPort;

        const subscriptions = [
            vscode.workspace.onDidChangeTextDocument(e => e.document.uri.toString() === doc.uri.toString() && post()),
            indexChanged.event(post),
            panel.onDidChangeViewState(() => panel.active && (activeCanvas = doc.uri)),
            panel.webview.onDidReceiveMessage(async (msg: WebviewMessage) => {
                switch (msg.type) {
                    case 'ready':
                        return post();
                    case 'move':
                        return edit(flow => {
                            for (const m of msg.moves) {
                                const node = flow.nodes.find(n => n.id === m.id);
                                if (node) {
                                    node.position = { x: Math.round(m.x), y: Math.round(m.y) };
                                }
                            }
                        });
                    case 'connect':
                        return edit(flow => {
                            if (!flow.edges.some(e => sameEdge(e, msg.edge))) {
                                flow.edges.push(msg.edge);
                            }
                        });
                    case 'delete':
                        return edit(flow => {
                            flow.nodes = flow.nodes.filter(n => !msg.nodes.includes(n.id));
                            flow.edges = flow.edges.filter(
                                e => !msg.nodes.includes(e.source) && !msg.nodes.includes(e.target) && !msg.edges.some(d => sameEdge(d, e)),
                            );
                        });
                    case 'rename': {
                        const node = read().ok ? (read() as { value: RepoFlow }).value.flow.nodes.find(n => n.id === msg.id) : undefined;
                        const label = await vscode.window.showInputBox({
                            prompt: 'Card label',
                            value: node?.label ?? componentLabel(node?.type ?? ''),
                        });
                        return label === undefined
                            ? undefined
                            : edit(flow => {
                                  const n = flow.nodes.find(x => x.id === msg.id);
                                  if (n) {
                                      n.label = label || undefined;
                                  }
                              });
                    }
                    case 'add': {
                        const picked = await vscode.window.showQuickPick(
                            Object.entries(COMPONENTS).map(([type, c]) => ({ label: c.label, description: type, type })),
                            { placeHolder: 'Component to add' },
                        );
                        return (
                            picked &&
                            edit(flow => {
                                flow.nodes.push({
                                    id: crypto.randomUUID(),
                                    type: picked.type,
                                    position: { x: Math.round(msg.x), y: Math.round(msg.y) },
                                    config: settingsDefaults(componentSettings(picked.type)),
                                });
                            })
                        );
                    }
                    case 'openText':
                        return vscode.commands.executeCommand('vscode.openWith', doc.uri, 'default', vscode.ViewColumn.Beside);
                    case 'open': {
                        const found = resolveId(repoPath(doc.uri), msg.id);
                        return found && vscode.commands.executeCommand('vscode.open', repoUri(found.named.path));
                    }
                }
            }),
        ];
        activeCanvas = doc.uri;
        panel.onDidDispose(() => subscriptions.forEach(s => s.dispose()));
    }
}

// ---------- the web editor's own flow page in a webview, its /api answered from the repo (fake-api.ts) ----------

class RealEditor implements vscode.CustomTextEditorProvider {
    constructor(private readonly context: vscode.ExtensionContext) {}

    resolveCustomTextEditor(doc: vscode.TextDocument, panel: vscode.WebviewPanel): void {
        const out = vscode.Uri.joinPath(this.context.extensionUri, 'out', 'editor');
        panel.webview.options = { enableScripts: true, localResourceRoots: [out] };
        const asset = (file: string) => panel.webview.asWebviewUri(vscode.Uri.joinPath(out, file));
        const path = repoPath(doc.uri);
        const entry = repoEntry(path);
        const flowId = doc.getText().match(/^id:\s*(\S+)/m)?.[1] ?? '';
        const route =
            entry.kind === 'flow'
                ? `/w/${entry.workspace}/projects/${projectIdOf(apiHost, entry.workspace, entry.project)}/flows/${flowId}`
                : '/';
        const csp = panel.webview.cspSource;
        const render = () => {
            panel.webview.html = `<!doctype html><html class="dark"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${csp} 'unsafe-inline'; font-src ${csp} data:; img-src ${csp} data: blob:; script-src ${csp} 'unsafe-inline' 'unsafe-eval'; worker-src ${csp} blob:; connect-src ${csp};">
<link rel="stylesheet" href="${asset('editor.css')}"></head>
<body><div id="root" style="height:100vh"></div><script>window.FLOWTINUS_ROUTE=${JSON.stringify(route)};window.FLOWTINUS_CAN=${JSON.stringify(connection ? ['run'] : [])}</script>
<script type="module" src="${asset('editor.js')}"></script></body></html>`;
        };
        render();

        // this file's errors (the Problems panel's), shown over the canvas: the page itself only learns of them on Run
        const postIssues = () => {
            const errors = vscode.languages
                .getDiagnostics(doc.uri)
                .filter(d => d.severity === vscode.DiagnosticSeverity.Error)
                .map(d => ({ message: d.message, line: d.range.start.line }));
            void panel.webview.postMessage({ type: 'fileIssues', errors });
        };

        // the editor's own saves change the document: only a change from elsewhere (the text, git, undo) reopens the page
        let ownVersion = -1;
        const subscriptions = [
            panel.webview.onDidReceiveMessage(async (msg: { type: string; id: number; method: string; url: string; body: unknown }) => {
                if (msg.type === 'shimReady') {
                    return postIssues();
                }
                if (msg.type === 'openAt') {
                    const line = (msg as unknown as { line: number }).line;
                    const editor = await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside });
                    editor.selection = new vscode.Selection(line, 0, line, 0);
                    editor.revealRange(new vscode.Range(line, 0, line, 0), vscode.TextEditorRevealType.InCenter);
                    return;
                }
                if (msg.type !== 'api') {
                    return;
                }
                const answered = await answer(
                    {
                        ...apiHost,
                        read: p => (p === path ? doc.getText() : apiHost.read(p)),
                        revision: p => (p === path ? doc.version : 0),
                        write: async (p, text) => {
                            if (p !== path) {
                                return apiHost.write(p, text);
                            }
                            const we = new vscode.WorkspaceEdit();
                            we.replace(doc.uri, new vscode.Range(0, 0, doc.lineCount, 0), text);
                            await vscode.workspace.applyEdit(we);
                            ownVersion = doc.version;
                        },
                    },
                    msg.method,
                    msg.url,
                    msg.body,
                );
                void panel.webview.postMessage({ type: 'apiAnswer', id: msg.id, ...answered });
            }),
            connectionChanged.event(render),
            // the diagnostics come from the index, rebuilt after each change of the text
            indexChanged.event(postIssues),
            vscode.workspace.onDidChangeTextDocument(e => {
                if (e.document.uri.toString() === doc.uri.toString() && e.contentChanges.length > 0 && doc.version !== ownVersion) {
                    log.appendLine(`editor page reopened: ${path} changed outside it`);
                    render();
                }
            }),
        ];
        panel.onDidDispose(() => subscriptions.forEach(s => s.dispose()));
    }
}

const apiHost: ApiHost = {
    index: () => index,
    read: p => index?.files[p] ?? '',
    write: async (p, text) => {
        await vscode.workspace.fs.writeFile(repoUri(p), Buffer.from(text));
    },
    revision: () => 0,
    log: line => log.appendLine(`api ${line}`),
    server: () => connection,
};

// ---------- the server a personal access token connects to (the token in VS Code's SecretStorage) ----------

let connection: { url: string; token: string } | undefined;
const connectionChanged = new vscode.EventEmitter<void>();
const TOKEN_KEY = 'flowtinus.token';
const URL_KEY = 'flowtinus.serverUrl';

async function loadConnection(context: vscode.ExtensionContext) {
    const token = await context.secrets.get(TOKEN_KEY);
    const url = context.globalState.get<string>(URL_KEY);
    connection = token && url ? { url, token } : undefined;
    connectionChanged.fire();
}

async function connect(context: vscode.ExtensionContext) {
    const url = await vscode.window.showInputBox({
        prompt: 'Flowtinus server (its API)',
        value: context.globalState.get<string>(URL_KEY) ?? 'http://localhost:5190',
    });
    const token = url && (await vscode.window.showInputBox({ prompt: 'Personal access token (ftn_...)', password: true }));
    if (!url || !token) {
        return;
    }
    const me = await fetch(`${url.replace(/\/$/, '')}/me`, { headers: { authorization: `Bearer ${token}` } }).catch(() => undefined);
    if (!me?.ok) {
        void vscode.window.showErrorMessage(`Not connected: ${me ? `the server answered ${me.status}` : 'the server does not answer'}.`);
        return;
    }
    const { name } = (await me.json()) as { name: string };
    await context.secrets.store(TOKEN_KEY, token);
    await context.globalState.update(URL_KEY, url.replace(/\/$/, ''));
    await loadConnection(context);
    void vscode.window.showInformationMessage(`Connected to ${url} as ${name}: Run runs your file there (a test run).`);
}

async function disconnect(context: vscode.ExtensionContext) {
    await context.secrets.delete(TOKEN_KEY);
    await loadConnection(context);
    void vscode.window.showInformationMessage('Disconnected: the editor only edits the file.');
}

// ---------- explorer commands ----------

const git = (cwd: string, args: string[]) =>
    new Promise<{ ok: boolean; out: string }>(done =>
        execFile('git', args, { cwd }, (error, stdout, stderr) => done({ ok: !error, out: `${stdout}${stderr}`.trim() })),
    );

async function writeNew(target: string, text: string, kinds: string[]): Promise<boolean> {
    const path = relative(root, target).split(sep).join('/');
    const entry = repoEntry(path);
    if (!kinds.includes(entry.kind) || !('workspace' in entry)) {
        void vscode.window.showErrorMessage(`${path} is not where a ${kinds[0]} lives.`);
        return false;
    }
    if (existsSync(target)) {
        void vscode.window.showErrorMessage(`${path} is already there.`);
        return false;
    }
    // as `flowtinus new`: the core's own name rules decide, on the tree with the new file in it
    const issues = validateWorkspaceTree({ workspace: entry.workspace, files: { ...index?.files, [path]: text } }).errors.filter(
        i => i.path === path || path.startsWith(`${i.path}/`),
    );
    if (issues.length > 0) {
        void vscode.window.showErrorMessage(issues.map(i => i.message).join(' '));
        return false;
    }
    await vscode.workspace.fs.writeFile(vscode.Uri.file(target), Buffer.from(text));
    return true;
}

const askName = (prompt: string, value = '') =>
    vscode.window.showInputBox({ prompt, value, validateInput: v => (v.trim() ? undefined : 'A name') });

async function newFlow(folder?: vscode.Uri) {
    const name = folder && (await askName('Flow name'));
    if (!folder || !name) {
        return;
    }
    const target = join(folder.fsPath, `${name}.flow.yaml`);
    if (await writeNew(target, repoFlowToYaml(newFlowFile(name, crypto.randomUUID())), ['flow'])) {
        await vscode.commands.executeCommand('vscode.openWith', vscode.Uri.file(target), 'flowtinus.editor');
    }
}

async function newFolder(folder?: vscode.Uri) {
    const name = folder && (await askName('Folder name'));
    if (folder && name) {
        await writeNew(join(folder.fsPath, name, '.gitkeep'), '', ['folder', 'scriptFolder']);
    }
}

async function newScript(folder?: vscode.Uri) {
    const name = folder && (await askName('Script name'));
    const target = folder && name && join(folder.fsPath, `${name}.ts`);
    if (target && (await writeNew(target, 'export function run(input: unknown) {\n    return input;\n}\n', ['script']))) {
        await vscode.window.showTextDocument(vscode.Uri.file(target));
    }
}

async function newConnection(folder?: vscode.Uri) {
    const name = folder && (await askName('Connection name'));
    const type =
        name &&
        (await vscode.window.showQuickPick(
            CONNECTION_TYPES.map(t => t.type),
            { placeHolder: 'Connection type' },
        ));
    const target = folder && name && type && join(folder.fsPath, `${name}.yaml`);
    if (target && (await writeNew(target, connectionToYaml({ id: crypto.randomUUID(), type: type as never }), ['connection']))) {
        await vscode.window.showTextDocument(vscode.Uri.file(target));
    }
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

async function rename(uri?: vscode.Uri) {
    if (!uri || !inRepo(uri)) {
        return;
    }
    const from = repoPath(uri);
    const suffix = from.endsWith('.flow.yaml') ? '.flow.yaml' : from.endsWith('.ts') ? '.ts' : from.endsWith('.yaml') ? '.yaml' : '';
    const old = basename(from, suffix);
    const name = await askName(`Rename ${basename(from)}`, old);
    if (!name || name === old) {
        return;
    }
    const to = `${dirname(from)}/${name}${suffix}`;
    const caseOnly = to.toLowerCase() === from.toLowerCase();
    const moved = await git(root, ['mv', '--', from, to]);
    if (!moved.ok && /not under version control|bad source/.test(moved.out)) {
        // a file git does not track yet: an ordinary rename is all git needs
        await vscode.workspace.fs.rename(uri, repoUri(to));
        log.appendLine(`renamed (untracked) ${from} -> ${to}`);
    } else if (!moved.ok) {
        void vscode.window.showErrorMessage(`git mv failed: ${moved.out}`);
        return;
    } else {
        log.appendLine(`git mv ${from} ${to}${caseOnly ? ' (case only)' : ''}`);
    }

    const before = repoEntry(from);
    const after = repoEntry(to);
    if (before.kind === 'script' && after.kind === 'script') {
        // scripts are referred to by path: find what names the old one
        const oldImport = scriptImport(before.workspace, before.project, before.path);
        const newImport = scriptImport(after.workspace, after.project, after.path);
        const pattern = new RegExp(`${escapeRegExp(oldImport)}(?![\\w/.-])`, 'g');
        const users = Object.entries(index?.files ?? {}).filter(([p, text]) => p !== from && pattern.test(text));
        if (users.length > 0) {
            const answer = await vscode.window.showWarningMessage(
                `${users.length} file(s) refer to ${oldImport}: ${users.map(([p]) => p).join(', ')}`,
                'Update the references',
                'Leave them',
            );
            if (answer === 'Update the references') {
                const we = new vscode.WorkspaceEdit();
                for (const [p, text] of users) {
                    const doc = await vscode.workspace.openTextDocument(repoUri(p));
                    we.replace(doc.uri, new vscode.Range(0, 0, doc.lineCount, 0), text.replace(pattern, newImport));
                }
                await vscode.workspace.applyEdit(we);
            }
        }
    } else if (before.kind === 'flow' || before.kind === 'connection') {
        void vscode.window.showInformationMessage(
            `Renamed${caseOnly ? ' (case only, recorded by git mv)' : ''}. Flows refer to a ${before.kind} by id: no other file changes.`,
        );
    }
    scheduleRebuild();
}

// ---------- activation ----------

export function activate(context: vscode.ExtensionContext) {
    root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
    if (!root) {
        return;
    }
    rebuild();
    void loadConnection(context);
    void preferImportPaths();
    const repoChanged = (uri: vscode.Uri) => inRepo(uri) && scheduleRebuild();
    const watcher = vscode.workspace.createFileSystemWatcher('**/*');
    context.subscriptions.push(
        log,
        diagnostics,
        watcher,
        watcher.onDidCreate(repoChanged),
        watcher.onDidDelete(repoChanged),
        watcher.onDidChange(repoChanged),
        vscode.workspace.onDidChangeTextDocument(e => repoChanged(e.document.uri)),
        vscode.workspace.onWillSaveTextDocument(e => e.waitUntil(Promise.resolve(formatEdits(e.document, true)))),
        vscode.languages.registerHoverProvider(FLOW_SELECTOR, hover),
        vscode.languages.registerInlayHintsProvider(FLOW_SELECTOR, inlayHints),
        vscode.languages.registerDefinitionProvider(FLOW_SELECTOR, definition),
        vscode.languages.registerCompletionItemProvider(FLOW_SELECTOR, completion, ' ', ':'),
        vscode.languages.registerCodeActionsProvider({ scheme: 'file', pattern: '**/scripts/**/*.ts' }, relativeImportFix, {
            providedCodeActionKinds: [vscode.CodeActionKind.QuickFix],
        }),
        vscode.languages.registerDocumentFormattingEditProvider(
            { scheme: 'file', pattern: '**/*.yaml' },
            { provideDocumentFormattingEdits: doc => formatEdits(doc, false) },
        ),
        vscode.window.registerCustomEditorProvider('flowtinus.flow', new FlowCanvas(context), {
            webviewOptions: { retainContextWhenHidden: true },
        }),
        vscode.window.registerCustomEditorProvider('flowtinus.editor', new RealEditor(context), {
            webviewOptions: { retainContextWhenHidden: true },
        }),
        vscode.commands.registerCommand('flowtinus.newFlow', newFlow),
        vscode.commands.registerCommand('flowtinus.newFolder', newFolder),
        vscode.commands.registerCommand('flowtinus.newScript', newScript),
        vscode.commands.registerCommand('flowtinus.newConnection', newConnection),
        vscode.commands.registerCommand('flowtinus.rename', rename),
        vscode.commands.registerCommand('flowtinus.format', async () => {
            const editor = vscode.window.activeTextEditor;
            if (editor) {
                const we = new vscode.WorkspaceEdit();
                we.set(editor.document.uri, formatEdits(editor.document, false));
                await vscode.workspace.applyEdit(we);
            }
        }),
        vscode.commands.registerCommand('flowtinus.connect', () => connect(context)),
        vscode.commands.registerCommand('flowtinus.disconnect', () => disconnect(context)),
        vscode.commands.registerCommand('flowtinus.openText', () =>
            activeCanvas ? vscode.commands.executeCommand('vscode.openWith', activeCanvas, 'default', vscode.ViewColumn.Beside) : undefined,
        ),
    );
    log.appendLine(`Flowtinus prototype on ${root}`);
}

export function deactivate() {}
