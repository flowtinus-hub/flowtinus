import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ANA, BIA, insertWorkspace, slugOf, wsPath } from '../helpers/workspaces';
import { commitAll, createBranch, git } from '../helpers/git-repos';
import { Keyring } from '#shared/crypto/keyring';
import { openDatabase, type Database } from '#shared/database/database';
import { createApp } from '../../api/app';

setDefaultTimeout(120_000);

type Change = { path: string; from?: string };

describe("turning git off and on: the work branches' working copies are kept, hidden, and show again", () => {
    let db: Database;
    let app: ReturnType<typeof createApp>;
    let dir: string;
    const keyring = new Keyring([{ version: 't', key: new Uint8Array(32).fill(7) }]);

    async function workspace() {
        const id = crypto.randomUUID();
        await insertWorkspace(db, id);
        const as = (user: string) => async (method: string, path: string, body?: unknown) => {
            const response = await app.request(wsPath(id, path), {
                method,
                headers: { 'x-user-id': user, 'content-type': 'application/json' },
                body: body === undefined ? undefined : JSON.stringify(body),
            });
            return { status: response.status, body: (await response.json()) as any };
        };
        const call = as(ANA);
        const projectId = (await call('POST', '/projects', { name: 'Sales' })).body.id as string;
        const repo = join(dir, `${id}.git`);
        git(dir, 'init', '--bare', '--quiet', '--initial-branch=main', repo);
        createBranch(repo, 'dev');
        await call('POST', '/secrets', { name: 'git-token', value: 'tok3n' });
        const config = { repository: pathToFileURL(repo).href, tokenSecret: 'git-token', environment: 'DEV' };
        await call('PUT', '/git', config);
        expect((await call('POST', '/git/topology', { confirm: true })).status).toBe(201);
        expect((await call('POST', '/git/on', { createBranch: true })).status).toBe(200);
        const orders = (await call('POST', `/projects/${projectId}/flows`, { name: 'Orders' })).body.id as string;
        expect((await call('POST', `/flows/${orders}/deploy`)).status).toBe(200);
        await app.gitPoller.poll(id);

        const slug = slugOf(id);
        const at = (path: string) => `${slug}/${path}`;
        const branch = `users/${(await call('GET', '/me')).body.handle as string}/work`;
        const show = (ref: string, path: string) => git(repo, 'show', `${ref}:${at(path)}`);
        const changes = async (user: string) =>
            ((await as(user)('GET', '/git/changes')).body.changes as Change[]).map(c => (c.from ? `${c.from} -> ${c.path}` : c.path));
        const label = async (user: string, flowId: string, type: 'start' | 'end') =>
            ((await as(user)('GET', `/flows/${flowId}/draft`)).body.flow.nodes as { type: string; label?: string }[]).find(
                n => n.type === type,
            )?.label;
        /** the flow's draft with its Start relabelled, saved as this user */
        const relabel = async (user: string, flowId: string, text: string) => {
            const draft = (await as(user)('GET', `/flows/${flowId}/draft`)).body;
            draft.flow.nodes = draft.flow.nodes.map((n: { type: string }) => (n.type === 'start' ? { ...n, label: text } : n));
            return as(user)('PUT', `/flows/${flowId}/draft`, { revision: draft.revision, flow: draft.flow });
        };
        const rowsOf = async (name: string) =>
            (
                await db.query<{ path: string }>('SELECT path FROM working_copy WHERE workspace_id = $1 AND branch = $2 ORDER BY path', [
                    id,
                    name,
                ])
            ).map(r => r.path);
        const off = async () => expect((await call('DELETE', '/git')).status).toBe(200);
        const on = async (choice: 'git' | 'server') => {
            expect((await call('PUT', '/git', config)).status).toBe(200);
            const turned = await call('POST', '/git/on', { choice });
            expect(turned.status).toBe(200);
            return turned.body;
        };
        /** a push to the branch from a laptop: the files changed by `edit` in a clone */
        const push = async (ref: string, edit: Record<string, (text: string) => string>, added: Record<string, string> = {}) => {
            const clone = join(dir, `laptop-${crypto.randomUUID()}`);
            git(dir, 'clone', '--quiet', '-c', 'core.autocrlf=false', '--branch', ref, repo, clone);
            for (const [path, change] of Object.entries(edit)) {
                await writeFile(join(clone, at(path)), change(await readFile(join(clone, at(path)), 'utf8')));
            }
            for (const [path, text] of Object.entries(added)) {
                await mkdir(dirname(join(clone, at(path))), { recursive: true });
                await writeFile(join(clone, at(path)), text);
            }
            git(clone, 'add', '-A');
            git(clone, '-c', 'user.name=Someone', '-c', 'user.email=someone@example.com', 'commit', '--quiet', '-m', 'From a laptop');
            git(clone, 'push', '--quiet', 'origin', ref);
            return git(clone, 'rev-parse', 'HEAD');
        };
        return { id, as, call, projectId, orders, repo, branch, at, show, changes, label, relabel, rowsOf, off, on, push };
    }

    beforeAll(async () => {
        db = await openDatabase('memory://');
        dir = await mkdtemp(join(tmpdir(), 'flowtinus-git-off-on-test-'));
        app = createApp(db, 'DEV', keyring, undefined, { git: { clonesDir: join(dir, 'clones') } });
    });

    afterAll(async () => {
        await db.close();
        await rm(dir, { recursive: true, force: true });
    });

    test("off: dev's working copy is the drafts, Deploy deploys; the work branch's changes stay hidden, and show again once on", async () => {
        const { as, call, projectId, orders, branch, at, show, changes, label, relabel, rowsOf, off, on } = await workspace();
        expect((await call('POST', '/git/branches', { name: branch })).status).toBe(201);
        expect((await relabel(ANA, orders, 'Ana on the branch')).status).toBe(200);
        const restock = (await call('POST', `/projects/${projectId}/flows`, { name: 'Restock' })).body.id as string;
        expect((await relabel(BIA, orders, 'Bia on dev')).status).toBe(200);
        const onBranch = [at('projects/Sales/flows/Orders.flow.yaml'), at('projects/Sales/flows/Restock.flow.yaml')];
        expect(await changes(ANA)).toEqual(onBranch);

        await off();
        // no branch any more: everyone edits the drafts, which are dev's working copy
        expect((await call('GET', '/git/current-branch')).body).toEqual({ branch: null, editable: true });
        expect(await label(ANA, orders, 'start')).toBe('Bia on dev');
        expect((await call('GET', `/flows/${restock}`)).status).toBe(404);
        expect((await call('GET', '/git/branches')).status).toBe(409);
        expect(await rowsOf(branch)).toEqual(onBranch);
        // the Deploy button is a deploy again: a version, no commit
        const deployed = await call('POST', `/flows/${orders}/deploy`);
        expect(deployed.status).toBe(200);
        expect(deployed.body.versions[0]).toMatchObject({ number: 2, commit: null });

        expect(await on('server')).toMatchObject({ outcome: 'server-replaced-git' });
        expect(show('dev', 'projects/Sales/flows/Orders.flow.yaml')).toContain('label: Bia on dev');
        // Ana is back on her branch at once, no poll in between, with its changes as she left them
        expect((await call('GET', '/git/current-branch')).body).toEqual({ branch, editable: true });
        expect(await label(ANA, orders, 'start')).toBe('Ana on the branch');
        expect((await call('GET', `/flows/${restock}`)).body).toMatchObject({ name: 'Restock' });
        expect(await changes(ANA)).toEqual(onBranch);
        const listed = (await call('GET', '/git/branches')).body.branches as { name: string; changes: number }[];
        expect(listed.find(b => b.name === branch)?.changes).toBe(2);
        // Bia, on dev, does not see them
        expect(await label(BIA, orders, 'start')).toBe('Bia on dev');
        expect((await as(BIA)('GET', `/flows/${restock}`)).status).toBe(404);

        expect((await commitAll(call, 'Kept through git off')).status).toBe(200);
        expect(show(branch, 'projects/Sales/flows/Orders.flow.yaml')).toContain('label: Ana on the branch');
        expect(show(branch, 'projects/Sales/flows/Restock.flow.yaml')).toContain(`id: ${restock}`);
        expect(await changes(ANA)).toEqual([]);
    });

    test('a push to the branch while git is off: once on, the branch is read at its new tip, its changes kept over it', async () => {
        const { call, projectId, orders, branch, at, changes, label, relabel, rowsOf, off, on, push } = await workspace();
        expect((await call('POST', '/git/branches', { name: branch })).status).toBe(201);
        expect((await relabel(ANA, orders, 'Ana on the branch')).status).toBe(200);

        await off();
        await push(branch, {}, { 'projects/Sales/scripts/laptop.ts': 'export const fromLaptop = 1;\n' });
        expect(await rowsOf(branch)).toEqual([at('projects/Sales/flows/Orders.flow.yaml')]);

        await on('git');
        expect((await call('GET', `/projects/${projectId}/scripts`)).body.scripts.map((s: { path: string }) => s.path)).toEqual(['laptop']);
        expect(await label(ANA, orders, 'start')).toBe('Ana on the branch');
        expect(await changes(ANA)).toEqual([at('projects/Sales/flows/Orders.flow.yaml')]);
    });

    // needs #57 (the three-way merge when any branch moves): today the row is shown over the new tip as it was, and a
    // Commit refuses the file as "changed on the branch meanwhile"
    test.todo('a push to the same flow while git is off: once on, the change is merged three ways with the branch', async () => {
        const { call, orders, branch, at, show, changes, label, relabel, off, on, push } = await workspace();
        expect((await call('POST', '/git/branches', { name: branch })).status).toBe(201);
        expect((await relabel(ANA, orders, 'Ana on the branch')).status).toBe(200);

        await off();
        await push(branch, {
            'projects/Sales/flows/Orders.flow.yaml': text => text.replace('    type: end\n', '    type: end\n    label: From a laptop\n'),
        });

        await on('git');
        expect(await label(ANA, orders, 'start')).toBe('Ana on the branch');
        expect(await label(ANA, orders, 'end')).toBe('From a laptop');
        expect(await changes(ANA)).toEqual([at('projects/Sales/flows/Orders.flow.yaml')]);
        expect((await commitAll(call, 'Merged after git off')).status).toBe(200);
        const file = show(branch, 'projects/Sales/flows/Orders.flow.yaml');
        expect(file).toContain('label: Ana on the branch');
        expect(file).toContain('label: From a laptop');
    });
});
