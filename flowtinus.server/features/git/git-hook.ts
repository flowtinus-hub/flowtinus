import { timingSafeEqual } from 'node:crypto';
import { deleteWorkspaceSetting, readWorkspaceSetting, writeWorkspaceSetting } from '#features/workspaces/workspace-settings';
import type { Database } from '#shared/database/database';
import type { UseCaseContext } from '#shared/use-cases/use-case-context';
import { HOOK_SETTING } from './git-config';

/*
 * The workspace's git webhook: POST /git/hook/<workspace>/<token>, for the git provider. It ignores the payload and only
 * brings the fetch forward, so the token is kept as it is (the git settings show the whole URL) and no provider
 * signature is checked.
 */

export const hookPath = (slug: string, token: string) => `git/hook/${slug}/${token}`;

const newToken = () => `fgh_${Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString('base64url')}`;

export async function readHookToken(db: Database, workspaceId: string): Promise<string | null> {
    const stored = (await readWorkspaceSetting(db, workspaceId, HOOK_SETTING)) as { token?: string } | null;
    return stored?.token ?? null;
}

/** a new token: the old one stops working */
export async function renewHookToken(ctx: UseCaseContext): Promise<string> {
    const token = newToken();
    await writeWorkspaceSetting(ctx.db, ctx.workspaceId, HOOK_SETTING, { token }, ctx.userId);
    return token;
}

export const ensureHookToken = async (ctx: UseCaseContext) => (await readHookToken(ctx.db, ctx.workspaceId)) ?? renewHookToken(ctx);

export const forgetHookToken = (ctx: UseCaseContext) => deleteWorkspaceSetting(ctx.db, ctx.workspaceId, HOOK_SETTING);

/** the workspace a webhook's call names, when its token is the workspace's */
export async function hookWorkspace(db: Database, slug: string, token: string): Promise<string | null> {
    const [workspace] = await db.query<{ id: string }>('SELECT id FROM workspaces WHERE slug = $1 AND deleted_at IS NULL', [slug]);
    const stored = workspace ? await readHookToken(db, workspace.id) : null;
    const same = stored !== null && stored.length === token.length && timingSafeEqual(Buffer.from(stored), Buffer.from(token));
    return same ? workspace!.id : null;
}
