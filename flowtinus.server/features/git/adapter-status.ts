import type { UseCaseContext } from '#shared/use-cases/use-case-context';
import { gitAccess, type GitConfig } from './git-config';
import type { GitAccess } from './git-remote';
import { gitlabAdapter } from './gitlab-adapter';
import type { ProviderAdapter } from './provider-adapter';
import { providerOf, type Provider } from './pull-request';

/** provider null: one the app does not know; adapter null: push and link, with a notice when the provider has an adapter */
export type AdapterStatus =
    | { provider: Provider | null; adapter: ProviderAdapter; notice: null }
    | { provider: Provider | null; adapter: null; notice: string | null };

export async function providerAdapter(access: GitAccess): Promise<AdapterStatus> {
    const provider = await providerOf(access.repository);
    if (provider !== 'gitlab') {
        return { provider, adapter: null, notice: null };
    }
    const gitlab = await gitlabAdapter(access);
    return 'adapter' in gitlab ? { provider, adapter: gitlab.adapter, notice: null } : { provider, adapter: null, notice: gitlab.notice };
}

export async function adapterOf(ctx: UseCaseContext, config: GitConfig): Promise<ProviderAdapter | null> {
    const access = await gitAccess(ctx, config);
    return access.ok ? (await providerAdapter(access.value)).adapter : null;
}
