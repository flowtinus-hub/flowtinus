import { isProjectColor, isProjectIcon, type ProjectColorName, type ProjectIconName } from '@/data/projects/project-appearance';

/*
 * Workspaces as the editor sees them (workspaces-api.ts loads and saves them on flowtinus.server): what holds projects
 * and, for all of them, connection profiles, secrets and variables. The slug is what the urls carry (/w/<slug>/...): typed
 * when the workspace is created (suggested from the name), never changed. Icons and colors are the projects' (same list).
 */

/** what a member may do: a viewer reads, an editor also changes and runs, an admin also manages the workspace */
export type WorkspaceRole = 'viewer' | 'editor' | 'admin';

export type Workspace = {
    id: string;
    slug: string;
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
};

export type WorkspaceSummary = { projects: number; connections: number; secrets: number; variables: number; members: number };

/** a workspace of the user, as /me lists them */
export type Membership = { workspaceId: string; slug: string; name: string; role: WorkspaceRole };

/** who is using the editor: an admin of the environment creates workspaces */
export type Me = { id: string; name: string; email: string; handle: string; isAdmin: boolean; workspaces: Membership[] };

export type Member = { userId: string; name: string; email: string; role: WorkspaceRole; createdAt: Date };

export const ROLE_LABEL: Record<WorkspaceRole, string> = { viewer: 'Viewer', editor: 'Editor', admin: 'Admin' };

const ORDER: WorkspaceRole[] = ['viewer', 'editor', 'admin'];

/** whether `role` is at least `required` (viewer < editor < admin) */
export const roleAtLeast = (role: WorkspaceRole | undefined, required: WorkspaceRole) =>
    role !== undefined && ORDER.indexOf(role) >= ORDER.indexOf(required);

/** a slug: lowercase letters, digits and hyphens, 1 to 40, not starting or ending with a hyphen (the server's rule) */
export const WORKSPACE_SLUG = /^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$/;

/** a slug suggested from a name: "My Dev Workspace" → "my-dev-workspace" */
export function slugFromName(name: string): string {
    return name
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40)
        .replace(/-+$/g, '');
}

export type NewWorkspace = { slug: string; name: string; description: string; icon: ProjectIconName; color: ProjectColorName };

/** the form's errors (the server checks again): the slug's rule, a name */
export function validateNewWorkspace(fields: Pick<NewWorkspace, 'slug' | 'name'>): Partial<Record<'slug' | 'name', string>> {
    const errors: Partial<Record<'slug' | 'name', string>> = {};
    if (!fields.name.trim()) {
        errors.name = 'Required';
    } else if (fields.name.trim().length > 100) {
        errors.name = 'At most 100 characters';
    }
    if (!fields.slug) {
        errors.slug = 'Required';
    } else if (!WORKSPACE_SLUG.test(fields.slug)) {
        errors.slug = 'Lowercase letters, digits and hyphens; not starting or ending with a hyphen';
    }
    return errors;
}

export const appearanceOf = (dto: { icon: string; color: string }): { icon: ProjectIconName; color: ProjectColorName } => ({
    icon: isProjectIcon(dto.icon) ? dto.icon : 'layers',
    color: isProjectColor(dto.color) ? dto.color : 'blue',
});
