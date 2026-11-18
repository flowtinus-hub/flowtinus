import { expect, test } from 'bun:test';
import { repoEntry, repoPath } from '../../src/index';

test('every file of the layout says what it is and names it by its path', () => {
    expect(repoEntry('.gitattributes')).toEqual({ kind: 'gitattributes' });
    expect(repoEntry('acme/workspace.yaml')).toEqual({ kind: 'workspace', workspace: 'acme' });
    expect(repoEntry('acme/connections/ERP (prod).yaml')).toEqual({ kind: 'connection', workspace: 'acme', name: 'ERP (prod)' });
    expect(repoEntry('acme/projects/Sales/project.yaml')).toEqual({ kind: 'project', workspace: 'acme', project: 'Sales' });
    expect(repoEntry('acme/projects/Sales/flows/Load orders.flow.yaml')).toEqual({
        kind: 'flow',
        workspace: 'acme',
        project: 'Sales',
        folders: [],
        name: 'Load orders',
    });
    expect(repoEntry('acme/projects/Sales/flows/Daily/ERP/Load orders.flow.yaml')).toMatchObject({
        kind: 'flow',
        folders: ['Daily', 'ERP'],
    });
    expect(repoEntry('acme/projects/Sales/flows/Daily/.gitkeep')).toEqual({
        kind: 'folder',
        workspace: 'acme',
        project: 'Sales',
        folders: ['Daily'],
    });
    expect(repoEntry('acme/projects/Sales/scripts/util/dates.ts')).toEqual({
        kind: 'script',
        workspace: 'acme',
        project: 'Sales',
        path: 'util/dates',
    });
    expect(repoEntry('acme/projects/Sales/scripts/util/.gitkeep')).toEqual({
        kind: 'scriptFolder',
        workspace: 'acme',
        project: 'Sales',
        path: 'util',
    });
});

test('anything else is outside the layout', () => {
    for (const path of [
        'README.md',
        'acme/README.md',
        'acme/connections/ERP.json',
        'acme/connections/sub/ERP.yaml',
        'acme/projects/project.yaml',
        'acme/projects/Sales/flows/notes.md',
        'acme/projects/Sales/flows/.flow.yaml',
        'acme/projects/Sales/scripts/dates.js',
        'acme/projects/Sales/other/x.yaml',
    ]) {
        expect([path, repoEntry(path)]).toEqual([path, { kind: 'unknown' }]);
    }
});

test('the paths the app writes are the ones it reads', () => {
    expect(repoEntry(repoPath.workspace('acme'))).toEqual({ kind: 'workspace', workspace: 'acme' });
    expect(repoEntry(repoPath.flow('acme', 'Sales', ['Daily'], 'Load'))).toEqual({
        kind: 'flow',
        workspace: 'acme',
        project: 'Sales',
        folders: ['Daily'],
        name: 'Load',
    });
    expect(repoEntry(repoPath.scriptFolder('acme', 'Sales', 'a/b'))).toMatchObject({ kind: 'scriptFolder', path: 'a/b' });
});
