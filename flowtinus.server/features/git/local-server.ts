import { fail, type UseCaseResult } from '#shared/use-cases/use-case-result';
import type { GitOptions } from './git-config';

/** the developer's clone a local server reads (LOCAL_REPO); null on any other server */
export const localRepoOf = (git: GitOptions | undefined): string | null => git?.localRepo ?? null;

export const isLocalServer = (git: GitOptions | undefined): boolean => localRepoOf(git) !== null;

/** what belongs to a remote, the topology or a branch is off on a local server: git is the developer's there */
export function refuseOnLocalServer(git: GitOptions | undefined, what: string): UseCaseResult<never> | null {
    const repo = localRepoOf(git);
    return repo
        ? fail(
              'conflict',
              `This is a local server on ${repo}: ${what} is off here, git is yours (commit, push and switch branches with it).`,
          )
        : null;
}
