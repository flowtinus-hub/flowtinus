import type { UseCaseContext } from '#shared/use-cases/use-case-context';
import { adapterOf } from './adapter-status';
import type { GitConfig } from './git-config';
import { PROVIDER_NAME, unlessProviderFails, type MergeLimit, type MergeSettings } from './provider-adapter';

export type MergeSettingsBlock = { kind: 'squash' | 'merge-method'; message: string };

export type MergeSettingsWarning = { kind: 'merge-method'; message: string; items: string[] };

export type MergeSettingsChecks = { blocks: MergeSettingsBlock[]; warnings: MergeSettingsWarning[] };

const FAST_FORWARD_ONLY: Partial<Record<MergeLimit, string>> = {
    'fast-forward-only': 'only by fast-forward',
    'semi-linear-only': 'only with a semi-linear history',
};

const NO_MERGE_COMMIT: Partial<Record<MergeLimit, (name: string, branch: string) => string>> = {
    'merge-commits-off': name => `This ${name} repository does not allow merge commits: turn on "Allow merge commits" in its settings.`,
    'linear-history-required': (_, branch) =>
        `A ruleset on ${branch} requires a linear history: turn "Require linear history" off in the ruleset.`,
    'merge-commit-not-allowed-by-rule': (_, branch) =>
        `A ruleset on ${branch} does not allow merge commits: add "Merge" to the allowed merge methods of its pull request rule.`,
};

const mayRewrite = (settings: MergeSettings) => settings.methods.some(m => m === 'squash' || m === 'rebase');

const squashAndRebase = (name: string) =>
    `This ${name} repository allows squash and rebase merges: merge this pull request with **Create a merge commit**, or the lineage breaks and needs a repair.`;

/** fastForward: whether the target branch is already an ancestor of the commit the pull request brings */
export async function mergeSettingsChecks(
    ctx: UseCaseContext,
    config: GitConfig,
    target: { branch: string; fastForward: () => Promise<boolean> },
): Promise<MergeSettingsChecks> {
    const adapter = await adapterOf(ctx, config);
    const settings = adapter && (await unlessProviderFails<MergeSettings | null>(adapter.mergeSettings(target.branch), null));
    if (!adapter || !settings) {
        return { blocks: [], warnings: [] };
    }
    if (settings.methods.includes('merge-commit')) {
        const warn = !adapter.canTurnSquashOff && mayRewrite(settings);
        return {
            blocks: [],
            warnings: warn ? [{ kind: 'merge-method', message: squashAndRebase(PROVIDER_NAME[adapter.provider]), items: [] }] : [],
        };
    }
    let fastForward: boolean | undefined;
    const canFastForward = async () => (fastForward ??= await target.fastForward());
    if (settings.methods.includes('fast-forward') && (await canFastForward())) {
        return { blocks: [], warnings: [] };
    }

    const name = PROVIDER_NAME[adapter.provider];
    const blocks: MergeSettingsBlock[] = [];
    for (const limit of settings.limits) {
        if (limit === 'squash-forced') {
            blocks.push({ kind: 'squash', message: `This ${name} project forces squash: turn it off in the project's merge settings.` });
        } else if (NO_MERGE_COMMIT[limit]) {
            blocks.push({ kind: 'merge-method', message: NO_MERGE_COMMIT[limit](name, target.branch) });
        } else if (FAST_FORWARD_ONLY[limit] && !(await canFastForward())) {
            blocks.push({
                kind: 'merge-method',
                message: `This ${name} project merges ${FAST_FORWARD_ONLY[limit]}, and ${target.branch} cannot be fast-forwarded now: set the merge method to "Merge commit" in the project's merge settings.`,
            });
        }
    }
    return { blocks, warnings: [] };
}
