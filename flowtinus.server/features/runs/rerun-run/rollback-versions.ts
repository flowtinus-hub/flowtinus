import type { CalledFlow } from '#features/runs/start-run/called-flows';
import type { Database } from '#shared/database/database';
import type { QueuedRun } from '../run-queue';

export type RanVersion = {
    flowId: string;
    name: string;
    number: number;
    called: boolean;
    deployed: boolean;
    inEmergencyRollback: boolean;
    deployedNumber: number | null;
    leftByEmergencyRollback: boolean;
};

/** the versions a run ran: its own and those of the flows it called (a draft run and its called drafts have none) */
export async function ranVersions(db: Database, workspaceId: string, run: QueuedRun): Promise<RanVersion[]> {
    const called = ((run.calledFlows as CalledFlow[] | null) ?? []).filter(c => c.versionId);
    const ran = [
        ...(run.flowVersionId ? [{ flowId: run.flowId, versionId: run.flowVersionId, called: false }] : []),
        ...called.map(c => ({ flowId: c.id, versionId: c.versionId!, called: true })),
    ];
    if (ran.length === 0) {
        return [];
    }

    const rows = await db.query<{
        flow_id: string;
        name: string;
        number: number;
        called: boolean;
        deployed_id: string | null;
        deployed_number: number | null;
        in_rollback: boolean;
        left_by_rollback: boolean;
        version_id: string;
    }>(
        `SELECT x.flow_id, x.version_id, x.called, f.name, v.number, dep.flow_version_id AS deployed_id, d.number AS deployed_number,
         r.flow_id IS NOT NULL AS in_rollback,
         EXISTS (SELECT 1 FROM deployment_history h WHERE h.workspace_id = $1 AND h.flow_id = x.flow_id
           AND h.action = 'emergency-rollback' AND h.from_version_id = x.version_id) AS left_by_rollback
       FROM unnest($2::uuid[], $3::uuid[], $4::boolean[]) WITH ORDINALITY AS x(flow_id, version_id, called, at)
       JOIN flows f ON f.id = x.flow_id AND f.workspace_id = $1
       JOIN flow_versions v ON v.id = x.version_id
       LEFT JOIN deployments dep ON dep.workspace_id = $1 AND dep.flow_id = x.flow_id
       LEFT JOIN flow_versions d ON d.id = dep.flow_version_id
       LEFT JOIN emergency_rollbacks r ON r.workspace_id = $1 AND r.flow_id = x.flow_id
      ORDER BY x.at`,
        [workspaceId, ran.map(r => r.flowId), ran.map(r => r.versionId), ran.map(r => r.called)],
    );
    return rows.map(row => ({
        flowId: row.flow_id,
        name: row.name,
        number: row.number,
        called: row.called,
        deployed: row.deployed_id === row.version_id,
        inEmergencyRollback: row.in_rollback,
        deployedNumber: row.deployed_number,
        leftByEmergencyRollback: row.left_by_rollback,
    }));
}

/** during an emergency rollback, a run of another version than the one that runs would bring back what was rolled back */
export function emergencyRollbackRefusal(ran: RanVersion[]): string | null {
    const other = ran.find(r => r.inEmergencyRollback && !r.deployed);
    if (!other) {
        return null;
    }

    return `${other.name} runs v${other.deployedNumber} in an emergency rollback: this run ${other.called ? 'called' : 'is of'} v${other.number}, it would run that version again.`;
}
