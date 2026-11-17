import { and, eq } from 'drizzle-orm';
import { folderPath, repoFlowToYaml, repoPath, type FlowFile } from '@flowtinus/core';
import type { Flow } from '#features/flows/flow';
import { loadTree } from '#features/folders/project-tree';
import { projects } from '#features/projects/project';
import { workspaces } from '#features/workspaces/workspace';
import type { Database } from '#shared/database/database';
import type { GitChanges } from './git-commits';

/** where the flow's file is in the repository, from the names of its workspace, project and folders as they are now */
export async function flowRepoPath(
    db: Database,
    workspaceId: string,
    flow: Pick<Flow, 'projectId' | 'folderId' | 'name'>,
): Promise<string> {
    const [[workspace], [project], tree] = await Promise.all([
        db.orm.select({ slug: workspaces.slug }).from(workspaces).where(eq(workspaces.id, workspaceId)),
        db.orm
            .select({ name: projects.name })
            .from(projects)
            .where(and(eq(projects.workspaceId, workspaceId), eq(projects.id, flow.projectId))),
        loadTree(db, workspaceId, flow.projectId),
    ]);
    const folders = folderPath(tree.folders, flow.folderId).map(f => f.name);
    return repoPath.flow(workspace!.slug, project!.name, folders, flow.name);
}

/** the flow's file holding a version's definition, deployed or not */
export async function flowFileChange(
    db: Database,
    workspaceId: string,
    flow: Pick<Flow, 'id' | 'projectId' | 'folderId' | 'name'>,
    definition: FlowFile,
    deployed: boolean,
): Promise<GitChanges> {
    return { [await flowRepoPath(db, workspaceId, flow)]: repoFlowToYaml({ ...definition, id: flow.id }, { deployed }) };
}
