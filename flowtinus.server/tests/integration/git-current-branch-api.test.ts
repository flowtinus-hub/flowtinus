import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Keyring } from '#shared/crypto/keyring';
import { openDatabase, type Database } from '#shared/database/database';
import { createApp } from '../../api/app';
import { createBranch, git } from '../helpers/git-repos';
import { ANA, BIA, insertWorkspace, wsPath } from '../helpers/workspaces';

setDefaultTimeout(30_000);

describe("user handles, and each user's current branch", () => {
    let db: Database;
    let app: ReturnType<typeof createApp>;
    let dir: string;
    const keyring = new Keyring([{ version: 't', key: new Uint8Array(32).fill(7) }]);

    const request = async (method: string, path: string, user: string, body?: unknown) => {
        const response = await app.request(path, {
            method,
            headers: { 'x-user-id': user, 'content-type': 'application/json' },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        return { status: response.status, body: (await response.json()) as any };
    };

    async function newUser(email: string): Promise<string> {
        const id = crypto.randomUUID();
        await db.query('INSERT INTO users (id, name, email) VALUES ($1, $2, $3)', [id, email, email]);
        return id;
    }

    const handleOf = async (user: string) => (await request('GET', '/me', user)).body.handle as string;

    async function newWorkspace(options: { git?: boolean } = {}) {
        const id = crypto.randomUUID();
        await insertWorkspace(db, id);
        const call = (method: string, path: string, user = ANA, body?: unknown) => request(method, wsPath(id, path), user, body);
        if (options.git !== false) {
            const repo = join(dir, `${id}.git`);
            git(dir, 'init', '--bare', '--quiet', '--initial-branch=main', repo);
            createBranch(repo, 'dev');
            await call('POST', '/secrets', ANA, { name: 'git-token', value: 'tok3n' });
            await call('PUT', '/git', ANA, { repository: pathToFileURL(repo).href, tokenSecret: 'git-token', environment: 'DEV' });
            expect((await call('POST', '/git/topology', ANA, { confirm: true })).status).toBe(201);
            expect((await call('POST', '/git/on', ANA, { createBranch: true })).status).toBe(200);
        }
        const currentBranch = async (user: string) => (await call('GET', '/git/current-branch', user)).body;
        const pick = (user: string, branch: string) => call('PUT', '/git/current-branch', user, { branch });
        return { currentBranch, pick };
    }

    beforeAll(async () => {
        db = await openDatabase('memory://');
        dir = await mkdtemp(join(tmpdir(), 'flowtinus-current-branch-test-'));
        app = createApp(db, 'DEV', keyring, undefined, { git: { clonesDir: join(dir, 'clones') } });
    });

    afterAll(async () => {
        await db.close();
        await rm(dir, { recursive: true, force: true });
    });

    test('a handle is the email without accents, its local part and its domain without the last label, other characters as one _', async () => {
        expect(await handleOf(await newUser('Ana.Souza@example.com'))).toBe('ana_souza_example');
        expect(await handleOf(await newUser('bia@mail.corp.com'))).toBe('bia_mail_corp');
        expect(await handleOf(await newUser('"cris ++ lima"@example.com'))).toBe('cris_lima_example');
        expect(await handleOf(await newUser('dan~1^x:y?z*[w\\@example.com'))).toBe('dan_1_x_y_z_w_example');
        expect(await handleOf(await newUser('Élodie.ÇA@localhost'))).toBe('elodie_ca');
    });

    test('a taken handle gets a number; handles never repeat', async () => {
        expect(await handleOf(await newUser('joao_omc@gmail.com'))).toBe('joao_omc_gmail');
        expect(await handleOf(await newUser('joão.omc@gmail.com'))).toBe('joao_omc_gmail2');
        expect(await handleOf(await newUser('joao+omc@gmail.com'))).toBe('joao_omc_gmail3');
    });

    test('a handle never changes, even when the email does', async () => {
        const user = await newUser('hugo@example.com');
        await db.query("UPDATE users SET email = 'hugo.new@example.com', handle = 'other' WHERE id = $1", [user]);
        expect(await handleOf(user)).toBe('hugo_example');
        expect(await handleOf(await newUser('hugo-@example.com'))).toBe('hugo_example2');
    });

    test("each user's current branch is kept per workspace; absent, it is the environment's branch", async () => {
        const one = await newWorkspace();
        const two = await newWorkspace();
        expect(await one.currentBranch(ANA)).toEqual({ branch: 'dev', editable: true });

        expect((await one.pick(ANA, 'users/ana/orders')).body).toEqual({ branch: 'users/ana/orders', editable: false });
        expect(await one.currentBranch(ANA)).toEqual({ branch: 'users/ana/orders', editable: false });
        expect(await one.currentBranch(BIA)).toEqual({ branch: 'dev', editable: true });
        expect(await two.currentBranch(ANA)).toEqual({ branch: 'dev', editable: true });

        await one.pick(BIA, 'feature/shared');
        expect(await one.currentBranch(BIA)).toEqual({ branch: 'feature/shared', editable: true });
        expect(await one.currentBranch(ANA)).toEqual({ branch: 'users/ana/orders', editable: false });

        await one.pick(ANA, 'dev');
        expect(await one.currentBranch(ANA)).toEqual({ branch: 'dev', editable: true });
    });

    test('a name git cannot take as a branch is refused', async () => {
        const { pick, currentBranch } = await newWorkspace();
        for (const branch of ['', 'has space', 'a..b', 'end/', '-dash', 'users/x.lock', 'a@{b', 'x:y', 'HEAD']) {
            expect((await pick(ANA, branch)).status).toBe(400);
        }
        expect(await currentBranch(ANA)).toEqual({ branch: 'dev', editable: true });
    });

    test('with git off there is no current branch, and none can be set', async () => {
        const { pick, currentBranch } = await newWorkspace({ git: false });
        expect(await currentBranch(ANA)).toEqual({ branch: null, editable: true });
        expect((await pick(ANA, 'users/ana/orders')).status).toBe(409);
    });
});
