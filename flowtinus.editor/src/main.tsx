import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router';
import { TooltipProvider } from '@/components/ui/tooltip';
import { ThemeProvider } from '@/theme/theme-provider';
import { router } from '@/app/router';
import { MeProvider } from '@/data/workspaces/use-workspace';
import { reloadStaleRestores } from '@/layout/branch-landing';
import './index.css';

reloadStaleRestores();

createRoot(document.getElementById('root')!).render(
    <StrictMode>
        <ThemeProvider>
            <TooltipProvider>
                <MeProvider>
                    <RouterProvider router={router} />
                </MeProvider>
            </TooltipProvider>
        </ThemeProvider>
    </StrictMode>,
);
