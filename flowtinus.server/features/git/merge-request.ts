import type { UseCaseContext } from '#shared/use-cases/use-case-context';
import { fail, success, type UseCaseResult } from '#shared/use-cases/use-case-result';
import { gitAuthorOf } from './git-config';
import type { Promotion, PromotionRow } from './promotion-state';
import type { FileChange, FlowImpact } from './promotions';
import { providerNotice, PULL_REQUEST_NAME, unlessProviderFails, type NewPullRequest, type ProviderAdapter, type ProviderPullRequest } from './provider-adapter';

export type MergeRequestLink = { number: number; url: string };

/** both absent with the adapter off; notice: why none was opened with it on */
export type OpenedMergeRequest = { mergeRequest?: MergeRequestLink; notice?: string };

export type CheckedChanges = {
    files?: FileChange[];
    flows?: FlowImpact[];
    warnings?: { message: string; items?: string[] }[];
    notes?: string[];
};

type PullRequestFields = Pick<NewPullRequest, 'source' | 'target' | 'title' | 'description'>;

export const requestKeepingCommits = (fields: PullRequestFields): NewPullRequest => ({
    ...fields,
    squash: false,
    removeSourceBranch: true,
});

export const workBranchRequest = (fields: PullRequestFields): NewPullRequest => ({ ...fields, removeSourceBranch: true });

export const pullRequestUrl = (opened: OpenedMergeRequest, link: string | null): string | null => opened.mergeRequest?.url ?? link;

export const refusedBy = (blocks: { message: string }[]) => fail('conflict', blocks.map(b => b.message).join(' '));

export async function openMergeRequest(adapter: ProviderAdapter | null, request: NewPullRequest): Promise<OpenedMergeRequest> {
    if (!adapter) {
        return {};
    }
    try {
        const opened = (await adapter.findOpenPullRequest(request.source, request.target)) ?? (await adapter.openPullRequest(request));
        return { mergeRequest: { number: opened.number, url: opened.url } };
    } catch (e) {
        return { notice: `The ${PULL_REQUEST_NAME[adapter.provider]} was not opened: ${providerNotice(adapter.provider, e)}` };
    }
}

export async function recordMergeRequest(ctx: UseCaseContext, id: string, link: MergeRequestLink): Promise<void> {
    await ctx.db.query(`UPDATE promotions SET pull_request_number = $2, pull_request_url = $3 WHERE id = $1`, [id, link.number, link.url]);
}

/** closed: its merge request was closed without merging, and the row with it, so the caller opens a new one */
export type ReusedRow = { closed: true } | { closed: false; promotion: Promotion; notice?: string };

/** blocks: what refuses a new merge request, for a row that has none yet */
export async function reuseOpenRow(
    ctx: UseCaseContext,
    adapter: ProviderAdapter | null,
    row: Promotion,
    request: NewPullRequest,
    blocks: { message: string }[],
): Promise<UseCaseResult<ReusedRow>> {
    if (!adapter) {
        return success({ closed: false, promotion: row });
    }
    if (row.number !== null) {
        try {
            if ((await adapter.pullRequest(row.number)).state !== 'closed') {
                return success({ closed: false, promotion: row });
            }
        } catch (e) {
            return success({
                closed: false,
                promotion: row,
                notice: `The ${PULL_REQUEST_NAME[adapter.provider]} could not be read: ${providerNotice(adapter.provider, e)}`,
            });
        }
        await ctx.db.query(`UPDATE promotions SET state = 'closed', state_at = now() WHERE id = $1 AND state = 'open'`, [row.id]);
        return success({ closed: true });
    }
    if (blocks.length > 0) {
        return refusedBy(blocks);
    }
    const { mergeRequest, notice } = await openMergeRequest(adapter, request);
    if (!mergeRequest) {
        return success({ closed: false, promotion: row, notice });
    }
    await recordMergeRequest(ctx, row.id, mergeRequest);
    return success({ closed: false, promotion: { ...row, ...mergeRequest } });
}

export type RowInto = { row: Pick<PromotionRow, 'id' | 'branch' | 'opened_at' | 'pull_request_number'>; into: string };

const CLOCK_SKEW_MS = 24 * 60 * 60 * 1000;

/** one call per target branch; a row with no number takes the open merge request from its branch, else the newest no other row holds */
export async function mergeRequestsOfRows(
    ctx: UseCaseContext,
    adapter: ProviderAdapter,
    rows: RowInto[],
): Promise<Map<string, ProviderPullRequest>> {
    const found = new Map<string, ProviderPullRequest>();
    const held = new Set(
        (
            await ctx.db.query<{ pull_request_number: number }>(
                `SELECT pull_request_number FROM promotions WHERE workspace_id = $1 AND branch = ANY($2) AND pull_request_number IS NOT NULL`,
                [ctx.workspaceId, rows.map(r => r.row.branch)],
            )
        ).map(r => r.pull_request_number),
    );
    for (const into of new Set(rows.map(r => r.into))) {
        const along = rows.filter(r => r.into === into).map(r => r.row);
        const since = new Date(Math.min(...along.map(r => new Date(r.opened_at).getTime())) - CLOCK_SKEW_MS);
        const listed = await unlessProviderFails<ProviderPullRequest[] | null>(adapter.pullRequestsInto(into, since), null);
        if (!listed) {
            continue;
        }
        for (const row of along) {
            const match =
                row.pull_request_number !== null
                    ? listed.find(m => m.number === row.pull_request_number)
                    : (listed.find(m => m.source === row.branch && m.state === 'open') ??
                      listed.filter(m => m.source === row.branch && !held.has(m.number)).sort((a, b) => b.number - a.number)[0]);
            if (match) {
                found.set(row.id, match);
            }
        }
    }
    return found;
}

const descriptionSection = (title: string, lines: string[]) => (lines.length > 0 ? [`### ${title}`, '', ...lines, ''] : []);

export async function mergeRequestDescription(ctx: UseCaseContext, checked: CheckedChanges): Promise<string> {
    const user = (await gitAuthorOf(ctx))?.name ?? ctx.userId;
    return [
        ...(checked.notes?.length ? [...checked.notes, ''] : []),
        ...descriptionSection(
            'Files',
            (checked.files ?? []).map(f => `- ${f.status} \`${f.path}\``),
        ),
        ...descriptionSection(
            'Flows',
            (checked.flows ?? []).map(f => `- ${f.name}${f.from ? ` (was ${f.from})` : ''}: ${f.changes.join(', ')}`),
        ),
        ...descriptionSection(
            'Warnings',
            (checked.warnings ?? []).flatMap(w => [`- ${w.message}`, ...(w.items ?? []).map(item => `  - ${item}`)]),
        ),
        `Opened from Flowtinus by ${user}.`,
    ].join('\n');
}
