import { api, type ApiResult } from '@/lib/api';
import type { FlowDeployments } from './deployment';

/*
 * A flow's deploys in its own environment on flowtinus.server: the versions, the deployed one and the history; deploy
 * the saved draft, deploy (or roll back to) a version, undeploy, replace the draft by a version. Dates come as ISO
 * text and become Date here.
 */

type DeploymentsDto = {
    versions: (Omit<FlowDeployments['versions'][number], 'createdAt'> & { createdAt: string })[];
    deployed: (Omit<NonNullable<FlowDeployments['deployed']>, 'deployedAt'> & { deployedAt: string }) | null;
    history: (Omit<FlowDeployments['history'][number], 'at'> & { at: string })[];
    warnings?: string[];
    git?: { branch: string | null };
    commit?: string;
};

export const toDeployments = (dto: DeploymentsDto): FlowDeployments => ({
    versions: dto.versions.map(v => ({ ...v, createdAt: new Date(v.createdAt) })),
    deployed: dto.deployed ? { ...dto.deployed, deployedAt: new Date(dto.deployed.deployedAt) } : null,
    history: dto.history.map(e => ({ ...e, at: new Date(e.at) })),
    ...(dto.warnings ? { warnings: dto.warnings } : {}),
    ...(dto.git ? { git: dto.git } : {}),
    ...(dto.commit ? { commit: dto.commit } : {}),
});

async function deployments(path: string, method = 'POST', body?: unknown): Promise<ApiResult<FlowDeployments>> {
    const result = await api<DeploymentsDto>(path, { method, body });
    return result.ok ? { ok: true, value: toDeployments(result.value) } : result;
}

/** the flow's versions, the deployed one and the history */
export const getDeployments = (flowId: string) => deployments(`/flows/${flowId}/deployments`, 'GET');

/**
 * deploys the saved draft as a new version (refused when it is not a valid flow, or is the deployed version already);
 * with git on, a commit of the draft with this message, which the reconcile deploys
 */
export const deployFlow = (flowId: string, message?: string) =>
    deployments(`/flows/${flowId}/deploy`, 'POST', message ? { message } : undefined);

/** makes an existing version the deployed one (an older one: a rollback) */
export const deployVersion = (flowId: string, versionId: string) => deployments(`/flows/${flowId}/versions/${versionId}/deploy`);

/** nothing deployed anymore (its versions stay) */
export const undeployFlow = (flowId: string) => deployments(`/flows/${flowId}/undeploy`);

/** replaces the draft by a version's flow (the draft as it is now is lost) */
export function restoreDraft(flowId: string, versionId: string): Promise<ApiResult<{ revision: number }>> {
    return api<{ revision: number }>(`/flows/${flowId}/versions/${versionId}/restore-draft`, { method: 'POST' });
}
