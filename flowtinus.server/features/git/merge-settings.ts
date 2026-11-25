import type { UseCaseContext } from '#shared/use-cases/use-case-context';
import { adapterOf } from './adapter-status';
import type { GitConfig } from './git-config';
import { PROVIDER_NAME, unlessProviderFails, type MergeSettings } from './provider-adapter';

export type MergeSettingsBlock = { kind: 'squash' | 'merge-method'; message: string };

const METHOD: Record<Exclude<MergeSettings['mergeMethod'], 'merge'>, string> = {
    'fast-forward': 'only by fast-forward',
    'semi-linear': 'only with a semi-linear history',
};

/** fastForward: whether the target branch is already an ancestor of the commit the pull request brings */
export async function mergeSettingsBlocks(
    ctx: UseCaseContext,
    config: GitConfig,
    target: { branch: string; fastForward: () => Promise<boolean> },
): Promise<MergeSettingsBlock[]> {
    const adapter = await adapterOf(ctx, config);
    const settings = adapter && (await unlessProviderFails<MergeSettings | null>(adapter.mergeSettings(), null));
    if (!adapter || !settings) {
        return [];
    }

    const name = PROVIDER_NAME[adapter.provider];
    const blocks: MergeSettingsBlock[] = [];
    if (settings.squash === 'always') {
        blocks.push({ kind: 'squash', message: `This ${name} project forces squash: turn it off in the project's merge settings.` });
    }
    if (settings.mergeMethod !== 'merge' && !(await target.fastForward())) {
        blocks.push({
            kind: 'merge-method',
            message: `This ${name} project merges ${METHOD[settings.mergeMethod]}, and ${target.branch} cannot be fast-forwarded now: set the merge method to "Merge commit" in the project's merge settings.`,
        });
    }
    return blocks;
}
