import { createBrowserRouter, Navigate } from 'react-router';
import { AppShell } from '@/layout/app-shell';
import { FlowEditorPage } from '@/pages/flow-editor/flow-editor-page';
import { FlowsPage } from '@/pages/flows/flows-page';
import { ConnectionsPage } from '@/pages/workspace-connections/connections-page';
import { ProjectFlowsPage } from '@/pages/project-flows/project-flows-page';
import { RunsPage } from '@/pages/runs/runs-page';
import { OldRunLogsUrl, RunPage } from '@/pages/runs/run-page';
import { ScriptsPage } from '@/pages/project-scripts/scripts-page';
import { SecretsPage } from '@/pages/workspace-secrets/secrets-page';
import { WorkersPage } from '@/pages/workers/workers-page';
import { TokensPage } from '@/pages/tokens/tokens-page';
import { WorkspaceSettingsPage } from '@/pages/workspaces/workspace-settings-page';
import { WorkspacesPage } from '@/pages/workspaces/workspaces-page';
import { HomeRedirect, WorkspaceScope } from './workspace-scope';

/**
 * The pages inside the shell (sidebar + top bar): a new page is a new child here and an item in app-sidebar.tsx.
 * A workspace's pages are under /w/:ws (its projects, connections, secrets and variables, settings); a project has
 * tabs: flows, scripts, files. The runs, the workers, the list of workspaces and the user's access tokens are the environment's. The flow editor
 * has the whole screen (its own top bar, no sidebar), so it sits outside the shell. URLs in paths.ts.
 */
export const router = createBrowserRouter([
    {
        path: '/',
        element: <AppShell />,
        children: [
            { index: true, element: <HomeRedirect /> },
            { path: 'workspaces', element: <WorkspacesPage /> },
            {
                path: 'w/:ws',
                element: <WorkspaceScope />,
                children: [
                    { index: true, element: <Navigate to="projects" replace /> },
                    { path: 'projects', element: <FlowsPage /> },
                    { path: 'projects/:projectId', element: <Navigate to="flows" replace /> },
                    { path: 'projects/:projectId/flows', element: <ProjectFlowsPage /> },
                    { path: 'projects/:projectId/scripts', element: <ScriptsPage /> },
                    // Files is coming (its tab shows "Soon"); its screen stays in pages/project-files for when the server stores files
                    { path: 'projects/:projectId/files', element: <Navigate to="../flows" relative="path" replace /> },
                    { path: 'connections', element: <ConnectionsPage /> },
                    { path: 'secrets', element: <SecretsPage /> },
                    { path: 'settings', element: <WorkspaceSettingsPage /> },
                ],
            },
            { path: 'runs', element: <RunsPage /> },
            { path: 'runs/:runId', element: <RunPage /> },
            { path: 'runs/:runId/logs', element: <OldRunLogsUrl /> },
            { path: 'workers', element: <WorkersPage /> },
            { path: 'tokens', element: <TokensPage /> },
        ],
    },
    {
        path: '/w/:ws/projects/:projectId/flows/:flowId',
        element: <WorkspaceScope />,
        children: [{ index: true, element: <FlowEditorPage /> }],
    },
]);
