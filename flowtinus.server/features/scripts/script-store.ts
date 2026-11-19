import { insideScriptFolder, repoPath, movedScriptPath, normalizeScriptPath, pathCaseClash, scriptCodeOf, scriptExports, scriptImport, scriptImports, scriptPathIssue, type ScriptExport } from '@flowtinus/core';
import { eq } from 'drizzle-orm';
import { flows as flowsTable } from '#features/flows/flow';
import { loadDraft } from '#features/flows/flow-draft';
import { FlowRepository } from '#features/folders/project-tree';
import { bestRows, ENVIRONMENT_BRANCH, fileRow, removeFile, scriptFileId, writeFile, type WorkingRow } from '#features/git/working-copy';
import type { Database } from '#shared/database/database';

export type ScriptEntry = { path: string; revision: number; exports: ScriptExport[]; updatedBy: string | null; updatedAt: Date };

/**
 * A project's scripts as they are being edited: the deployed set (git on) with the working copy of the environment's
 * branch over it; with git off, the working copy alone.
 */
export async function workingScripts(
    db: Database,
    workspaceId: string,
    projectId: string,
): Promise<{ path: string; content: string; revision: number; updatedBy: string | null; updatedAt: Date }[]> {
    const [rows, deployed] = await Promise.all([
        db.query<WorkingRow>(
            `SELECT path, content, deleted, file_id, base, edited_by, conflict, revision, updated_at FROM working_copy
           WHERE workspace_id = $1 AND branch = $2 AND starts_with(file_id, $3)`,
            [workspaceId, ENVIRONMENT_BRANCH, scriptFileId(projectId, '')],
        ),
        db.query<{ path: string; content: string; commit_sha: string }>(
            `SELECT d.path, b.content, d.commit_sha FROM deployed_scripts d JOIN script_blobs b ON b.workspace_id = d.workspace_id AND b.hash = d.hash
           WHERE d.workspace_id = $1 AND d.project_id = $2`,
            [workspaceId, projectId],
        ),
    ]);
    const scripts = new Map(
        deployed.map(d => [
            d.path,
            { path: d.path, content: d.content, revision: 0, updatedBy: null as string | null, updatedAt: new Date(0) },
        ]),
    );
    const prefix = scriptFileId(projectId, '');
    for (const [fileId, row] of bestRows(rows)) {
        const path = fileId.slice(prefix.length);
        if (row.deleted) {
            scripts.delete(path);
        } else {
            scripts.set(path, {
                path,
                content: row.content ?? '',
                revision: row.revision,
                updatedBy: row.edited_by,
                updatedAt: new Date(row.updated_at),
            });
        }
    }
    return [...scripts.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export async function listScripts(
    db: Database,
    workspaceId: string,
    projectId: string,
): Promise<{ scripts: ScriptEntry[]; folders: string[] }> {
    const scripts = (await workingScripts(db, workspaceId, projectId)).map(({ content, ...script }) => ({
        ...script,
        exports: scriptExports(content),
    }));
    const folders = await db.query<{ path: string }>(
        'SELECT path FROM script_folders WHERE workspace_id = $1 AND project_id = $2 ORDER BY path',
        [workspaceId, projectId],
    );
    return { scripts, folders: folders.map(f => f.path) };
}

export async function getScript(
    db: Database,
    workspaceId: string,
    projectId: string,
    path: string,
): Promise<{ path: string; content: string; revision: number } | null> {
    const script = (await workingScripts(db, workspaceId, projectId)).find(s => s.path === path);
    return script ? { path: script.path, content: script.content, revision: script.revision } : null;
}

async function scriptRepoPath(db: Database, workspaceId: string, projectId: string, path: string): Promise<string> {
    const [names] = await db.query<{ slug: string; project: string }>(
        'SELECT w.slug, p.name AS project FROM workspaces w JOIN projects p ON p.workspace_id = w.id WHERE w.id = $1 AND p.id = $2',
        [workspaceId, projectId],
    );
    return repoPath.script(names!.slug, names!.project, path);
}

/**
 * A script's new text (null: removed) in the working copy, if it is still at `expected` (when given): answers its
 * revision, or null when another save came in between.
 */
export async function writeScript(
    db: Database,
    workspaceId: string,
    projectId: string,
    path: string,
    content: string | null,
    userId: string | null,
    expected?: number,
): Promise<number | null> {
    const fileId = scriptFileId(projectId, path);
    const row = await fileRow(db, workspaceId, fileId);
    const live = row && !row.deleted ? row : null;
    if (expected !== undefined && expected !== (live?.revision ?? 0)) {
        return null;
    }
    const [committed] = await db.query<{ content: string }>(
        `SELECT b.content FROM deployed_scripts d JOIN script_blobs b ON b.workspace_id = d.workspace_id AND b.hash = d.hash
       WHERE d.workspace_id = $1 AND d.project_id = $2 AND d.path = $3`,
        [workspaceId, projectId, path],
    );
    const at = live?.path ?? (await scriptRepoPath(db, workspaceId, projectId, path));
    if (content === null) {
        if (live || committed) {
            await removeFile(db, workspaceId, { path: at, fileId, userId, ...(committed ? { committed: committed.content } : {}) });
        }
        return live?.revision ?? 0;
    }
    if (live) {
        const [saved] = await db.query<{ revision: number }>(
            `UPDATE working_copy SET content = $4, edited_by = $5, revision = revision + 1, updated_at = now()
           WHERE workspace_id = $1 AND branch = $2 AND path = $3 AND ($6::int IS NULL OR revision = $6) RETURNING revision`,
            [workspaceId, ENVIRONMENT_BRANCH, at, content, userId, expected ?? null],
        );
        return saved?.revision ?? null;
    }
    // a script made (no revision named) starts at the revision its path had; a save grows it
    return writeFile(db, workspaceId, {
        path: at,
        content,
        fileId,
        userId,
        ...(expected === undefined ? { revision: row?.revision ?? 0 } : {}),
        ...(committed ? { committed: committed.content } : {}),
    });
}

export const exportsOf = (content: string) => JSON.stringify(scriptExports(content));

export const scriptHash = (text: string) => new Bun.CryptoHasher('sha256').update(text).digest('hex');

export const saveBlob = async (db: Database, workspaceId: string, content: string) => {
    const hash = scriptHash(content);
    await db.query('INSERT INTO script_blobs (workspace_id, hash, content) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [
        workspaceId,
        hash,
        content,
    ]);
    return hash;
};

export type ScriptUser = { label: string; code: string };

export type ScriptSource = 'editing' | 'deployed';

export async function scriptContents(
    db: Database,
    workspaceId: string,
    projectId: string,
    source: ScriptSource,
    paths?: string[],
): Promise<{ path: string; content: string }[]> {
    if (source === 'editing') {
        const scripts = await workingScripts(db, workspaceId, projectId);
        return scripts.filter(s => !paths || paths.includes(s.path)).map(s => ({ path: s.path, content: s.content }));
    }
    const only = paths ? 'AND s.path = ANY($3::text[])' : '';
    return db.query<{ path: string; content: string }>(
        `SELECT s.path, b.content FROM deployed_scripts s JOIN script_blobs b ON b.workspace_id = s.workspace_id AND b.hash = s.hash
         WHERE s.workspace_id = $1 AND s.project_id = $2 ${only} ORDER BY s.path`,
        paths ? [workspaceId, projectId, paths] : [workspaceId, projectId],
    );
}

export async function scriptsForRun(
    db: Database,
    workspaceId: string,
    projectId: string,
    users: ScriptUser[],
    source: ScriptSource,
): Promise<{ scripts: Record<string, string>; error?: string }> {
    const contents = new Map<string, string>();
    for (const user of users) {
        let wanted = scriptImports(user.code).map(path => ({ path, from: null as string | null }));
        while (wanted.length > 0) {
            const fresh = wanted.filter(w => !contents.has(w.path));
            const rows = fresh.length ? await scriptContents(db, workspaceId, projectId, source, [...new Set(fresh.map(w => w.path))]) : [];
            rows.forEach(r => contents.set(r.path, r.content));
            const missing = fresh.find(w => !contents.has(w.path));
            if (missing) {
                const through = missing.from ? ` (through ${scriptImport(missing.from)})` : '';
                return { scripts: {}, error: `"${user.label}" imports ${scriptImport(missing.path)}${through}, which does not exist.` };
            }

            wanted = rows.flatMap(r => scriptImports(r.content).map(path => ({ path, from: r.path }))).filter(w => !contents.has(w.path));
        }
    }

    const scripts: Record<string, string> = {};
    for (const [path, content] of contents) {
        scripts[path] = await saveBlob(db, workspaceId, content);
    }

    return { scripts };
}

export async function scriptBlobs(db: Database, workspaceId: string, hashes: string[]): Promise<Map<string, string>> {
    if (hashes.length === 0) {
        return new Map();
    }
    const rows = await db.query<{ hash: string; content: string }>(
        'SELECT hash, content FROM script_blobs WHERE workspace_id = $1 AND hash = ANY($2::text[])',
        [workspaceId, hashes],
    );
    return new Map(rows.map(r => [r.hash, r.content]));
}

export const allFolders = (scripts: { path: string }[], folders: string[]) => {
    const all = new Set(folders);
    for (const path of [...scripts.map(s => s.path), ...folders]) {
        const parts = path.split('/');
        for (let i = 1; i < parts.length; i++) {
            all.add(parts.slice(0, i).join('/'));
        }
    }
    return [...all].sort();
};

export async function newPathIssue(
    db: Database,
    workspaceId: string,
    projectId: string,
    text: string,
    from?: string,
): Promise<string | null> {
    const path = normalizeScriptPath(text);
    const issue = scriptPathIssue(path);
    if (issue) {
        return issue;
    }
    const { scripts, folders } = await listScripts(db, workspaceId, projectId);
    if (scripts.some(s => s.path === path)) {
        return 'A script with this path already exists.';
    }
    if (allFolders(scripts, folders).includes(path)) {
        return 'A folder with this path already exists.';
    }
    if (scripts.some(s => path.startsWith(`${s.path}/`))) {
        return 'A script cannot hold other scripts: pick another folder.';
    }
    const others = [...scripts.map(s => s.path), ...folders].filter(other => from === undefined || !insideScriptFolder(other, from));
    const clash = pathCaseClash(path, others);
    return clash ? `${clash}: a disk that ignores case holds only one.` : null;
}

export async function scriptUsage(
    db: Database,
    workspaceId: string,
    projectId: string,
    path: string,
): Promise<{ flows: { id: string; name: string }[]; scripts: string[] }> {
    const imports = (code: string) => scriptImports(code).some(p => insideScriptFolder(p, path));
    const scripts = await workingScripts(db, workspaceId, projectId);
    const flows = await new FlowRepository(db, workspaceId).findMany(eq(flowsTable.projectId, projectId));
    const users: { id: string; name: string }[] = [];
    for (const flow of flows) {
        const { flow: file } = await loadDraft(db, workspaceId, flow);
        if (imports(file.nodes.map(n => scriptCodeOf(n.type, n.config ?? {}) ?? '').join('\n'))) {
            users.push({ id: flow.id, name: flow.name });
        }
    }
    return {
        flows: users,
        scripts: scripts.filter(s => !insideScriptFolder(s.path, path) && imports(s.content)).map(s => s.path),
    };
}

/** a script (or a folder of them) moved in the working copy: removed from where it was, added where it goes */
export async function moveScriptPath(db: Database, workspaceId: string, projectId: string, from: string, to: string, userId: string) {
    const { folders } = await listScripts(db, workspaceId, projectId);
    for (const script of (await workingScripts(db, workspaceId, projectId)).filter(s => insideScriptFolder(s.path, from))) {
        await writeScript(db, workspaceId, projectId, script.path, null, userId);
        await writeScript(db, workspaceId, projectId, movedScriptPath(script.path, from, to), script.content, userId);
    }
    for (const folder of folders.filter(f => insideScriptFolder(f, from))) {
        await db.query('UPDATE script_folders SET path = $4 WHERE workspace_id = $1 AND project_id = $2 AND path = $3', [
            workspaceId,
            projectId,
            folder,
            movedScriptPath(folder, from, to),
        ]);
    }
}

export async function deleteScriptPath(db: Database, workspaceId: string, projectId: string, path: string, userId: string) {
    for (const script of (await workingScripts(db, workspaceId, projectId)).filter(s => insideScriptFolder(s.path, path))) {
        await writeScript(db, workspaceId, projectId, script.path, null, userId);
    }
    await db.query(
        `DELETE FROM script_folders WHERE workspace_id = $1 AND project_id = $2 AND (path = $3 OR starts_with(path, $3 || '/'))`,
        [workspaceId, projectId, path],
    );
}

export async function typeSources(db: Database, workspaceId: string, projectId: string, path: string): Promise<Record<string, string>> {
    const sources: Record<string, string> = {};
    const queue = [path];
    while (queue.length > 0 && Object.keys(sources).length < 200) {
        const next = queue.shift()!;
        if (next in sources) {
            continue;
        }

        const script = await getScript(db, workspaceId, projectId, next);
        if (!script) {
            continue;
        }

        sources[next] = script.content;
        queue.push(...scriptImports(script.content).filter(p => !(p in sources)));
    }

    return sources;
}
