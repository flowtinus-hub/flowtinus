import { gitOutput } from '@flowtinus/core/disk';
import { fail, type UseCaseResult } from '#shared/use-cases/use-case-result';
import type { GitOptions } from './git-config';

export const localRepoOf = (git: GitOptions | undefined): string | null => git?.localRepo ?? null;

export const isLocalServer = (git: GitOptions | undefined): boolean => localRepoOf(git) !== null;

export function refuseOnLocalServer(git: GitOptions | undefined, what: string): UseCaseResult<never> | null {
    const repo = localRepoOf(git);
    return repo
        ? fail(
              'conflict',
              `This is a local server on ${repo}: ${what} is off here, git is yours (commit, push and switch branches with it).`,
          )
        : null;
}

export type LocalHead = { branch: string | null; sha: string | null };

const gitOut = (repo: string, args: string[]) => {
    const done = gitOutput(repo, args);
    return done.ok ? done.out.trim() : null;
};

/** a branch with no commit yet (a new repository) has no sha */
export const localHead = (repo: string): LocalHead => ({
    branch: gitOut(repo, ['symbolic-ref', '--short', '-q', 'HEAD']),
    sha: gitOut(repo, ['rev-parse', '--short', '-q', '--verify', 'HEAD']),
});
