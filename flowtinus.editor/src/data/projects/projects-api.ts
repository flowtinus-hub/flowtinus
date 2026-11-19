import { api, type ApiResult } from '@/lib/api';
import { DEFAULT_PROJECT_COLOR, DEFAULT_PROJECT_ICON, isProjectColor, isProjectIcon } from './project-appearance';
import type { NewProject, Project } from './project';

export type ProjectStatus = 'active' | 'archived';

/** a project as the api answers it (dates as ISO text) */
type ProjectDto = Omit<Project, 'icon' | 'color' | 'createdAt' | 'archivedAt'> & {
    icon: string;
    color: string;
    createdAt: string;
    archivedAt: string | null;
};

/** the dto as the screens use it; an icon or color this editor does not know shows as the default */
export function toProject(dto: ProjectDto): Project {
    return {
        id: dto.id,
        name: dto.name,
        description: dto.description,
        icon: isProjectIcon(dto.icon) ? dto.icon : DEFAULT_PROJECT_ICON,
        color: isProjectColor(dto.color) ? dto.color : DEFAULT_PROJECT_COLOR,
        createdAt: new Date(dto.createdAt),
        archivedAt: dto.archivedAt ? new Date(dto.archivedAt) : null,
        ...(dto.summary ? { summary: dto.summary } : {}),
        ...(dto.readOnly ? { readOnly: true } : {}),
    };
}

const asProject = (result: ApiResult<ProjectDto>): ApiResult<Project> =>
    result.ok ? { ok: true, value: toProject(result.value) } : result;

/** active projects newest first, or archived ones last archived first; of the page's workspace unless one is given (its slug) */
export async function listProjects(status: ProjectStatus = 'active', workspace?: string): Promise<ApiResult<Project[]>> {
    const result = await api<{ items: ProjectDto[] }>(`${workspace ? `/w/${workspace}` : ''}/projects?status=${status}`);
    return result.ok ? { ok: true, value: result.value.items.map(toProject) } : result;
}

/** one project, active or archived; error code 'not-found' when it is not the workspace's */
export async function getProject(id: string): Promise<ApiResult<Project>> {
    return asProject(await api<ProjectDto>(`/projects/${id}`));
}

export function createProject(project: NewProject): Promise<ApiResult<{ id: string }>> {
    return api<{ id: string }>('/projects', { method: 'POST', body: project });
}

/** sends only the fields that change */
export async function updateProject(id: string, changes: Partial<NewProject>): Promise<ApiResult<Project>> {
    return asProject(await api<ProjectDto>(`/projects/${id}`, { method: 'PATCH', body: changes }));
}

export function archiveProject(id: string): Promise<ApiResult<{ id: string }>> {
    return api<{ id: string }>(`/projects/${id}/archive`, { method: 'POST' });
}

export async function restoreProject(id: string): Promise<ApiResult<Project>> {
    return asProject(await api<ProjectDto>(`/projects/${id}/restore`, { method: 'POST' }));
}

/**
 * to another workspace of the user (its slug): an admin here, an editor there. Refused ('conflict', with the names per
 * kind in `fields`) while the destination lacks a connection, secret or variable its flows use; its deployed flows are
 * undeployed.
 */
export function moveProject(id: string, toWorkspace: string): Promise<ApiResult<{ id: string; workspace: string; undeployed: number }>> {
    return api(`/projects/${id}/move`, { method: 'POST', body: { toWorkspace } });
}
