import { deployContent, flowChanges } from '@flowtinus/core';
import { gitVersionOf } from '#features/deployments/deployments';
import { GetDeploymentsHandler } from '#features/deployments/get-deployments/get-deployments-handler';
import { defineTool, failed, id, mcpEmergencyRollback, ok } from './tool';

export const getDeployments = defineTool({
    name: 'get_deployments',
    scope: 'flows:read',
    description:
        "What is deployed of a flow (the version schedules and webhooks run) and whether its draft differs from it. With git on, an emergencyRollback means this server runs an older version than git's (runningVersion, gitVersion, by, at) until a commit changes the flow or a person ends it; the draft is then compared with git's version. Deploying is a person's decision in the editor: never through here.",
    input: { flowId: id('the flow') },
    run: async ({ flowId }, t) => {
        const found = await t.flowAndDraft(flowId);
        if (!found.ok) {
            return failed(found.error);
        }
        const result = await new GetDeploymentsHandler().handle({ id: flowId }, t.ctx);
        if (!result.ok) {
            return failed(result.error);
        }
        const { versions, deployed, warnings, emergencyRollback: rollback } = result.value;
        const version = deployed ? versions.find(v => v.id === deployed.versionId) : undefined;
        const base = gitVersionOf(result.value);
        const changes = base ? flowChanges(base.definition, found.value.draft.flow) : null;
        return ok({
            deployedVersion: version?.number ?? null,
            deployedAt: deployed?.deployedAt ?? null,
            versions: versions.map(v => ({ number: v.number, createdAt: v.createdAt })),
            draftDiffersFromDeployed: base ? deployContent(base.definition) !== deployContent(found.value.draft.flow) : null,
            ...(rollback ? { emergencyRollback: mcpEmergencyRollback(rollback) } : {}),
            ...(changes
                ? {
                      changes: {
                          added: changes.added,
                          removed: changes.removed,
                          changed: changes.changed,
                          edgesAdded: changes.edgesAdded.length,
                          edgesRemoved: changes.edgesRemoved.length,
                      },
                  }
                : {}),
            warnings,
        });
    },
});
