import { matchPath } from 'react-router';
import { projectsPath } from '@/app/paths';
import { getFlow } from '@/data/flows/flows-api';
import { getProject } from '@/data/projects/projects-api';

/** where a branch switch lands: the same page, or the projects when its flow or project is not on the new branch */
export async function landingAfterSwitch(slug: string): Promise<string> {
    const { pathname, search, hash } = window.location;
    const here = `${pathname}${search}${hash}`;
    const flow = matchPath('/w/:ws/projects/:projectId/flows/:flowId', pathname);
    const project = matchPath('/w/:ws/projects/:projectId/*', pathname);
    const read = flow?.params.flowId
        ? await getFlow(flow.params.flowId)
        : project?.params.projectId
          ? await getProject(project.params.projectId)
          : null;
    return read && !read.ok && read.error.code === 'not-found' ? projectsPath(slug) : here;
}

const SWITCHED_KEY = 'flowtinus.branchSwitchedAt';
const loadedAt = Date.now();

/** a branch switch happened now (in this tab or another): a page loaded before it is stale */
export function noteBranchSwitch(): void {
    try {
        localStorage.setItem(SWITCHED_KEY, String(Date.now()));
    } catch {
        // storage blocked: Back may show the old branch until a refresh
    }
}

/**
 * Back or Forward can restore a page from the browser's back-forward cache as it was, with the branch it was read on;
 * restored after a branch switch, it is read again.
 */
export function reloadStaleRestores(): void {
    window.addEventListener('pageshow', event => {
        if (!event.persisted) {
            return;
        }
        let switchedAt = 0;
        try {
            switchedAt = Number(localStorage.getItem(SWITCHED_KEY) ?? 0);
        } catch {
            return;
        }
        if (switchedAt > loadedAt) {
            window.location.reload();
        }
    });
}
