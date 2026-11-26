import { parseArgs, type ParseArgsOptionsConfig } from 'node:util';

export type CommandResult = { code: number; output: string };

export type Command = (args: string[], cwd: string) => Promise<CommandResult>;

export const USAGE_ERROR = 2;

export const usageError = (message: string, usage: string): CommandResult => ({ code: USAGE_ERROR, output: `${message}\n${usage}\n` });

export type ParsedArgs = { values: Record<string, string | boolean | undefined>; positionals: string[] };

export function parseCommandArgs(args: string[], options: ParseArgsOptionsConfig): ParsedArgs | { error: string } {
    try {
        const { values, positionals } = parseArgs({ args, options, allowPositionals: true, strict: true });
        return { values: values as ParsedArgs['values'], positionals };
    } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) };
    }
}
