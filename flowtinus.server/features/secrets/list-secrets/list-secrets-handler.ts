import { withUpdatedByName } from '#features/users/user-names';
import type { UseCaseContext } from '#shared/use-cases/use-case-context';
import type { UseCaseHandler } from '#shared/use-cases/use-case-handler';
import { success, type UseCaseResult } from '#shared/use-cases/use-case-result';
import { toSecretView, type SecretView } from '../secret';
import { workspaceSecrets } from '../secret-store';

export class ListSecretsHandler implements UseCaseHandler<{ items: SecretView[] }> {
    async handle(_input: unknown, ctx: UseCaseContext): Promise<UseCaseResult<{ items: SecretView[] }>> {
        const rows = await workspaceSecrets(ctx.db, ctx.workspaceId);
        return success({
            items: await withUpdatedByName(ctx.db, rows.sort((a, b) => a.name.localeCompare(b.name, 'en')).map(toSecretView)),
        });
    }
}
