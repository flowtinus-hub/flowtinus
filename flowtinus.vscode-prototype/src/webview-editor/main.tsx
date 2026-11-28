// PROTOTYPE (#86): throwaway. The web editor's own flow page, mounted in the webview with its /api answered by the extension.
import './fetch-shim';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { TooltipProvider } from '@/components/ui/tooltip';
import { ThemeProvider } from '@/theme/theme-provider';
import { MeProvider } from '@/data/workspaces/use-workspace';
import { FlowEditorPage } from '@/pages/flow-editor/flow-editor-page';
import { WorkspaceScope } from '@/app/workspace-scope';
import { HostProvider, type Capability } from '@/host/host';
import '@/index.css';

const route =
    (window as unknown as { FLOWTINUS_ROUTE: string }).FLOWTINUS_ROUTE ?? new URLSearchParams(location.search).get('route') ?? '/';

const router = createMemoryRouter(
    [
        {
            path: '/w/:ws/projects/:projectId/flows/:flowId',
            element: <WorkspaceScope />,
            children: [{ index: true, element: <FlowEditorPage /> }],
        },
    ],
    { initialEntries: [route] },
);

createRoot(document.getElementById('root')!).render(
    <StrictMode>
        <ThemeProvider>
            <TooltipProvider>
                <MeProvider>
                    {/* VS Code edits the flow's file; with a token, Run too (the extension says which, FLOWTINUS_CAN) */}
                    <HostProvider can={(window as unknown as { FLOWTINUS_CAN?: Capability[] }).FLOWTINUS_CAN ?? []}>
                        <RouterProvider router={router} />
                    </HostProvider>
                </MeProvider>
            </TooltipProvider>
        </ThemeProvider>
    </StrictMode>,
);
