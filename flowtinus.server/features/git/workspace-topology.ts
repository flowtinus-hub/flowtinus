import type { GitRemote } from './git-remote';
import { CONFIG_BRANCH, parseTopology, TOPOLOGY_FILE, type EnvironmentDecl } from './topology';

export type TopologyView =
    | { exists: false }
    | {
          exists: true;
          commit: string;
          environments: EnvironmentDecl[];
          problems: string[];
          /** this server's environment, as the topology declares it (null: it does not) */
          environment: EnvironmentDecl | null;
          /** whether the repository has this environment's branch yet */
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
