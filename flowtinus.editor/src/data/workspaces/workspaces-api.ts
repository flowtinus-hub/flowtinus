import { api, type ApiResult } from '@/lib/api';
import { appearanceOf, type Me, type Member, type NewWorkspace, type Workspace, type WorkspaceRole } from './workspace';

/* The user and their workspaces (the environment's: /me, /workspaces) and a workspace itself (/w/<handle>). */

type WorkspaceDto = Omit<Workspace, 'icon' | 'color' | 'createdAt' | 'archivedAt' | 'gone'> & {
    icon: string;
    color: string;
    createdAt: string;
    archivedAt: string | null;
    gone?: string | null;
};

export const toWorkspace = ({ gone, ...dto }: WorkspaceDto): Workspace => ({
    ...dto,
    ...appearanceOf(dto),
    createdAt: new Date(dto.createdAt),
    archivedAt: dto.archivedAt ? new Date(dto.archivedAt) : null,
    ...(gone ? { gone: new Date(gone) } : {}),
});

const asWorkspace = (result: ApiResult<WorkspaceDto>): ApiResult<Workspace> =>
    result.ok ? { ok: true, value: toWorkspace(result.value) } : result;

/** who is using the editor and their workspaces, with their role in each */
export const getMe = () => api<Me>('/me');

/** the user's workspaces, active or archived, by name, with what each holds */
export async function listWorkspaces(status: 'active' | 'archived' = 'active'): Promise<ApiResult<Workspace[]>> {
    const result = await api<{ items: WorkspaceDto[] }>(`/workspaces?status=${status}`);
    return result.ok ? { ok: true, value: result.value.items.map(toWorkspace) } : result;
}

/** only for an admin of the environment; who creates it becomes its admin */
export const createWorkspace = (fields: NewWorkspace) =>
    api<{ id: string; handle: string }>('/workspaces', { method: 'POST', body: fields });

export const getWorkspace = async (ws: string) => asWorkspace(await api<WorkspaceDto>(`/w/${ws}`));

/** its name, description, icon or color (admins); the handle never changes */
export const updateWorkspace = async (ws: string, changes: Partial<Omit<NewWorkspace, 'handle'>>) =>
    asWorkspace(await api<WorkspaceDto>(`/w/${ws}`, { method: 'PATCH', body: changes }));

/** only when all its projects are archived */
export const archiveWorkspace = (ws: string) => api<{ id: string }>(`/w/${ws}/archive`, { method: 'POST' });

export const restoreWorkspace = (ws: string) => api<{ id: string }>(`/w/${ws}/restore`, { method: 'POST' });

type MemberDto = Omit<Member, 'createdAt'> & { createdAt: string };

const toMember = (dto: MemberDto): Member => ({ ...dto, createdAt: new Date(dto.createdAt) });

export async function listMembers(ws: string): Promise<ApiResult<Member[]>> {
    const result = await api<{ items: MemberDto[] }>(`/w/${ws}/members`);
    return result.ok ? { ok: true, value: result.value.items.map(toMember) } : result;
}

/** a user of the environment, by email (users are not created here) */
export async function addMember(ws: string, email: string, role: WorkspaceRole): Promise<ApiResult<Member>> {
    const result = await api<MemberDto>(`/w/${ws}/members`, { method: 'POST', body: { email, role } });
    return result.ok ? { ok: true, value: toMember(result.value) } : result;
}

export async function updateMember(ws: string, userId: string, role: WorkspaceRole): Promise<ApiResult<Member>> {
    const result = await api<MemberDto>(`/w/${ws}/members/${userId}`, { method: 'PATCH', body: { role } });
    return result.ok ? { ok: true, value: toMember(result.value) } : result;
}

export const removeMember = (ws: string, userId: string) => api<{ userId: string }>(`/w/${ws}/members/${userId}`, { method: 'DELETE' });
