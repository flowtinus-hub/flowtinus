// PROTOTYPE (#86): the docs an agent reads before it edits a flows repository (Copilot, Claude Code, Cursor...), from the
// CLI it already uses for new, fmt and validate, so they match the format this CLI checks. Here they are read from the
// generated docs next to the CLI; a published CLI would carry them.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildCatalog } from '@flowtinus/core';
import { usageError, type Command } from '../command';

const USAGE = 'Usage: flowtinus docs [flow-format | components | component <type> | connections]';

const DOCS = join(import.meta.dir, '..', '..', '..', 'docs');

// the generated pages start with a comment for whoever edits them by hand
const page = (path: string) => readFileSync(join(DOCS, path), 'utf8').replace(/^<!--.*?-->\s*/s, '');

/**
 * The page is the flow file as the editor and the MCP see it; an agent reads it top down, so its shape, rule and example
 * become a repository file's: an `id` instead of the `name`, no `pinned`.
 */
function forRepository(text: string): string {
    return text
        .replace(
            /^(# The flow file\n\n)/m,
            '$1This is the flow file as it is in a repository: it has the `id` (written by `flowtinus new flow`, never changed), no `name` (the file name is the name) and no `pinned` outputs. ',
        )
        .replace(/^name: '.*'$/m, `id: "the flow's id, a UUID in lower case (written by flowtinus new flow; never change it)"`)
        .replace(/^ +pinned: .*\n/m, '')
        .replace('The file has version 1, a name, and nodes', 'The file has version 1, an id, and nodes')
        .replace(/^(version: 1\n)name: .*$/m, '$1id: 0b6f3c1e-2a7d-4f0e-9c4b-5d8e1a2f3b4c');
}

const firstSentence = (text: string) => `${text.split('. ')[0]!.replace(/\.$/, '')}.`;

function index(): string {
    const { components } = buildCatalog();
    return `# Flowtinus, for an agent editing a flows repository

Flowtinus runs data flows: components connected by edges move envelopes (each with a DATA object) from a Start to an
End. In this repository each flow is a file, \`<workspace>/projects/<project>/flows/[<folder>/]<flow name>.flow.yaml\`,
and the developer's git is the only one that commits or pushes.

## How to work

1. Read \`flowtinus docs flow-format\` before writing a flow file, and \`flowtinus docs component <type>\` for each
   component you use (its ports, settings and an example config).
2. A new flow: \`flowtinus new flow <path>.flow.yaml\` writes it with its \`id\`. Never write an \`id\` yourself, never
   change one, and never add a \`name\` key (the file name is the flow's name).
3. A connection or a called flow is named by its \`id\` (the \`id\` in \`connections/<name>.yaml\` or in the other flow's
   file); a script by its import path.
4. After editing: \`flowtinus fmt <the files you changed>\` (the canonical order; without files it formats the whole
   repository, other people's files too) and \`flowtinus validate\`; fix every error it lists and run it again until it
   says no errors.
5. No comments in a flow file: what a comment would say goes in the node's \`notes\`.
6. Positions are the canvas: a node you add goes where no other node is (about 300 to the right of the one before it,
   moving the ones after it further right), never on top of another.

## More

- \`flowtinus docs flow-format\`: the flow file (shape, ports, the Start and the End, on error, expressions, rules,
  patterns, a full example) and the repository's layout
- \`flowtinus docs components\`: every component in one line
- \`flowtinus docs component <type>\`: one component
- \`flowtinus docs connections\`: the connection types

## Components

${components.map(c => `- \`${c.type}\`: ${firstSentence(c.description)}`).join('\n')}
`;
}

export const run: Command = async args => {
    const [what, type, ...extra] = args;
    if (extra.length > 0) {
        return usageError('Too many arguments.', USAGE);
    }
    if (what === undefined) {
        return { code: 0, output: index() };
    }
    if (what === 'flow-format') {
        return { code: 0, output: forRepository(page('flow-format.md')) };
    }
    if (what === 'connections') {
        return { code: 0, output: page('connections.md') };
    }
    if (what === 'components') {
        return { code: 0, output: page('components/README.md') };
    }
    if (what === 'component') {
        const { components } = buildCatalog();
        if (!type || !components.some(c => c.type === type)) {
            return usageError(
                type ? `No component "${type}".` : 'Which component?',
                `Usage: flowtinus docs component <type>\nTypes: ${components.map(c => c.type).join(', ')}`,
            );
        }
        return { code: 0, output: page(`components/${type}.md`) };
    }
    return usageError(`Unknown section "${what}".`, USAGE);
};
