import { describe, expect, test } from 'bun:test';
import Ajv from 'ajv';
import { parse } from 'yaml';
import { connectionToYaml, newFlowFile, projectToYaml, REPO_SCHEMAS, repoFlowToYaml, workspaceToYaml, type FlowFile } from '../../src/index';

const ajv = new Ajv({ allErrors: true, strict: true });
const schemaOf = (file: string) => REPO_SCHEMAS.find(s => s.file === file)!;
const valid = (file: string, text: string) => ajv.validate(schemaOf(file).schema, parse(text));

const flow: FlowFile = {
    ...newFlowFile('Load orders', 'f1'),
    nodes: [
        ...newFlowFile('x').nodes,
        {
            id: 'map',
            type: 'mapper',
            label: 'Totals',
            position: { x: 1, y: 2 },
            config: { fields: [] },
            outputKey: 'x',
            override: true,
            disabled: true,
            notes: 'n',
            loop: 'l',
        },
        { id: 'l', type: 'loop', position: { x: 0, y: 0 }, config: {}, size: { width: 10, height: 10 } },
    ],
    groups: [{ id: 'g', title: 'G', color: 'red', position: { x: 0, y: 0 }, size: { width: 1, height: 1 } }],
};

describe('a JSON Schema for each file of the format', () => {
    test('one per file, tied to its file names for an editor', () => {
        expect(REPO_SCHEMAS.map(s => [s.file, s.fileMatch])).toEqual([
            ['flow.schema.json', ['**/*.flow.yaml']],
            ['project.schema.json', ['**/projects/*/project.yaml']],
            ['connection.schema.json', ['**/connections/*.yaml']],
            ['workspace.schema.json', ['**/workspace.yaml']],
        ]);
        for (const { schema } of REPO_SCHEMAS) {
            expect(ajv.validateSchema(schema)).toBe(true);
        }
    });

    test('what the app writes is valid', () => {
        expect(valid('flow.schema.json', repoFlowToYaml(flow))).toBe(true);
        expect(valid('flow.schema.json', repoFlowToYaml(flow, { deployed: false }))).toBe(true);
        expect(valid('project.schema.json', projectToYaml({ id: 'p', description: 'd', icon: 'cart', color: 'red' }))).toBe(true);
        expect(valid('connection.schema.json', connectionToYaml({ id: 'c', type: 'postgresql' }))).toBe(true);
        expect(valid('workspace.schema.json', workspaceToYaml())).toBe(true);
    });

    test('what is not the format is not', () => {
        const text = repoFlowToYaml(flow);
        expect(valid('flow.schema.json', text.replace('id: f1\n', ''))).toBe(false);
        expect(valid('flow.schema.json', text.replace('id: f1\n', 'id: f1\nname: Load orders\n'))).toBe(false);
        expect(valid('flow.schema.json', text.replace('id: f1\n', 'id: f1\ndeployed: maybe\n'))).toBe(false);
        expect(valid('flow.schema.json', text.replace('type: mapper', 'type: no-such-component'))).toBe(false);
        expect(valid('flow.schema.json', text.replace('    notes: n\n', '    pinned: {}\n'))).toBe(false);
        expect(valid('flow.schema.json', text.replace('version: 1', 'version: 2'))).toBe(false);
        expect(valid('project.schema.json', 'description: d\n')).toBe(false);
        expect(valid('connection.schema.json', 'id: c\ntype: oracle\n')).toBe(false);
        expect(valid('connection.schema.json', 'id: c\ntype: postgresql\nhost: db\n')).toBe(false);
        expect(valid('workspace.schema.json', 'format: 2\n')).toBe(false);
    });
});
