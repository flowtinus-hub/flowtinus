import type { UseCaseContext } from '#shared/use-cases/use-case-context';
import { UseCaseFailure } from '#shared/use-cases/use-case-failure';
import { gitAccess, type GitConfig } from './git-config';
import type { GitAccess } from './git-remote';
import { refuseOnLocalServer } from './local-server';
import { githubAdapter } from './github-adapter';
import { gitlabAdapter } from './gitlab-adapter';
import type { ProviderAdapter } from './provider-adapter';
import { providerOf, type Provider } from './pull-request';

/** provider null: one the app does not know; adapter null: push and link, with a notice when the provider has an adapter */
export type AdapterStatus =
    | { provider: Provider | null; adapter: ProviderAdapter; notice: null }
    | { provider: Provider | null; adapter: null; notice: string | null };

const ADAPTERS: Record<Provider, (access: GitAccess) => Promise<{ adapter: ProviderAdapter } | { notice: string }>> = {
    gitlab: gitlabAdapter,
    github: githubAdapter,
};

export async function providerAdapter(access: GitAccess): Promise<AdapterStatus> {
    const provider = await providerOf(access.repository);
    if (!provider) {
        return { provider, adapter: null, notice: null };
    }
    const found = await ADAPTERS[provider](access);
    return 'adapter' in found ? { provider, adapter: found.adapter, notice: null } : { provider, adapter: null, notice: found.notice };
}

export async function adapterOf(ctx: UseCaseContext, config: GitConfig): Promise<ProviderAdapter | null> {
    const refused = refuseOnLocalServer(ctx.git, "the provider's adapter");
    if (refused && !refused.ok) {
        throw new UseCaseFailure(refused.error.code, refused.error.message);
    }
    const access = await gitAccess(ctx, config);
    return access.ok ? (await providerAdapter(access.value)).adapter : null;
}
