import type { UseCaseContext } from '#shared/use-cases/use-case-context';
import { adapterOf } from './adapter-status';
import type { GitConfig } from './git-config';
import type { PreflightWarning } from './promotion-edge';
import { PROVIDER_NAME, unlessProviderFails, type MergeLimit, type MergeSettings, type ProviderAdapter } from './provider-adapter';

export type MergeSettingsBlock = { kind: 'squash' | 'merge-method'; message: string };

export type SquashOrRebaseWarning = PreflightWarning & { kind: 'squash-or-rebase' };

export type MergeSettingsInto = { branch: string; adapter: ProviderAdapter; settings: MergeSettings };

const FAST_FORWARD_MERGING: Partial<Record<MergeLimit, string>> = {
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

const squashAndRebase = (name: string) =>
    `This ${name} repository allows squash and rebase merges: merge this pull request with **Create a merge commit**, or the lineage breaks and needs a repair.`;

/** null with the adapter off, or when the provider does not tell or does not answer: then nothing blocks or warns */
export async function mergeSettingsInto(ctx: UseCaseContext, config: GitConfig, branch: string): Promise<MergeSettingsInto | null> {
    const adapter = await adapterOf(ctx, config);
    const settings = adapter && (await unlessProviderFails<MergeSettings | null>(adapter.mergeSettings(branch), null));
    return adapter && settings ? { branch, adapter, settings } : null;
}

export function squashOrRebaseWarnings(into: MergeSettingsInto | null): SquashOrRebaseWarning[] {
    if (!into || into.adapter.canTurnSquashOff || !into.settings.methods.includes('merge-commit')) {
        return [];
    }
    return into.settings.methods.some(m => m === 'squash' || m === 'rebase')
        ? [{ kind: 'squash-or-rebase', message: squashAndRebase(PROVIDER_NAME[into.adapter.provider]), items: [] }]
        : [];
}

/** fastForward: whether the target branch is already an ancestor of the commit the pull request brings */
export async function mergeSettingsBlocks(
    into: MergeSettingsInto | null,
    fastForward: () => Promise<boolean>,
): Promise<MergeSettingsBlock[]> {
    if (!into || into.settings.methods.includes('merge-commit')) {
        return [];
    }
    let fastForwards: boolean | undefined;
    const canFastForward = async () => (fastForwards ??= await fastForward());
    if (into.settings.methods.includes('fast-forward') && (await canFastForward())) {
        return [];
    }

    const name = PROVIDER_NAME[into.adapter.provider];
    const blocks: MergeSettingsBlock[] = [];
    for (const limit of into.settings.limits) {
        if (limit === 'squash-forced') {
            blocks.push({ kind: 'squash', message: `This ${name} project forces squash: turn it off in the project's merge settings.` });
        } else if (NO_MERGE_COMMIT[limit]) {
            blocks.push({ kind: 'merge-method', message: NO_MERGE_COMMIT[limit](name, into.branch) });
        } else if (FAST_FORWARD_MERGING[limit] && !(await canFastForward())) {
            blocks.push({
                kind: 'merge-method',
                message: `This ${name} project merges ${FAST_FORWARD_MERGING[limit]}, and ${into.branch} cannot be fast-forwarded now: set the merge method to "Merge commit" in the project's merge settings.`,
            });
        }
    }
    return blocks;
}
