import type { UseCaseContext } from '#shared/use-cases/use-case-context';
import { adapterOf } from './adapter-status';
import type { GitConfig } from './git-config';
import { PROVIDER_NAME, unlessProviderFails, type MergeLimit, type MergeSettings } from './provider-adapter';

export type MergeSettingsBlock = { kind: 'squash' | 'merge-method'; message: string };

const FAST_FORWARD_ONLY: Partial<Record<MergeLimit, string>> = {
    'fast-forward-only': 'only by fast-forward',
    'semi-linear-only': 'only with a semi-linear history',
};

/** fastForward: whether the target branch is already an ancestor of the commit the pull request brings */
export async function mergeSettingsBlocks(
    ctx: UseCaseContext,
    config: GitConfig,
    target: { branch: string; fastForward: () => Promise<boolean> },
): Promise<MergeSettingsBlock[]> {
    const adapter = await adapterOf(ctx, config);
    const settings = adapter && (await unlessProviderFails<MergeSettings | null>(adapter.mergeSettings(target.branch), null));
    if (!adapter || !settings || settings.methods.includes('merge-commit')) {
        return [];
    }
    let fastForward: boolean | undefined;
    const canFastForward = async () => (fastForward ??= await target.fastForward());
    if (settings.methods.includes('fast-forward') && (await canFastForward())) {
        return [];
    }

    const name = PROVIDER_NAME[adapter.provider];
    const blocks: MergeSettingsBlock[] = [];
    for (const limit of settings.limits) {
        if (limit === 'squash-forced') {
            blocks.push({ kind: 'squash', message: `This ${name} project forces squash: turn it off in the project's merge settings.` });
        } else if (FAST_FORWARD_ONLY[limit] && !(await canFastForward())) {
            blocks.push({
                kind: 'merge-method',
                message: `This ${name} project merges ${FAST_FORWARD_ONLY[limit]}, and ${target.branch} cannot be fast-forwarded now: set the merge method to "Merge commit" in the project's merge settings.`,
            });
        }
    }
    return blocks;
}
