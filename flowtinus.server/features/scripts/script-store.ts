import { insideScriptFolder, movedScriptPath, normalizeScriptPath, pathCaseClash, scriptCodeOf, scriptExports, scriptImport, scriptImports, scriptPathIssue, type ScriptExport } from '@flowtinus/core';
import { and, eq, isNull } from 'drizzle-orm';
import { flows as flowsTable } from '#features/flows/flow';
import type { Database } from '#shared/database/database';

export type ScriptEntry = { path: string; revision: number; exports: ScriptExport[]; updatedBy: string | null; updatedAt: Date };

export async function listScripts(
    db: Database,
    workspaceId: string,
    projectId: string,
): Promise<{ scripts: ScriptEntry[]; folders: string[] }> {
    const scripts = await db.query<ScriptEntry>(
        `SELECT path, revision, exports, updated_by AS "updatedBy", updated_at AS "updatedAt" FROM scripts WHERE workspace_id = $1 AND project_id = $2 ORDER BY path`,
        [workspaceId, projectId],
    );
    // a script saved before the list kept what it exports the way it does now (exports null, a migration): read once more
    for (const script of scripts.filter(s => s.exports === null)) {
        const exports = exportsOf((await getScript(db, workspaceId, projectId, script.path))?.content ?? '');
        await db.query(
            'UPDATE scripts SET exports = $4::text::jsonb WHERE workspace_id = $1 AND project_id = $2 AND path = $3 AND exports IS NULL',
            [workspaceId, projectId, script.path, exports],
        );
        script.exports = JSON.parse(exports) as ScriptExport[];
    }

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
    const [row] = await db.query<{ path: string; content: string; revision: number }>(
        'SELECT path, content, revision FROM scripts WHERE workspace_id = $1 AND project_id = $2 AND path = $3',
        [workspaceId, projectId, path],
    );
    return row ?? null;
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
    const only = paths ? 'AND s.path = ANY($3::text[])' : '';
    return db.query<{ path: string; content: string }>(
        source === 'editing'
            ? `SELECT s.path, s.content FROM scripts s WHERE s.workspace_id = $1 AND s.project_id = $2 ${only} ORDER BY s.path`
            : `SELECT s.path, b.content FROM deployed_scripts s JOIN script_blobs b ON b.workspace_id = s.workspace_id AND b.hash = s.hash
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
    const scripts = await db.query<{ path: string; content: string }>(
        'SELECT path, content FROM scripts WHERE workspace_id = $1 AND project_id = $2',
        [workspaceId, projectId],
    );
    const flows = await db.orm
        .select({ id: flowsTable.id, name: flowsTable.name, draft: flowsTable.draftDefinition })
        .from(flowsTable)
        .where(and(eq(flowsTable.workspaceId, workspaceId), eq(flowsTable.projectId, projectId), isNull(flowsTable.deletedAt)));
    const codeOf = (draft: unknown) =>
        ((draft as { flow?: { nodes?: { type: string; config?: Record<string, unknown> }[] } } | null)?.flow?.nodes ?? [])
            .map(n => scriptCodeOf(n.type, n.config ?? {}) ?? '')
            .join('\n');
    return {
        flows: flows.filter(f => imports(codeOf(f.draft))).map(f => ({ id: f.id, name: f.name })),
        scripts: scripts.filter(s => !insideScriptFolder(s.path, path) && imports(s.content)).map(s => s.path),
    };
}

export async function moveScriptPath(db: Database, workspaceId: string, projectId: string, from: string, to: string, userId: string) {
    await db.transaction(async tx => {
        const { scripts, folders } = await listScripts(tx, workspaceId, projectId);
        for (const script of scripts.filter(s => insideScriptFolder(s.path, from))) {
            await tx.query(
                'UPDATE scripts SET path = $4, revision = revision + 1, updated_by = $5, updated_at = now() WHERE workspace_id = $1 AND project_id = $2 AND path = $3',
                [workspaceId, projectId, script.path, movedScriptPath(script.path, from, to), userId],
            );
        }
        const committed = await tx.query<{ path: string }>(
            'SELECT path FROM deployed_scripts WHERE workspace_id = $1 AND project_id = $2',
            [workspaceId, projectId],
        );
        for (const { path } of committed.filter(s => insideScriptFolder(s.path, from))) {
            await tx.query('UPDATE deployed_scripts SET path = $4 WHERE workspace_id = $1 AND project_id = $2 AND path = $3', [
                workspaceId,
                projectId,
                path,
                movedScriptPath(path, from, to),
            ]);
        }
        for (const folder of folders.filter(f => insideScriptFolder(f, from))) {
            await tx.query('UPDATE script_folders SET path = $4 WHERE workspace_id = $1 AND project_id = $2 AND path = $3', [
                workspaceId,
                projectId,
                folder,
                movedScriptPath(folder, from, to),
            ]);
        }
    });
}

export async function deleteScriptPath(db: Database, workspaceId: string, projectId: string, path: string) {
    await db.query(
        `DELETE FROM deployed_scripts WHERE workspace_id = $1 AND project_id = $2 AND (path = $3 OR starts_with(path, $3 || '/'))`,
        [workspaceId, projectId, path],
    );
    await db.query(`DELETE FROM scripts WHERE workspace_id = $1 AND project_id = $2 AND (path = $3 OR starts_with(path, $3 || '/'))`, [
        workspaceId,
        projectId,
        path,
    ]);
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
