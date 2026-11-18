import { describe, expect, test } from 'bun:test';
import { connectionFromYaml, connectionToYaml, projectFromYaml, projectToYaml, workspaceFromYaml, workspaceToYaml } from '../../src/index';

describe('project.yaml', () => {
    test('id, description, icon, color, in that order; an empty description is left out', () => {
        expect(projectToYaml({ color: 'green', icon: 'cart', description: 'The ERP: orders', id: 'p1' })).toBe(
            'id: p1\ndescription: "The ERP: orders"\nicon: cart\ncolor: green\n',
        );
        expect(projectToYaml({ id: 'p1', description: '', icon: 'folder', color: 'blue' })).toBe('id: p1\nicon: folder\ncolor: blue\n');
    });

    test('read in any order; only the id is required', () => {
        expect(projectFromYaml('color: green\r\nicon: cart\r\nid: p1\r\ndescription: The ERP\r\n')).toEqual({
            ok: true,
            value: { id: 'p1', description: 'The ERP', icon: 'cart', color: 'green' },
        });
        expect(projectFromYaml('{ id: p1 }')).toEqual({ ok: true, value: { id: 'p1', description: '' } });
    });

    test('refused: no id, a field that is not text, not YAML', () => {
        expect(projectFromYaml('description: x\n')).toMatchObject({
            ok: false,
            errors: [expect.stringMatching(/^The project has no id: add one, such as "id: [0-9a-f-]{36}"\.$/)],
        });
        expect(projectFromYaml('id: p1\nicon: [a]\n')).toEqual({ ok: false, errors: ['"icon" is a text.'] });
        expect(projectFromYaml('id: [')).toMatchObject({ ok: false, errors: [expect.stringContaining('Not valid YAML')] });
        expect(projectFromYaml('- a')).toEqual({ ok: false, errors: ['Not a project file.'] });
    });
});

describe('a connection declaration', () => {
    test('only its id and type (the name is in the path; configuration and credentials stay on the server)', () => {
        expect(connectionToYaml({ type: 'postgresql', id: 'c1' })).toBe('id: c1\ntype: postgresql\n');
        expect(connectionFromYaml('type: postgresql\nid: c1\n')).toEqual({ ok: true, value: { id: 'c1', type: 'postgresql' } });
    });

    test('refused: no id, a type the app does not have', () => {
        expect(connectionFromYaml('type: postgresql\n')).toMatchObject({
            ok: false,
            errors: [expect.stringMatching(/^The connection has no id/)],
        });
        expect(connectionFromYaml('id: c1\ntype: oracle\n')).toEqual({ ok: false, errors: ['Unknown connection type "oracle".'] });
        expect(connectionFromYaml('id: c1\n')).toEqual({ ok: false, errors: ['Unknown connection type undefined.'] });
    });
});

describe('workspace.yaml', () => {
    test('holds the format version', () => {
        expect(workspaceToYaml()).toBe('format: 1\n');
        expect(workspaceFromYaml('format: 1\n')).toEqual({ ok: true, value: { format: 1 } });
    });

    test('refused: another format', () => {
        expect(workspaceFromYaml('format: 2\n')).toEqual({ ok: false, errors: ['Unknown format 2 (this app reads 1).'] });
        expect(workspaceFromYaml('')).toEqual({ ok: false, errors: ['Unknown format undefined (this app reads 1).'] });
    });
});
