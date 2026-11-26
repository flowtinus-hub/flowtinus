import type { UseCaseContext } from '#shared/use-cases/use-case-context';
import { adapterOf } from './adapter-status';
import type { GitConfig } from './git-config';
import { PROVIDER_NAME, unlessProviderFails, type BranchProtection } from './provider-adapter';
import type { EnvironmentDecl } from './topology';

export type ProtectionWarning = { env: string; branch: string; message: string };

function warningOf(e: EnvironmentDecl, push: BranchProtection['push'], provider: string): string | null {
    if (e.mode === 'protected' && push === 'developers') {
        return `${e.label} is protected in the topology, but developers may push to ${e.branch} on ${provider}.`;
    }
    if (e.mode === 'direct' && push === 'nobody') {
        return `${e.label} is direct in the topology, but ${provider} refuses pushes to ${e.branch}.`;
    }
    return null;
}

const CLASSIC_UNREADABLE =
    'Classic branch protection cannot be read with this token, which needs admin access to the repository: the branches it protects get no warning on their protection.';

const keepsMergedBranches = (provider: string) =>
    `This ${provider} repository does not delete merged branches: turn on "Automatically delete head branches" in its settings (General, Pull Requests). The app never deletes a branch on the remote.`;

async function protectionsOf(ctx: UseCaseContext, config: GitConfig, environments: EnvironmentDecl[]) {
    const adapter = await adapterOf(ctx, config);
    const protections =
        adapter && (await unlessProviderFails<BranchProtection[] | null>(adapter.branchProtections(environments.map(e => e.branch)), null));
    return adapter && protections ? { adapter, protections } : null;
}

function warningsOf(environments: EnvironmentDecl[], protections: BranchProtection[], provider: string): ProtectionWarning[] {
    return environments.flatMap((e, i) => {
        const message = warningOf(e, protections[i]!.push, provider);
        return message ? [{ env: e.env, branch: e.branch, message }] : [];
    });
}

/** with the adapter on: where the provider's branch protection disagrees with the modes; never fails, an API error shows nothing */
export async function protectionWarnings(
    ctx: UseCaseContext,
    config: GitConfig,
    environments: EnvironmentDecl[],
): Promise<ProtectionWarning[]> {
    const read = await protectionsOf(ctx, config, environments);
    return read ? warningsOf(environments, read.protections, PROVIDER_NAME[read.adapter.provider]) : [];
}

// the git section's only, read when it loads: the notices cost more calls than the cards and the poll should make
export async function protectionWarningsWithNotices(
    ctx: UseCaseContext,
    config: GitConfig,
    environments: EnvironmentDecl[],
): Promise<{ warnings: ProtectionWarning[]; notices: string[] }> {
    const read = await protectionsOf(ctx, config, environments);
    if (!read) {
        return { warnings: [], notices: [] };
    }
    const provider = PROVIDER_NAME[read.adapter.provider];
    const deletes = read.adapter.deletesMergedBranches
        ? await unlessProviderFails<boolean | null>(read.adapter.deletesMergedBranches(), null)
        : null;
    return {
        warnings: warningsOf(environments, read.protections, provider),
        notices: [
            ...(deletes === false ? [keepsMergedBranches(provider)] : []),
            ...(read.protections.some(p => p.push === 'unknown') ? [CLASSIC_UNREADABLE] : []),
        ],
    };
}
