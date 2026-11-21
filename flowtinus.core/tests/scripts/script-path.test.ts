import { expect, test } from 'bun:test';
import { movedScriptPath, normalizeScriptPath, scriptAddress, scriptImport, scriptImportOfModule, scriptImportPrefix, scriptImports, scriptModuleUri, scriptPathIssue } from '../../src/index';

test('a script path: folders and a name, each letters, numbers, - and _', () => {
    for (const ok of ['types', 'upload/types', 'apis/assets/client-v2', 'a_b/C9']) {
        expect(scriptPathIssue(ok)).toBeNull();
    }
    expect(scriptPathIssue('')).toBe('The path is empty.');
    expect(scriptPathIssue('upload//types')).toBe('The path has an empty folder (two slashes together).');
    expect(scriptPathIssue('upload/my types')).toContain('"my types" is not a valid name');
    expect(scriptPathIssue('-x')).toContain('starting with a letter or a number');
    expect(scriptPathIssue('a/../b')).toContain('".." is not a valid name');
    expect(scriptPathIssue('x'.repeat(201))).toContain('longer than 200');
});

test('what is typed becomes the path: no slashes at the ends, no .ts, forward slashes', () => {
    expect(normalizeScriptPath('  /upload\\types.ts/ ')).toBe('upload/types');
});

test('the import path of a script names its workspace and its project; the module is where Monaco keeps it', () => {
    expect(scriptImport('acme', 'billing', 'upload/types')).toBe('@w/acme/billing/scripts/upload/types');
    expect(scriptImportPrefix('acme', 'billing')).toBe('@w/acme/billing/scripts/');
    expect(scriptAddress('@w/acme/billing/scripts/upload/types')).toEqual({ workspace: 'acme', project: 'billing', path: 'upload/types' });
    for (const notOne of ['@w/acme/billing/upload/types', '@w/acme/scripts/x', '@w/acme/billing/scripts/', '@myproject/scripts/x', './x']) {
        expect(scriptAddress(notOne)).toBeNull();
    }
    expect(scriptModuleUri('@w/acme/billing/scripts/upload/types')).toBe('file:///w/acme/billing/scripts/upload/types.ts');
    expect(scriptImportOfModule('file:///w/acme/billing/scripts/upload/types.ts')).toBe('@w/acme/billing/scripts/upload/types');
    expect(scriptImportOfModule('file:///component.ts')).toBeNull();
});

test('the scripts some code imports, of any project and any workspace, by import path', () => {
    const code = `import {type A} from '@w/acme/billing/scripts/upload/types';
import * as c from "@w/acme/shared/scripts/apis/client";
import '@w/other/tools/scripts/setup';
const later = await import('@w/acme/billing/scripts/upload/types');
import {x} from './not-a-script';
import {y} from '@myproject/scripts/old';`;
    expect(scriptImports(code)).toEqual([
        '@w/acme/billing/scripts/upload/types',
        '@w/acme/shared/scripts/apis/client',
        '@w/other/tools/scripts/setup',
    ]);
});

test('a rename or a move of a folder takes what is inside it', () => {
    expect(movedScriptPath('upload/types', 'upload', 'files/upload')).toBe('files/upload/types');
    expect(movedScriptPath('upload', 'upload', 'transfer')).toBe('transfer');
    expect(movedScriptPath('uploads/types', 'upload', 'x')).toBe('uploads/types');
});

test('what a script exports (to offer it for import), and the import line', async () => {
    const { scriptExports, scriptImportLine } = await import('../../src/index');
    const code = `export interface IUploadInitResponse { file: string }
export type Id = string;
export async function uploadIdOf(r: IUploadInitResponse) { return r.file; }
export const LIMIT = 10;
export class Client {}
function hidden() {}
const a = 1, b = 2;
export { a, b as bee };
export type { Other } from './elsewhere';`;
    expect(scriptExports(code)).toEqual([
        { name: 'IUploadInitResponse', typeOnly: true },
        { name: 'Id', typeOnly: true },
        { name: 'uploadIdOf', typeOnly: false, function: true },
        { name: 'LIMIT', typeOnly: false },
        { name: 'Client', typeOnly: false },
        { name: 'a', typeOnly: false },
        { name: 'bee', typeOnly: false },
    ]);
    expect(scriptImportLine('@w/acme/billing/scripts/upload/types', 'IUploadInitResponse', true)).toBe(
        "import type { IUploadInitResponse } from '@w/acme/billing/scripts/upload/types';",
    );
    expect(scriptImportLine('@w/acme/billing/scripts/upload/types', 'uploadIdOf', false)).toBe(
        "import { uploadIdOf } from '@w/acme/billing/scripts/upload/types';",
    );
});

test('the names some code already has (imported or declared): another import of one would clash', async () => {
    const { boundNames } = await import('../../src/index');
    const code = `import type { IUploadInitResponse, Other as Renamed } from '@w/acme/billing/scripts/upload/types';
import Default, * as All from '@w/acme/billing/scripts/x';
import { type Kind } from '@w/acme/billing/scripts/kinds';
interface Local {}
const limit = 1;
async function process($input: Data) { return null; }`;
    const names = boundNames(code);
    for (const name of ['IUploadInitResponse', 'Renamed', 'Default', 'All', 'Kind', 'Local', 'limit', 'process']) {
        expect(names.has(name)).toBe(true);
    }
    expect(names.has('Other')).toBe(false);
    expect(names.has('IItem')).toBe(false);
});

test('a script is at most 1 MB', async () => {
    const { MAX_SCRIPT_BYTES, scriptContentIssue } = await import('../../src/index');
    expect(scriptContentIssue('export const a = 1;')).toBeNull();
    expect(scriptContentIssue('x'.repeat(MAX_SCRIPT_BYTES))).toBeNull();
    expect(scriptContentIssue('é'.repeat(MAX_SCRIPT_BYTES / 2 + 1))).toBe('The script takes 1.0 MB (at most 1 MB).');
});

test('the scripts some code needs, across projects: what it imports and, through them, what they import; what is missing and who wants it', async () => {
    const { scriptClosure } = await import('../../src/index');
    const billing = (path: string) => `@w/acme/billing/scripts/${path}`;
    const shared = (path: string) => `@w/acme/shared/scripts/${path}`;
    const scripts = {
        [shared('upload/types')]: `export interface A {}`,
        [billing('upload/headers')]: `import type { A } from '${shared('upload/types')}';\nimport { x } from '${shared('gone')}';`,
        [billing('loop/a')]: `import '${shared('loop/b')}';`,
        [shared('loop/b')]: `import '${billing('loop/a')}';`,
        [shared('unused/big')]: `export const big = 1;`,
    };
    const code = [
        `import { h } from '${billing('upload/headers')}';`,
        `import '${billing('loop/a')}';`,
        `import '${billing('nope')}';`,
        `import '@w/acme/archived/scripts/x';`,
        `import '@w/other/billing/scripts/upload/headers';`,
    ].join('\n');
    expect(scriptClosure(code, scripts)).toEqual({
        paths: [billing('loop/a'), billing('upload/headers'), shared('loop/b'), shared('upload/types')],
        missing: [
            { from: billing('upload/headers'), path: shared('gone') },
            { from: null, path: billing('nope') },
            { from: null, path: '@w/acme/archived/scripts/x' },
            { from: null, path: '@w/other/billing/scripts/upload/headers' },
        ],
    });
    expect(scriptClosure('async function process() {}', scripts)).toEqual({ paths: [], missing: [] });
});
