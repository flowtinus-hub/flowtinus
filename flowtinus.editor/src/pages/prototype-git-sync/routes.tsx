// PROTOTYPE, throwaway: a fully mocked, clickable git sync (docs/GIT-BRAINSTORM.md) at /prototype/git-sync, no api, state in memory.
// One end-to-end mock; ?variant=A|B only switches where the branch picker and the changes panel live.
import type { RouteObject } from 'react-router';
import { EnvironmentsPage } from './environments-page';
import { FlowPage } from './flow-page';
import { ProjectPage, ProjectsPage } from './projects-page';
import { PrPage, ProviderPage, RepoPage } from './provider-page';
import { ConnectionsPage, SettingsPage } from './settings-page';
import { ChangesPage, PrototypeRoot, PrototypeShell } from './shell';

import { PROTOTYPE_GIT_SYNC_PATH } from './path';

export const prototypeGitSyncRoutes: RouteObject[] = [
    {
        path: PROTOTYPE_GIT_SYNC_PATH,
        element: <PrototypeRoot />,
        children: [
            {
                element: <PrototypeShell />,
                children: [
                    { index: true, element: <ProjectsPage /> },
                    { path: 'projects/:project', element: <ProjectPage /> },
                    { path: 'connections', element: <ConnectionsPage /> },
                    { path: 'settings', element: <SettingsPage /> },
                    { path: 'environments', element: <EnvironmentsPage /> },
                    { path: 'repo', element: <RepoPage /> },
                    { path: 'changes', element: <ChangesPage /> },
                    { path: 'provider', element: <ProviderPage /> },
                    { path: 'provider/:number', element: <PrPage /> },
                ],
            },
            { path: 'flows/:flowId', element: <FlowPage /> },
        ],
    },
];
