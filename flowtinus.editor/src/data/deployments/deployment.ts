import { deployContent, type FlowFile } from '@flowtinus/core';
import type { ArrivedDisabled } from '@/data/git/git-api';

/*
 * A flow's deploys in this environment (not a promotion to another one): the draft is what the editor edits, saves and
 * runs (Run, Run for real); a deploy freezes it as a new immutable version and makes it the deployed one, the one the
 * triggers (schedules and webhooks) run, and what their Flow Invokers call. Scripts and connection
 * profiles are not frozen: they are the project's, a change applies to every deployed flow.
 */

export type FlowVersion = {
    id: string;
    flowId: string;
    /** 1, 2, 3… per flow */
    number: number;
    /** the draft as it was deployed (never changes) */
    definition: FlowFile;
    createdAt: Date;
    createdBy: string | null;
    createdByName?: string;
    /** with git: the commit it came from, and its message */
    commit?: string | null;
    commitMessage?: string;
};

export type DeploymentAction = 'deploy' | 'rollback' | 'undeploy' | 'emergency-rollback' | 'end-emergency-rollback';

/** one change of what is deployed */
export type DeploymentEvent = {
    action: DeploymentAction;
    /** what was deployed before (null: nothing) */
    fromNumber: number | null;
    /** what is deployed after (null: undeployed) */
    toNumber: number | null;
    at: Date;
    by: string | null;
    byName?: string;
    commit?: string | null;
};

export type FlowDeployments = {
    /** newest first */
    versions: FlowVersion[];
    /** the deployed version, or null (never deployed, or undeployed) */
    deployed: { versionId: string; deployedAt: Date; deployedBy: string | null; deployedByName?: string } | null;
    /** newest first */
    history: DeploymentEvent[];
    /** what deploying the saved draft now would leave broken (a flow it calls that is not deployed); not a refusal */
    warnings?: string[];
    /** with git on: a deploy is a commit to the environment's branch (null until a commit is applied) */
    git?: { branch: string | null; mode: 'direct' | 'pull-request' | 'protected' };
    /** the commit a Commit applied */
    commit?: string;
    arrived?: ArrivedDisabled[];
    /** with git on: the commit the draft could not be merged with; it cannot be committed until it is discarded */
    draftConflict?: string;
    /** with git on: the changed scripts the draft imports (directly or through another script), offered to its Commit */
    changedScripts?: string[];
    triggersChanged?: true;
    /** with git on: this server runs an older version than git's, until a commit changes the flow's content or it is ended */
    emergencyRollback?: EmergencyRollback;
};

export type EmergencyRollback = {
    versionId: string;
    number: number;
    gitVersionId: string;
    gitNumber: number;
    by: string | null;
    byName?: string;
    at: Date;
};

/** a commit as the editor shows it */
export const shortSha = (sha: string) => sha.slice(0, 7);

export const NO_DEPLOYMENTS: FlowDeployments = { versions: [], deployed: null, history: [] };

/** what the top bar's Deploy says: nothing deployed, or the deployed version and whether the draft differs from it */
export type DeployState =
    { kind: 'not-deployed'; lastNumber: number | null } | { kind: 'deployed'; version: FlowVersion; changed: boolean };

export const deployedVersion = (deployments: FlowDeployments): FlowVersion | undefined =>
    deployments.deployed ? deployments.versions.find(v => v.id === deployments.deployed!.versionId) : undefined;

/** the same flow for a deploy (core's deployContent): moving components, groups or pins is not a change */
export const sameFlow = (a: FlowFile, b: FlowFile) => deployContent(a) === deployContent(b);

/** the draft against what is deployed (git's version during an emergency rollback): only what the flow does counts (see sameFlow) */
export function deployState(deployments: FlowDeployments, draft: FlowFile | null): DeployState {
    const version = deployedVersion(deployments);
    if (!version) {
        return { kind: 'not-deployed', lastNumber: deployments.versions[0]?.number ?? null };
    }

    const rollback = deployments.emergencyRollback;
    const base = (rollback && deployments.versions.find(v => v.id === rollback.gitVersionId)) || version;
    return { kind: 'deployed', version, changed: draft !== null && !sameFlow(draft, base.definition) };
}

/** with git on: committing this content ends the emergency rollback by accident, being neither git's version nor what runs */
export function endsEmergencyRollback(deployments: FlowDeployments, content: FlowFile): boolean {
    const rollback = deployments.emergencyRollback;
    return (
        !!rollback &&
        !deployments.versions.some(v => (v.id === rollback.versionId || v.id === rollback.gitVersionId) && sameFlow(v.definition, content))
    );
}

export function nextNumber(deployments: FlowDeployments, draft: FlowFile | null): number {
    const newest = deployments.versions[0];
    return newest && draft && sameFlow(draft, newest.definition) ? newest.number : (newest?.number ?? 0) + 1;
}

/** making a version the deployed one: back to an older one is a rollback, to a newer one (after a rollback) a deploy */
export const switchAction = (deployments: FlowDeployments, to: FlowVersion): 'deploy' | 'rollback' => {
    const current = deployedVersion(deployments);
    return current && to.number < current.number ? 'rollback' : 'deploy';
};

/** one change of what is deployed, as the Versions window lists it */
export function eventText(event: DeploymentEvent): string {
    const was = event.fromNumber !== null ? ` (was v${event.fromNumber})` : '';
    switch (event.action) {
        case 'undeploy':
            return `Undeployed v${event.fromNumber}`;
        case 'rollback':
            return `Rolled back to v${event.toNumber}${was}`;
        case 'emergency-rollback':
            return `Emergency rollback to v${event.toNumber}${was}`;
        case 'end-emergency-rollback':
            if (event.toNumber !== null) {
                return `Ended the emergency rollback of v${event.fromNumber}: back to git's v${event.toNumber}`;
            }
            return event.commit
                ? `Emergency rollback of v${event.fromNumber} ended by commit ${shortSha(event.commit)}`
                : `Emergency rollback of v${event.fromNumber} ended: git turned off`;
        default:
            return `Deployed v${event.toNumber}${was}`;
    }
}
