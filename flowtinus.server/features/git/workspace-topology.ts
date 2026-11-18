import { fail, success, type UseCaseResult } from '#shared/use-cases/use-case-result';
import type { GitRemote } from './git-remote';
import { CONFIG_BRANCH, parseTopology, TOPOLOGY_FILE, type EnvironmentDecl } from './topology';

export type TopologyView =
    | { exists: false }
    | {
          exists: true;
          commit: string;
          environments: EnvironmentDecl[];
          problems: string[];
          environment: EnvironmentDecl | null;
          branchExists: boolean;
      };

export async function readTopology(remote: GitRemote, environment: string, branches?: Map<string, string>): Promise<TopologyView> {
    const known = branches ?? (await remote.branches());
    const commit = await remote.fetch(CONFIG_BRANCH, known);
    if (!commit) {
        return { exists: false };
    }

    const text = await remote.readFile(commit, TOPOLOGY_FILE);
    const { environments, problems } =
        text === null ? { environments: [], problems: [`${CONFIG_BRANCH} has no ${TOPOLOGY_FILE}.`] } : parseTopology(text);
    const decl = environments.find(e => e.env === environment) ?? null;
    if (!decl && text !== null) {
        problems.push(`${environment} is not in the topology.`);
    }

    return { exists: true, commit, environments, problems, environment: decl, branchExists: !!decl && known.has(decl.branch) };
}

export async function environmentBranch(
    remote: GitRemote,
    environment: string,
): Promise<UseCaseResult<{ branch: string; tip: string | null }>> {
    const branches = await remote.branches();
    const topology = await readTopology(remote, environment, branches);
    if (!topology.exists) {
        return fail('conflict', `The repository has no ${CONFIG_BRANCH} branch.`);
    }
    if (!topology.environment) {
        return fail('conflict', `${environment} is not in the topology.`);
    }

    const branch = topology.environment.branch;
    return success({ branch, tip: await remote.fetch(branch, branches) });
}
