import { z } from 'zod';
import { CreateFolderHandler } from '#features/folders/create-folder/create-folder-handler';
import { answer, defineTool, id } from './tool';

export const createFolder = defineTool({
    name: 'create_folder',
    scope: 'projects:write',
    description: 'Creates a folder in a project (in another folder with parentFolderId).',
    input: {
        projectId: id('the project'),
        name: z.string().describe('its name, unique among its siblings'),
        parentFolderId: id('the folder it goes in; omit for the root').optional(),
    },
    annotations: { destructiveHint: false },
    editsBranch: true,
    run: async ({ projectId, name, parentFolderId }, t) =>
        answer(await new CreateFolderHandler().handle({ projectId, name, parentId: parentFolderId ?? null }, t.ctx), v => ({
            folderId: v.id,
        })),
});
