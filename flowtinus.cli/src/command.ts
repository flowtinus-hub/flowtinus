import { resolve } from 'node:path';
import { parseArgs, type ParseArgsOptionsConfig } from 'node:util';
import { readRepository } from '@flowtinus/core/disk';

export type CommandResult = { code: number; output: string };

export type Command = (args: string[], cwd: string) => Promise<CommandResult>;

export const USAGE_ERROR = 2;

export const NO_WORKSPACE = { path: '.', message: 'No workspace here: no folder with a workspace.yaml.' };

export const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

export const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

export const usageError = (message: string, usage: string): CommandResult => ({ code: USAGE_ERROR, output: `${message}\n${usage}\n` });

export const report = (code: number, lines: string[], count: string): CommandResult => ({ code, output: [...lines, count, ''].join('\n') });

export function parseCommandArgs<T extends ParseArgsOptionsConfig>(args: string[], options: T) {
    try {
        return parseArgs({ args, options, allowPositionals: true, strict: true });
    } catch (e) {
        return { error: errorMessage(e) };
    }
}

export function repositoryArgs<T extends ParseArgsOptionsConfig>(name: string, usage: string, args: string[], cwd: string, options: T) {
    const parsed = parseCommandArgs(args, options);
    if ('error' in parsed) {
        return { usage: usageError(parsed.error, usage) };
    }
    if (parsed.positionals.length > 1) {
        return { usage: usageError(`${name} takes one folder at most.`, usage) };
    }
    const repository = readRepository(resolve(cwd, parsed.positionals[0] ?? '.'));
    return { values: parsed.values, repository };
}
