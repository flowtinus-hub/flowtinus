import type { EmergencyRollback } from '../deployments';

type Rollback = Pick<EmergencyRollback, 'hash' | 'git'>;

export type FlowContent = { deployed: boolean; hash: string } | null;

export const hasGitContent = (rollback: Pick<EmergencyRollback, 'git'>, hash: string) => hash === rollback.git.hash;

export const hasContentThatRuns = (rollback: Pick<EmergencyRollback, 'hash'>, hash: string) => hash === rollback.hash;

export const keepsEmergencyRollback = (rollback: Pick<EmergencyRollback, 'git'>, after: FlowContent) =>
    !!after?.deployed && hasGitContent(rollback, after.hash);

// what runs ends the rollback too, but it is the fix, not an accident
export const endsEmergencyRollbackByAccident = (rollback: Rollback, after: FlowContent) =>
    !keepsEmergencyRollback(rollback, after) && !(after?.deployed && hasContentThatRuns(rollback, after.hash));

export const endsRollbackMessage = (names: string[], environment: string) =>
    `This ends the emergency rollback of ${names.join(', ')} on ${environment}.`;
