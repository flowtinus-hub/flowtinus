import { resolve } from 'node:path';
import { validateWorkspaceTree, type TreeIssue } from '@flowtinus/core';
import { parseCommandArgs, usageError, type Command } from '../command';
import { readRepository } from '../repository';

const USAGE = 'Usage: flowtinus validate [dir] [--strict]';

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

// a repository-wide issue (a missing .gitattributes) comes from every workspace: once is enough
const unique = (issues: TreeIssue[]) => [...new Map(issues.map(i => [`${i.path}\0${i.message}`, i])).values()];

export const run: Command = async (args, cwd) => {
    const parsed = parseCommandArgs(args, { strict: { type: 'boolean' } });
    if ('error' in parsed) {
        return usageError(parsed.error, USAGE);
    }
    if (parsed.positionals.length > 1) {
        return usageError('validate takes one folder at most.', USAGE);
    }
    const { files, workspaces } = readRepository(resolve(cwd, parsed.positionals[0] ?? '.'));
    const results = workspaces.map(workspace => validateWorkspaceTree({ workspace, files }));
    const errors = unique(results.flatMap(r => r.errors));
    const warnings = unique(results.flatMap(r => r.warnings));
    if (workspaces.length === 0) {
        errors.push({ path: '.', message: 'No workspace here: no folder with a workspace.yaml.' });
    }
    const lines = [...errors.map(i => `${i.path}: error: ${i.message}`), ...warnings.map(i => `${i.path}: warning: ${i.message}`)];
    const count =
        errors.length || warnings.length
            ? `${plural(errors.length, 'error')}, ${plural(warnings.length, 'warning')}.`
            : 'No errors, no warnings.';
    const failed = errors.length > 0 || (parsed.values.strict === true && warnings.length > 0);
    return { code: failed ? 1 : 0, output: [...lines, count, ''].join('\n') };
};
