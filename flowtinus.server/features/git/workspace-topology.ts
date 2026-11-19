import { fail, success, type UseCaseResult } from '#shared/use-cases/use-case-result';
import type { GitRemote } from './git-remote';
import { CONFIG_BRANCH, parseTopology, TOPOLOGY_FILE, type EnvironmentDecl, type Mode } from './topology';

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

const TOPOLOGIES_KEPT = 16;
const topologies = new Map<string, string>();

export async function topologyAt(remote: GitRemote, commit: string): Promise<string | null> {
    const kept = topologies.get(commit);
    if (kept !== undefined) {
        return kept;
    }
    const text = await remote.readFile(commit, TOPOLOGY_FILE);
    if (text !== null) {
        topologies.set(commit, text);
        while (topologies.size > TOPOLOGIES_KEPT) {
            topologies.delete(topologies.keys().next().value!);
        }
    }
    return text;
}

export async function readTopology(remote: GitRemote, environment: string, branches?: Map<string, string>): Promise<TopologyView> {
    const known = branches ?? (await remote.branches());
    const commit = await remote.fetch(CONFIG_BRANCH, known);
    if (!commit) {
        return { exists: false };
    }

    const text = await topologyAt(remote, commit);
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
    known?: Map<string, string>,
): Promise<UseCaseResult<{ branch: string; tip: string | null; mode: Mode }>> {
    const branches = known ?? (await remote.branches());
    const topology = await readTopology(remote, environment, branches);
    if (!topology.exists) {
        return fail('conflict', `The repository has no ${CONFIG_BRANCH} branch.`);
    }
    if (!topology.environment) {
        return fail('conflict', `${environment} is not in the topology.`);
    }

    const { branch, mode } = topology.environment;
    return success({ branch, tip: await remote.fetch(branch, branches), mode });
}
