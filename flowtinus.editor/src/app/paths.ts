/**
 * The app's URLs, in one place: every link and the router use these. A workspace's pages are under /w/<its handle>; the
 * runs, the workers and the list of workspaces are the environment's.
 */

/** the user's workspaces (cards) */
export const WORKSPACES_PATH = '/workspaces';

/** a workspace's home: its projects */
export const workspacePath = (ws: string) => `/w/${ws}`;

/** a workspace's projects */
export const projectsPath = (ws: string) => `/w/${ws}/projects`;

/** a workspace's connection profiles (for all its projects) */
export const connectionsPath = (ws: string) => `/w/${ws}/connections`;

/** a workspace's secrets and variables (for all its projects) */
export const secretsPath = (ws: string) => `/w/${ws}/secrets`;

/** with git on: every environment of the topology side by side, as git says, with this server */
export const environmentsPath = (ws: string) => `/w/${ws}/environments`;

/** a workspace's name, description, icon, color and members */
export const workspaceSettingsPath = (ws: string) => `/w/${ws}/settings`;

/** the run history of the user's workspaces; a link to a run is ?q=<its id> (its tree only, that run chosen) */
export const RUNS_PATH = '/runs';

/** the environment's supervisors and their workers, per tag */
export const WORKERS_PATH = '/workers';

/** the user's personal access tokens (for the MCP): theirs, not a workspace's */
export const TOKENS_PATH = '/tokens';

/** a run's own page: its errors, logs, metrics and data (the tab in ?tab=) */
export const runPath = (runId: string, tab?: string) => `/runs/${runId}${tab ? `?tab=${tab}` : ''}`;

/** the Runs page on a run: only its tree, it chosen */
export const runInHistoryPath = (runId: string) => `/runs?q=${runId}`;

/** the tabs of a project (connections, secrets and variables are the workspace's) */
export type ProjectTab = 'flows' | 'scripts' | 'files';

/** a project's tab (flows by default) */
export const projectTabPath = (ws: string, projectId: string, tab: ProjectTab = 'flows') => `/w/${ws}/projects/${projectId}/${tab}`;

/** a project's folders and flows; `folderId` opens that folder (Cards view) */
export const projectPath = (ws: string, projectId: string, folderId?: string) =>
    `${projectTabPath(ws, projectId, 'flows')}${folderId ? `?folder=${folderId}` : ''}`;

/** a flow in the editor */
export const flowPath = (ws: string, projectId: string, flowId: string) => `/w/${ws}/projects/${projectId}/flows/${flowId}`;

/** a project's script in the Scripts tab */
export const scriptPath = (ws: string, projectId: string, path: string) =>
    `${projectTabPath(ws, projectId, 'scripts')}?script=${encodeURIComponent(path)}`;
