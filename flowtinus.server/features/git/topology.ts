import YAML from 'yaml';

export const CONFIG_BRANCH = 'flowtinus/config';
export const TOPOLOGY_FILE = 'topology.yaml';

export const MODES = ['direct', 'pull-request', 'protected'] as const;
export type Mode = (typeof MODES)[number];

export type EnvironmentDecl = { env: string; label: string; branch: string; promotesTo: string[]; mode: Mode };

export const ENVIRONMENT_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;

export function branchNameError(branch: string): string | null {
    if (!/^[A-Za-z0-9._/-]{1,100}$/.test(branch) || /^[-/.]|[/.]$|\.\.|\/\/|\/\.|\.lock$|\.lock\//.test(branch) || branch === 'HEAD') {
        return 'Not a valid branch name';
    }

    return branch === CONFIG_BRANCH ? `${CONFIG_BRANCH} holds the topology` : null;
}

export const topologyYaml = (environments: EnvironmentDecl[]): string =>
    YAML.stringify({
        environments: environments.map(({ env, label, branch, promotesTo, mode }) => ({ env, label, branch, promotesTo, mode })),
    });

/** reads topology.yaml as it is (written by the app or anyone): the environments it declares and what is wrong with it */
export function parseTopology(text: string): { environments: EnvironmentDecl[]; problems: string[] } {
    let doc: unknown;
    try {
        doc = YAML.parse(text);
    } catch (e) {
        return { environments: [], problems: [`${TOPOLOGY_FILE} is not valid YAML: ${(e as Error).message}`] };
    }

    const list = (doc as { environments?: unknown } | null)?.environments;
    if (!Array.isArray(list)) {
        return { environments: [], problems: [`${TOPOLOGY_FILE} has no list of environments.`] };
    }

    const problems: string[] = [];
    const environments: EnvironmentDecl[] = [];
    list.forEach((item: Record<string, unknown> | null, i) => {
        const env = typeof item?.env === 'string' ? item.env : '';
        const branch = typeof item?.branch === 'string' ? item.branch : '';
        const mode = (item?.mode ?? 'direct') as Mode;
        const promotesTo = item?.promotesTo ?? [];
        const where = env || `Environment ${i + 1}`;
        if (!ENVIRONMENT_NAME.test(env)) {
            problems.push(`${where}: its env is missing or not a valid name.`);
            return;
        }
        if (branchNameError(branch)) {
            problems.push(`${where}: its branch is missing or not valid.`);
            return;
        }
        if (!MODES.includes(mode)) {
            problems.push(`${where}: its mode is not one of ${MODES.join(', ')}.`);
            return;
        }
        if (!Array.isArray(promotesTo) || promotesTo.some(t => typeof t !== 'string')) {
            problems.push(`${where}: promotesTo is not a list of environments.`);
            return;
        }

        environments.push({ env, label: typeof item?.label === 'string' && item.label ? item.label : env, branch, promotesTo, mode });
    });

    const names = new Set<string>();
    const branches = new Set<string>();
    for (const e of environments) {
        if (names.has(e.env)) {
            problems.push(`${e.env} is declared twice.`);
        }
        if (branches.has(e.branch)) {
            problems.push(`The branch ${e.branch} belongs to two environments.`);
        }
        names.add(e.env);
        branches.add(e.branch);
    }

    for (const e of environments) {
        for (const target of e.promotesTo.filter(t => !names.has(t))) {
            problems.push(`${e.env} promotes to ${target}, which is not declared.`);
        }
        const sources = environments.filter(s => s.promotesTo.includes(e.env));
        if (sources.length > 1) {
            problems.push(`${e.env} has two sources (${sources.map(s => s.env).join(', ')}): the topology is a tree.`);
        }
        if (reaches(environments, e.env, e.env)) {
            problems.push(`${e.env} promotes back into itself.`);
        }
    }

    return { environments, problems };
}

function reaches(environments: EnvironmentDecl[], from: string, to: string, seen = new Set<string>()): boolean {
    for (const next of environments.find(e => e.env === from)?.promotesTo ?? []) {
        if (next === to) {
            return true;
        }
        if (!seen.has(next)) {
            seen.add(next);
            if (reaches(environments, next, to, seen)) {
                return true;
            }
        }
    }

    return false;
}
