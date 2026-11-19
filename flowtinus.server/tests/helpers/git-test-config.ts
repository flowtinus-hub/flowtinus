import { afterAll } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

/*
 * Preloaded by bun test (bunfig.toml): no git process of the tests runs the housekeeping a fetch or a push starts
 * after it, which the tests' short-lived repositories never need. The environment's entries reach the server's git
 * and the helpers'; git clears them for the receive-pack of a push to a local path, which reads the global file.
 */
const settings: [string, string][] = [
    ['maintenance.auto', 'false'],
    ['gc.auto', '0'],
    ['receive.autogc', 'false'],
    ['fetch.writeCommitGraph', 'false'],
];

const inherited = Number(process.env.GIT_CONFIG_COUNT) || 0;
settings.forEach(([key, value], i) => {
    process.env[`GIT_CONFIG_KEY_${inherited + i}`] = key;
    process.env[`GIT_CONFIG_VALUE_${inherited + i}`] = value;
});
process.env.GIT_CONFIG_COUNT = String(inherited + settings.length);

const globals = process.env.GIT_CONFIG_GLOBAL
    ? [process.env.GIT_CONFIG_GLOBAL]
    : [join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'git', 'config'), join(homedir(), '.gitconfig')];
const dir = mkdtempSync(join(tmpdir(), 'flowtinus-test-gitconfig-'));
const file = join(dir, 'gitconfig');
writeFileSync(
    file,
    [
        ...globals.filter(existsSync).map(path => `[include]\n\tpath = "${path.replaceAll('\\', '/')}"\n`),
        ...settings.map(([key, value]) => {
            const [section, name] = key.split('.') as [string, string];
            return `[${section}]\n\t${name} = ${value}\n`;
        }),
    ].join(''),
);
process.env.GIT_CONFIG_GLOBAL = file;
afterAll(() => rmSync(dir, { recursive: true, force: true }));
