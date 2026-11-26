import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { errorMessage, USAGE_ERROR, usageError, type Command, type CommandResult } from './command';

const COMMANDS = join(import.meta.dir, 'commands');

const commandNames = () =>
    readdirSync(COMMANDS)
        .filter(file => file.endsWith('.ts'))
        .map(file => file.slice(0, -'.ts'.length))
        .sort();

const usage = () => `Usage: flowtinus <command> [options]\nCommands: ${commandNames().join(', ')}`;

export async function main(argv: string[], cwd: string): Promise<CommandResult> {
    const [name, ...args] = argv;
    if (name === undefined || name === '--help' || name === '-h') {
        return { code: name === undefined ? USAGE_ERROR : 0, output: `${usage()}\n` };
    }
    if (!commandNames().includes(name)) {
        return usageError(`Unknown command "${name}".`, usage());
    }
    const { run } = (await import(join(COMMANDS, `${name}.ts`))) as { run: Command };
    try {
        return await run(args, cwd);
    } catch (e) {
        return { code: 1, output: `${errorMessage(e)}\n` };
    }
}
