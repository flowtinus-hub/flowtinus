import { folderPath, isFolderVisible } from '@flowtinus/core';
import { GetProjectContentsHandler } from '#features/folders/get-project-contents/get-project-contents-handler';
import { defineTool, failed, id, mcpEmergencyRollback, ok } from './tool';

export const getProjectContents = defineTool({
    name: 'get_project_contents',
    scope: 'flows:read',
    description:
        "A project's active folders and flows (id, name, folder path, deployed version, worker tag). With git on, a flow's emergencyRollback means this server runs deployedVersion instead of git's version (runningVersion, gitVersion, by, at).",
    input: { projectId: id('the project, from list_projects or resolve_url') },
    run: async ({ projectId }, t) => {
        const result = await new GetProjectContentsHandler().handle({ projectId }, t.ctx);
        if (!result.ok) {
            return failed(result.error);
        }
        const folders = result.value.folders.filter(f => !f.archivedAt && isFolderVisible(result.value.folders, f.id));
        const pathOf = (folderId: string | null) =>
            folderPath(folders, folderId)
                .map(f => f.name)
                .join('/');
        return ok({
            folders: folders.map(f => ({ id: f.id, name: f.name, parentId: f.parentId, path: pathOf(f.id) })),
            flows: result.value.flows
                .filter(f => !f.archivedAt && isFolderVisible(result.value.folders, f.folderId))
                .map(f => ({
                    id: f.id,
                    name: f.name,
                    folderId: f.folderId,
                    folder: pathOf(f.folderId),
                    workerTag: f.workerTag,
                    deployedVersion: f.deployedVersion,
                    ...(f.emergencyRollback ? { emergencyRollback: mcpEmergencyRollback(f.emergencyRollback) } : {}),
                    ...t.flowLink(projectId, f.id),
                })),
        });
    },
});
