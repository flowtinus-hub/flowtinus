import { END, START } from '#engine/constants';
import { COMPONENTS } from '../components';
import { CONNECTION_TYPES } from '../connections/types/connection-types';
import { FLOW_FILE_VERSION } from '../flows/flow-file';
import { REPO_FORMAT, REPO_ID } from './repo-files';

export type JsonSchema = Record<string, unknown>;

export type RepoSchema = { file: string; fileMatch: string[]; schema: JsonSchema };

export const REPO_SCHEMA_BASE_URL = 'https://raw.githubusercontent.com/flowtinus-hub/flowtinus/main/docs/schemas/';

const id = {
    type: 'string',
    pattern: REPO_ID.source,
    description: 'the identity, a UUID in lower case: stays the same across renames and moves',
};
const text = { type: 'string' };
const point = {
    type: 'object',
    required: ['x', 'y'],
    additionalProperties: false,
    properties: { x: { type: 'number' }, y: { type: 'number' } },
};
const size = {
    type: 'object',
    required: ['width', 'height'],
    additionalProperties: false,
    properties: { width: { type: 'number' }, height: { type: 'number' } },
};

const flowSchema: JsonSchema = {
    title: 'Flowtinus flow',
    description: 'A flow; its name is the file name, without .flow.yaml.',
    type: 'object',
    required: ['version', 'id', 'nodes', 'edges'],
    additionalProperties: false,
    properties: {
        version: { const: FLOW_FILE_VERSION },
        id,
        deployed: { type: 'boolean', description: 'false: the flow is not deployed (absent means true)' },
        nodes: {
            type: 'array',
            items: {
                type: 'object',
                required: ['id', 'type', 'position'],
                additionalProperties: false,
                properties: {
                    id: { type: 'string', minLength: 1 },
                    type: { enum: [...new Set([START, END, ...Object.keys(COMPONENTS)])].sort() },
                    label: text,
                    position: point,
                    config: { type: 'object', description: "the component's settings" },
                    outputKey: text,
                    override: { type: 'boolean' },
                    disabled: { type: 'boolean' },
                    notes: { type: 'string', description: 'free text for people (what a comment would say)' },
                    loop: { type: 'string', minLength: 1, description: 'the Loop whose loop region holds it directly' },
                    size: { ...size, description: "a Loop's: its Loop end card, as an offset from the Loop card" },
                },
            },
        },
        edges: {
            type: 'array',
            items: {
                type: 'object',
                required: ['source', 'sourcePort', 'target', 'targetPort'],
                additionalProperties: false,
                properties: { source: text, sourcePort: text, target: text, targetPort: text },
            },
        },
        groups: {
            type: 'array',
            items: {
                type: 'object',
                required: ['id', 'position', 'size'],
                additionalProperties: false,
                properties: { id: text, title: text, color: text, position: point, size },
            },
        },
    },
};

const projectSchema: JsonSchema = {
    title: 'Flowtinus project',
    description: "A project; its name is its folder's.",
    type: 'object',
    required: ['id'],
    additionalProperties: false,
    properties: { id, description: text, icon: text, color: text },
};

const connectionSchema: JsonSchema = {
    title: 'Flowtinus connection',
    description: 'A connection declared; its name is the file name. Its configuration and credentials stay on each server.',
    type: 'object',
    required: ['id', 'type'],
    additionalProperties: false,
    properties: { id, type: { enum: CONNECTION_TYPES.map(t => t.type) } },
};

const workspaceSchema: JsonSchema = {
    title: 'Flowtinus workspace',
    description: "A workspace; its name is its folder's.",
    type: 'object',
    required: ['format'],
    additionalProperties: false,
    properties: { format: { const: REPO_FORMAT, description: 'the version of the repository format' } },
};

const published = (file: string, fileMatch: string[], schema: JsonSchema): RepoSchema => ({
    file,
    fileMatch,
    schema: { $schema: 'http://json-schema.org/draft-07/schema#', $id: `${REPO_SCHEMA_BASE_URL}${file}`, ...schema },
});

export const REPO_SCHEMAS: RepoSchema[] = [
    published('flow.schema.json', ['**/*.flow.yaml'], flowSchema),
    published('project.schema.json', ['**/projects/*/project.yaml'], projectSchema),
    published('connection.schema.json', ['**/connections/*.yaml'], connectionSchema),
    published('workspace.schema.json', ['**/workspace.yaml'], workspaceSchema),
];
