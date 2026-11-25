import type { UseCaseContext } from '#shared/use-cases/use-case-context';
import { gitAccess, type GitConfig } from './git-config';
import { ProviderError, providerAdapter, type AccessRule, type BranchProtection } from './provider-adapter';
import type { Provider } from './pull-request';
import type { EnvironmentDecl } from './topology';

export type ProtectionWarning = { env: string; branch: string; message: string };

const PROVIDER_NAME: Record<Provider, string> = { gitlab: 'GitLab', github: 'GitHub' };

const OPENNESS: AccessRule[] = ['nobody', 'maintainers', 'developers'];

const pattern = (branch: string) =>
    new RegExp(
        `^${branch
            .split('*')
            .map(part => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
            .join('.*')}$`,
    );

// a branch several rules match takes the most permissive one, as GitLab does
function whoPushes(protections: BranchProtection[], branch: string): AccessRule {
    const matching = protections.filter(p => pattern(p.branch).test(branch)).map(p => OPENNESS.indexOf(p.push));
    return matching.length ? OPENNESS[Math.max(...matching)]! : 'developers';
}

function warningOf(e: EnvironmentDecl, push: AccessRule, provider: string): string | null {
    if (e.mode === 'protected' && push === 'developers') {
        return `${e.label} is protected in the topology, but developers may push to ${e.branch} on ${provider}.`;
    }
    if (e.mode === 'direct' && push === 'nobody') {
        return `${e.label} is direct in the topology, but ${provider} refuses pushes to ${e.branch}.`;
    }
    return null;
}

/** with the adapter on: where the provider's branch protection disagrees with the modes; never fails, an API error shows nothing */
export async function protectionWarnings(
    ctx: UseCaseContext,
    config: GitConfig,
    environments: EnvironmentDecl[],
): Promise<ProtectionWarning[]> {
    const access = await gitAccess(ctx, config);
    const adapter = access.ok ? (await providerAdapter(access.value)).adapter : null;
    if (!adapter) {
        return [];
    }
    let protections: BranchProtection[];
    try {
        protections = await adapter.branchProtections();
    } catch (e) {
        if (e instanceof ProviderError) {
            return [];
        }
        throw e;
    }
    return environments.flatMap(e => {
        const message = warningOf(e, whoPushes(protections, e.branch), PROVIDER_NAME[adapter.provider]);
        return message ? [{ env: e.env, branch: e.branch, message }] : [];
    });
}
