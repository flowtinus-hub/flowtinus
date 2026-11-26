import { validateWorkspaceTree, type TreeIssue } from '@flowtinus/core';
import { NO_WORKSPACE, plural, report, repositoryArgs, type Command } from '../command';

const USAGE = "Usage: flowtinus validate [dir] [--strict]\n  dir: the repository's root, the current folder by default";

// a repository-wide issue (a missing .gitattributes) comes from every workspace: once is enough
const unique = (issues: TreeIssue[]) => [...new Map(issues.map(i => [`${i.path}\0${i.message}`, i])).values()];

export const run: Command = async (args, cwd) => {
    const parsed = repositoryArgs('validate', USAGE, args, cwd, { strict: { type: 'boolean' } });
    if (parsed.usage) {
        return parsed.usage;
    }
    const { files, workspaces } = parsed.repository;
    const results = workspaces.map(workspace => validateWorkspaceTree({ workspace, files }));
    const errors = unique(results.flatMap(r => r.errors));
    const warnings = unique(results.flatMap(r => r.warnings));
    if (workspaces.length === 0) {
        errors.push(NO_WORKSPACE);
    }
    const lines = [...errors.map(i => `${i.path}: error: ${i.message}`), ...warnings.map(i => `${i.path}: warning: ${i.message}`)];
    const count =
        errors.length || warnings.length
            ? `${plural(errors.length, 'error')}, ${plural(warnings.length, 'warning')}.`
            : 'No errors, no warnings.';
    return report(errors.length > 0 || (parsed.values.strict === true && warnings.length > 0) ? 1 : 0, lines, count);
};
