import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ANA, insertWorkspace, wsPath } from '../helpers/workspaces';
import { commitAll } from '../helpers/git-repos';
import { Keyring } from '#shared/crypto/keyring';
import { openDatabase, type Database } from '#shared/database/database';
import { createApp } from '../../api/app';

setDefaultTimeout(180_000);

// the GitLab of the Compose profile: `docker compose --profile git up -d gitlab` (its first start takes some minutes)
const GITLAB = process.env.GITLAB_URL ?? `http://localhost:${process.env.GITLAB_PORT ?? '8929'}`;
const ROOT = join(import.meta.dir, '../../..');

async function answers(): Promise<boolean> {
    try {
        const response = await fetch(`${GITLAB}/api/v4/version`, { signal: AbortSignal.timeout(3_000) });
        await response.body?.cancel();
        return response.headers.has('x-gitlab-meta');
    } catch {
        return false;
    }
}

function rootToken(): string | null {
    if (process.env.GITLAB_TOKEN) {
        return process.env.GITLAB_TOKEN;
    }
    const ruby = [
        "user = User.find_by_username('root')",
        "token = user.personal_access_tokens.create!(name: 'flowtinus-smoke', scopes: [:api, :read_repository, :write_repository], expires_at: 1.day.from_now)",
        'puts token.token',
    ].join('; ');
    const made = Bun.spawnSync(['docker', 'compose', '--profile', 'git', 'exec', '-T', 'gitlab', 'gitlab-rails', 'runner', ruby], {
        cwd: ROOT,
        stdout: 'pipe',
        stderr: 'pipe',
    });
    return made.success ? made.stdout.toString().trim().split('\n').at(-1)! : null;
}

const token = (await answers()) ? rootToken() : null;

describe.skipIf(!token)("a work branch's pull request opened as a merge request on a real GitLab", () => {
    let db: Database;
    let dir: string;
    let app: ReturnType<typeof createApp>;
    let projectId: number | null = null;
    const keyring = new Keyring([{ version: 't', key: new Uint8Array(32).fill(7) }]);

    const api = async (method: string, path: string, body?: unknown) => {
        const response = await fetch(`${GITLAB}/api/v4${path}`, {
            method,
            headers: { 'private-token': token!, 'content-type': 'application/json' },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        return (await response.json()) as any;
    };

    beforeAll(async () => {
        db = await openDatabase('memory://');
        dir = await mkdtemp(join(tmpdir(), 'flowtinus-gitlab-smoke-'));
        app = createApp(db, 'DEV', keyring, undefined, { git: { clonesDir: join(dir, 'clones') } });
    });

    afterAll(async () => {
        if (projectId !== null) {
            await api('DELETE', `/projects/${projectId}`);
        }
        await db?.close();
        await rm(dir, { recursive: true, force: true });
    });

    test('opens one merge request with the title given and the source branch removed on merge', async () => {
        const project = await api('POST', '/projects', { name: `flowtinus-smoke-${crypto.randomUUID().slice(0, 8)}` });
        projectId = project.id;

        const id = crypto.randomUUID();
        await insertWorkspace(db, id);
        const call = async (method: string, path: string, body?: unknown) => {
            const response = await app.request(wsPath(id, path), {
                method,
                headers: { 'x-user-id': ANA, 'content-type': 'application/json' },
                body: body === undefined ? undefined : JSON.stringify(body),
            });
            return { status: response.status, body: (await response.json()) as any };
        };
        await call('POST', '/secrets', { name: 'git-token', value: token });
        const repository = `${GITLAB}/${project.path_with_namespace}.git`;
        expect((await call('PUT', '/git', { repository, tokenSecret: 'git-token', environment: 'DEV' })).status).toBe(200);
        expect((await call('POST', '/git/topology', { confirm: true })).status).toBe(201);
        expect((await call('POST', '/git/on', { createBranch: true })).status).toBe(200);
        expect((await call('GET', '/git')).body.adapter).toEqual({ provider: 'gitlab', on: true });

        const handle = (await call('GET', '/me')).body.handle as string;
        const branch = `users/${handle}/smoke`;
        expect((await call('POST', '/git/branches', { name: branch })).status).toBe(201);
        const projectInApp = (await call('POST', '/projects', { name: 'Sales' })).body.id as string;
        expect((await call('POST', `/projects/${projectInApp}/flows`, { name: 'Refunds' })).status).toBe(201);
        expect((await commitAll(call, 'add Refunds')).status).toBe(200);

        const opened = await call('POST', '/git/pull-request', { title: 'Smoke: refunds' });
        expect(opened.status).toBe(200);
        expect(opened.body.notice).toBeUndefined();
        const { number, url } = opened.body.mergeRequest;
        const mr = await api('GET', `/projects/${project.id}/merge_requests/${number}`);
        expect(mr).toMatchObject({
            web_url: url,
            title: 'Smoke: refunds',
            source_branch: branch,
            target_branch: 'dev',
            state: 'opened',
            force_remove_source_branch: true,
        });
        expect(mr.description).toEndWith('Opened from Flowtinus by Ana.');

        const again = await call('POST', '/git/pull-request', {});
        expect(again.body.mergeRequest.number).toBe(number);
    });
});
