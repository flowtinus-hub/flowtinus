import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { appKeyring } from '#shared/config/app-keyring';
import { readAppSettings } from '#shared/config/app-settings';

describe('LOCAL_REPO', () => {
    let dir: string;
    let clone: string;

    beforeAll(async () => {
        dir = await mkdtemp(join(tmpdir(), 'flowtinus-local-'));
        clone = join(dir, 'flows');
        await mkdir(join(clone, '.git'), { recursive: true });
    });
    afterAll(() => rm(dir, { recursive: true, force: true }));

    test('makes the server local: the LOCAL environment, the clone it reads, the editor on its DEV address', () => {
        const settings = readAppSettings({ LOCAL_REPO: clone, ENVIRONMENT: 'PROD' });
        expect(settings.environment).toBe('LOCAL');
        expect(settings.localRepo).toBe(resolve(clone));
        expect(settings.editorUrl).toBe('http://localhost:5180');
    });

    test('without it, nothing changes', () => {
        const settings = readAppSettings({ ENVIRONMENT: 'PROD' });
        expect(settings.environment).toBe('PROD');
        expect(settings.localRepo).toBeUndefined();
        expect(readAppSettings({ LOCAL_REPO: ' ' }).localRepo).toBeUndefined();
    });

    test('a folder that is not a clone is refused', () => {
        expect(() => readAppSettings({ LOCAL_REPO: join(dir, 'nowhere') })).toThrow('LOCAL_REPO');
        expect(() => readAppSettings({ LOCAL_REPO: dir })).toThrow('LOCAL_REPO');
    });

    test("a local server takes DEV's fixed key unless SECRETS_KEYS is set", () => {
        const warnings: string[] = [];
        expect(() => appKeyring(readAppSettings({ LOCAL_REPO: clone }), line => warnings.push(line))).not.toThrow();
        expect(warnings).toHaveLength(1);
        expect(() => appKeyring(readAppSettings({ ENVIRONMENT: 'PROD' }))).toThrow('SECRETS_KEYS');
    });
});
