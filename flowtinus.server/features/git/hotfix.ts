import { z } from 'zod';
import { requireRole } from '#shared/use-cases/require-role';
import type { UseCaseContext } from '#shared/use-cases/use-case-context';
import type { UseCaseHandler } from '#shared/use-cases/use-case-handler';
import { fail, success, type UseCaseResult } from '#shared/use-cases/use-case-result';
import { validate } from '#shared/use-cases/validate';
import { onClone } from './branch-read';
import { noteHead } from './branch-write';
import { gitBranchNameError, HOTFIX_PREFIX } from './current-branch';
import { gitBranch } from './git-config';
import { hasWorkingCopy } from './working-copy';

export type CreatedHotfix = { branch: string };

const CreateHotfixCommand = z.object({ name: z.string().trim().min(1, 'Required') });

export class CreateHotfixHandler implements UseCaseHandler<CreatedHotfix> {
    async handle(input: unknown, ctx: UseCaseContext): Promise<UseCaseResult<CreatedHotfix>> {
        const denied = requireRole(ctx, 'editor');
        if (denied) {
            return denied;
        }
        const parsed = validate(CreateHotfixCommand, input);
        if (!parsed.ok) {
            return parsed;
        }
        const git = await gitBranch(ctx.db, ctx.workspaceId);
        if (!git?.branch) {
            return fail('conflict', 'Git is off in this workspace: there are no branches.');
        }
        if (git.mode !== 'protected') {
            return fail('conflict', "Only a protected environment's server creates hotfixes: create a branch instead.");
        }
        const name = `${HOTFIX_PREFIX}${parsed.value.name}`;
        const invalid = gitBranchNameError(name);
        if (invalid) {
            return fail('validation', 'The request has invalid fields.', { name: invalid });
        }
        if (await hasWorkingCopy(ctx.db, ctx.workspaceId, name)) {
            return fail('conflict', `This server still has changes on a branch ${name}: pick another name.`);
        }

        const environment = git.branch;
        return onClone(ctx, 'Git could not be reached, no hotfix was created', async remote => {
            const branches = await remote.branches();
            if ([...branches.keys()].some(b => b.toLowerCase() === name.toLowerCase())) {
                return fail('conflict', `The branch ${name} already exists.`, { name: 'Already exists' });
            }
            const tip = await remote.fetch(environment, branches);
            if (!tip) {
                return fail('conflict', `The branch ${environment} is not in the repository.`);
            }
            await remote.push(tip, name, null);
            await ctx.db.transaction(async db => {
                await noteHead(db, ctx.workspaceId, ctx.userId, name, tip);
                await db.query(
                    `INSERT INTO user_branches (workspace_id, user_id, branch) VALUES ($1, $2, $3)
                     ON CONFLICT (workspace_id, user_id) DO UPDATE SET branch = EXCLUDED.branch, updated_at = now()`,
                    [ctx.workspaceId, ctx.userId, name],
                );
            });
            return success({ branch: name });
        });
    }
}
