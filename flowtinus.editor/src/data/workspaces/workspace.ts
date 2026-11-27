import { HANDLE } from '@flowtinus/core';
import { isProjectColor, isProjectIcon, type ProjectColorName, type ProjectIconName } from '@/data/projects/project-appearance';

/*
 * Workspaces as the editor sees them (workspaces-api.ts loads and saves them on flowtinus.server): what holds projects
 * and, for all of them, connection profiles, secrets and variables. The handle is what the urls carry (/w/<handle>/...): typed
 * when the workspace is created (suggested from the name), never changed. Icons and colors are the projects' (same list).
 */

/** what a member may do: a viewer reads, an editor also changes and runs, an admin also manages the workspace */
export type WorkspaceRole = 'viewer' | 'editor' | 'admin';

export type Workspace = {
    id: string;
    handle: string;
    name: string;
    description: string;
    icon: ProjectIconName;
    color: ProjectColorName;
    createdAt: Date;
    archivedAt: Date | null;
    /** the user's role in it */
    role: WorkspaceRole;
    /** what it holds (the list has it) */
    summary?: WorkspaceSummary;
    gone?: Date;
};

export type WorkspaceSummary = { projects: number; connections: number; secrets: number; variables: number; members: number };

/** a workspace of the user, as /me lists them */
export type Membership = { workspaceId: string; handle: string; name: string; role: WorkspaceRole };

/** who is using the editor: an admin of the environment creates workspaces */
export type Me = { id: string; name: string; email: string; handle: string; isAdmin: boolean; workspaces: Membership[] };

export type Member = { userId: string; name: string; email: string; role: WorkspaceRole; createdAt: Date };

export const ROLE_LABEL: Record<WorkspaceRole, string> = { viewer: 'Viewer', editor: 'Editor', admin: 'Admin' };

const ORDER: WorkspaceRole[] = ['viewer', 'editor', 'admin'];

/** whether `role` is at least `required` (viewer < editor < admin) */
export const roleAtLeast = (role: WorkspaceRole | undefined, required: WorkspaceRole) =>
    role !== undefined && ORDER.indexOf(role) >= ORDER.indexOf(required);

export type NewWorkspace = { handle: string; name: string; description: string; icon: ProjectIconName; color: ProjectColorName };

/** the form's errors (the server checks again): the handle's rule, a name */
export function validateNewWorkspace(fields: Pick<NewWorkspace, 'handle' | 'name'>): Partial<Record<'handle' | 'name', string>> {
    const errors: Partial<Record<'handle' | 'name', string>> = {};
    if (!fields.name.trim()) {
        errors.name = 'Required';
    } else if (fields.name.trim().length > 100) {
        errors.name = 'At most 100 characters';
    }
    if (!fields.handle) {
        errors.handle = 'Required';
    } else if (!HANDLE.test(fields.handle)) {
        errors.handle = 'Lowercase letters, digits and hyphens; not starting or ending with a hyphen';
    }
    return errors;
}

export const appearanceOf = (dto: { icon: string; color: string }): { icon: ProjectIconName; color: ProjectColorName } => ({
    icon: isProjectIcon(dto.icon) ? dto.icon : 'layers',
    color: isProjectColor(dto.color) ? dto.color : 'blue',
});
