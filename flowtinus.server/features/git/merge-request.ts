import type { UseCaseContext } from '#shared/use-cases/use-case-context';
import { gitAccess, gitAuthorOf, type GitConfig } from './git-config';
import { gitlabNotice } from './gitlab-adapter';
import type { Promotion } from './promotion-state';
import type { FileChange, FlowImpact } from './promotions';
import { providerAdapter, type NewPullRequest, type ProviderAdapter } from './provider-adapter';

export type MergeRequestLink = { number: number; url: string };

/** both absent with the adapter off; notice: why none was opened with it on */
export type OpenedMergeRequest = { mergeRequest?: MergeRequestLink; notice?: string };

export type CheckedChanges = {
    files?: FileChange[];
    flows?: FlowImpact[];
    warnings?: { message: string; items?: string[] }[];
    notes?: string[];
};

export async function adapterOf(ctx: UseCaseContext, config: GitConfig): Promise<ProviderAdapter | null> {
    const access = await gitAccess(ctx, config);
    return access.ok ? (await providerAdapter(access.value)).adapter : null;
}

export async function openMergeRequest(adapter: ProviderAdapter | null, request: NewPullRequest): Promise<OpenedMergeRequest> {
    if (!adapter) {
        return {};
    }
    try {
        const opened = (await adapter.findOpenPullRequest(request.source, request.target)) ?? (await adapter.openPullRequest(request));
        return { mergeRequest: { number: opened.number, url: opened.url } };
    } catch (e) {
        return { notice: `The merge request was not opened: ${gitlabNotice(e)}` };
    }
}

export async function recordMergeRequest(ctx: UseCaseContext, id: string, link: MergeRequestLink): Promise<void> {
    await ctx.db.query(`UPDATE promotions SET pull_request_number = $2, pull_request_url = $3 WHERE id = $1`, [id, link.number, link.url]);
}

/** closed: its merge request was closed without merging, and the row with it, so the caller opens a new one */
export async function reuseOpenRow(
    ctx: UseCaseContext,
    adapter: ProviderAdapter | null,
    row: Promotion,
    request: NewPullRequest,
): Promise<{ closed: true } | { closed: false; promotion: Promotion; notice?: string }> {
    if (!adapter) {
        return { closed: false, promotion: row };
    }
    if (row.number !== null) {
        try {
            if ((await adapter.pullRequest(row.number)).state !== 'closed') {
                return { closed: false, promotion: row };
            }
        } catch (e) {
            return { closed: false, promotion: row, notice: `The merge request could not be read: ${gitlabNotice(e)}` };
        }
        await ctx.db.query(`UPDATE promotions SET state = 'closed', state_at = now() WHERE id = $1 AND state = 'open'`, [row.id]);
        return { closed: true };
    }
    const { mergeRequest, notice } = await openMergeRequest(adapter, request);
    if (!mergeRequest) {
        return { closed: false, promotion: row, notice };
    }
    await recordMergeRequest(ctx, row.id, mergeRequest);
    return { closed: false, promotion: { ...row, ...mergeRequest } };
}

const section = (title: string, lines: string[]) => (lines.length > 0 ? [`### ${title}`, '', ...lines, ''] : []);

export async function mergeRequestDescription(ctx: UseCaseContext, checked: CheckedChanges): Promise<string> {
    const user = (await gitAuthorOf(ctx))?.name ?? ctx.userId;
    return [
        ...(checked.notes?.length ? [...checked.notes, ''] : []),
        ...section(
            'Files',
            (checked.files ?? []).map(f => `- ${f.status} \`${f.path}\``),
        ),
        ...section(
            'Flows',
            (checked.flows ?? []).map(f => `- ${f.name}${f.from ? ` (was ${f.from})` : ''}: ${f.changes.join(', ')}`),
        ),
        ...section(
            'Warnings',
            (checked.warnings ?? []).flatMap(w => [`- ${w.message}`, ...(w.items ?? []).map(item => `  - ${item}`)]),
        ),
        `Opened from Flowtinus by ${user}.`,
    ].join('\n');
}
