import { expect, test } from 'bun:test';
import { fileNameIssue, NAME_MAX, pathCaseClash, projectRepoPaths, REPO_PATH_MAX, repoPathIssue, scriptPathIssue, validateName, validateProfile, type TreeContents } from '../../src/index';

test('a name is trimmed, required and stored in NFC', () => {
    expect(validateName('  Import  ', [])).toEqual({ value: 'Import' });
    expect(validateName('   ', []).error).toBe('Required');
    const nfd = 'Café';
    expect(validateName(nfd, []).value).toBe('Café');
    expect(validateName(nfd, []).value).toBe('Café');
});

test(`a name has at most ${NAME_MAX} characters, counted in NFC`, () => {
    expect(validateName('x'.repeat(NAME_MAX), []).error).toBeUndefined();
    expect(validateName('x'.repeat(NAME_MAX + 1), []).error).toBe(`At most ${NAME_MAX} characters`);
    expect(validateName('é'.repeat(NAME_MAX), []).error).toBeUndefined();
});

test('none of \\ / : * ? " < > |', () => {
    for (const c of ['\\', '/', ':', '*', '?', '"', '<', '>', '|']) {
        expect(fileNameIssue(`a${c}b`)).toBe('None of \\ / : * ? " < > |');
    }
    expect(fileNameIssue('Load orders (v2) – é ñ 日本 #1 @x [y] {z} & %')).toBeUndefined();
});

test('no control characters', () => {
    for (const c of ['\u0000', '\t', '\n', '\u001f', '\u007f', '\u0085']) {
        expect(fileNameIssue(`a${c}b`)).toBe('No control characters');
    }
});

test('no space at the start or the end (validateName trims them)', () => {
    expect(fileNameIssue(' a')).toBe('No space at the start or the end');
    expect(fileNameIssue('a ')).toBe('No space at the start or the end');
    expect(fileNameIssue('a b')).toBeUndefined();
});

test('no trailing dot; not . or ..', () => {
    expect(fileNameIssue('report.')).toBe('Not ending in a dot');
    expect(validateName('report. ', []).error).toBe('Not ending in a dot');
    expect(fileNameIssue('.')).toBe('Not "." or ".."');
    expect(fileNameIssue('..')).toBe('Not "." or ".."');
    expect(fileNameIssue('...')).toBe('Not ending in a dot');
    expect(fileNameIssue('.hidden')).toBeUndefined();
    expect(fileNameIssue('v1.2')).toBeUndefined();
});

test('names Windows reserves, in any case, also with an extension', () => {
    for (const name of ['CON', 'prn', 'Aux', 'nul', 'COM1', 'com9', 'LPT1', 'lpt9', 'COM0', 'COM¹', 'CONIN$', 'conout$']) {
        expect(fileNameIssue(name)).toBe(`"${name}" is a name Windows reserves`);
    }
    expect(fileNameIssue('nul.txt')).toBe('"nul" is a name Windows reserves');
    expect(fileNameIssue('Con.flow.yaml')).toBe('"Con" is a name Windows reserves');
    expect(fileNameIssue('nul .txt')).toBe('"nul" is a name Windows reserves');
    for (const name of ['console', 'nullable', 'COM10', 'LPT', 'auxiliary.txt', 'my nul', 'x.nul']) {
        expect(fileNameIssue(name)).toBeUndefined();
    }
});

test('a folder name may not end in .flow.yaml; a flow name may', () => {
    expect(fileNameIssue('orders.flow.yaml', 'folder')).toBe('A folder name cannot end in .flow.yaml');
    expect(fileNameIssue('orders.FLOW.YAML', 'folder')).toBe('A folder name cannot end in .flow.yaml');
    expect(fileNameIssue('orders.flow.yaml', 'flow')).toBeUndefined();
    expect(fileNameIssue('orders.flow', 'folder')).toBeUndefined();
});

test('unique among siblings whatever the case and after NFC normalization', () => {
    expect(validateName('IMPORT', [{ name: 'import' }]).error).toBe('Already in use');
    expect(validateName('Café', [{ name: 'Café' }]).error).toBe('Already in use');
    expect(validateName('CAFÉ', [{ name: 'café' }]).error).toBe('Already in use');
    expect(validateName('Cafe', [{ name: 'Café' }]).error).toBeUndefined();
});

test('a connection name follows the same rule', () => {
    const profile = (name: string) =>
        validateProfile({ name, type: 'http-client', config: {} }, [{ id: 'c1', name: 'Orders API' }], []).errors.name;
    expect(profile('orders api')).toBe('Already in use');
    expect(profile('a/b')).toBe('None of \\ / : * ? " < > |');
    expect(profile('PRN')).toBe('"PRN" is a name Windows reserves');
});

test('each segment of a script path follows the rule too', () => {
    expect(scriptPathIssue('upload/nul')).toBe('"nul": "nul" is a name Windows reserves.');
    expect(scriptPathIssue('COM1/types')).toBe('"COM1": "COM1" is a name Windows reserves.');
    expect(scriptPathIssue(`a/${'x'.repeat(NAME_MAX + 1)}`)).toBe(`"${'x'.repeat(NAME_MAX + 1)}": At most ${NAME_MAX} characters.`);
    expect(scriptPathIssue('upload/console')).toBeNull();
});

test('a script path whose folders or name differ only in case or normalization from another is refused', () => {
    const existing = ['upload/types', 'upload/client', 'Café'];
    expect(pathCaseClash('Upload/headers', existing)).toBe('"Upload" differs only in case from "upload"');
    expect(pathCaseClash('upload/Types', existing)).toBe('"upload/Types" differs only in case from "upload/types"');
    expect(pathCaseClash('Café/x', existing)).toBe('"Café" differs only in case from "Café"');
    expect(pathCaseClash('upload/headers', existing)).toBeUndefined();
    expect(pathCaseClash('uploads/types', existing)).toBeUndefined();
});

const tree = (flowName: string, folderNames: string[]): TreeContents => ({
    folders: folderNames.map((name, i) => ({ id: `d${i}`, parentId: i === 0 ? null : `d${i - 1}`, name, archivedAt: null })),
    flows: [{ id: 'f', folderId: folderNames.length ? `d${folderNames.length - 1}` : null, name: flowName, archivedAt: null }],
});

test('every path a project gives in the repo: its file, its flows, empty folders, scripts and empty script folders', () => {
    const contents: TreeContents = {
        folders: [
            { id: 'a', parentId: null, name: 'Sales', archivedAt: null },
            { id: 'b', parentId: 'a', name: 'Empty', archivedAt: null },
            { id: 'c', parentId: null, name: 'Old', archivedAt: new Date() },
        ],
        flows: [
            { id: 'f1', folderId: 'a', name: 'Load', archivedAt: null },
            { id: 'f2', folderId: null, name: 'Gone', archivedAt: new Date() },
            { id: 'f3', folderId: 'c', name: 'In archived', archivedAt: null },
        ],
    };
    expect(projectRepoPaths('acme', 'Orders', contents, { scripts: ['upload/types'], folders: ['upload', 'empty'] })).toEqual([
        'acme/projects/Orders/project.yaml',
        'acme/projects/Orders/flows/Sales/Load.flow.yaml',
        'acme/projects/Orders/flows/Sales/Empty/.gitkeep',
        'acme/projects/Orders/scripts/upload/types.ts',
        'acme/projects/Orders/scripts/empty/.gitkeep',
    ]);
});

test(`the whole path in the repo has at most ${REPO_PATH_MAX} characters`, () => {
    const fits = projectRepoPaths(
        'acme',
        'Orders',
        tree('x'.repeat(REPO_PATH_MAX - 'acme/projects/Orders/flows/'.length - '.flow.yaml'.length), []),
    );
    expect(Math.max(...fits.map(p => p.length))).toBe(REPO_PATH_MAX);
    expect(repoPathIssue(fits)).toBeUndefined();

    const folders = ['Sales department', 'Monthly reports and more', 'Region north east', 'Warehouses of the south'];
    const deep = projectRepoPaths('acme', 'Orders', tree('Load the orders of the day and the week', folders));
    const longest =
        'acme/projects/Orders/flows/Sales department/Monthly reports and more/Region north east/Warehouses of the south/Load the orders of the day and the week.flow.yaml';
    expect(repoPathIssue(deep)).toBe(
        `The path "${longest}" in the repository would have ${longest.length} characters (at most ${REPO_PATH_MAX})`,
    );
});
