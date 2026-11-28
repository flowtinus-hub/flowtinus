// PROTOTYPE (#86): what the page's host offers. The web app offers everything; the VS Code extension only edits the
// flow's file, so what it lacks is hidden (its loads too), and links to other pages become plain labels.
import { createContext, useContext, type ReactNode } from 'react';
import { Link, type LinkProps } from 'react-router';

export type Capability =
    /** links to the app's other pages (projects, folders, runs) */
    | 'navigate'
    | 'run'
    | 'runForReal'
    /** Deploy and Versions */
    | 'deploy'
    /** schedules and webhooks */
    | 'triggers'
    /** the worker tag */
    | 'workers'
    /** the Calls panel (who calls this flow, across the project) */
    | 'calls'
    /** the branch picker, or the local server's HEAD */
    | 'git'
    /** Download and Upload of the flow as a file */
    | 'download';

const ALL: ReadonlySet<Capability> = new Set([
    'navigate',
    'run',
    'runForReal',
    'deploy',
    'triggers',
    'workers',
    'calls',
    'git',
    'download',
]);

const HostContext = createContext<ReadonlySet<Capability>>(ALL);

export function HostProvider({ can, children }: { can: Capability[]; children: ReactNode }) {
    return <HostContext.Provider value={new Set(can)}>{children}</HostContext.Provider>;
}

export const useCan = (capability: Capability) => useContext(HostContext).has(capability);

/** its children where the host offers `do`; the fallback (nothing by default) elsewhere */
export function Can({ do: capability, fallback = null, children }: { do: Capability; fallback?: ReactNode; children: ReactNode }) {
    return <>{useCan(capability) ? children : fallback}</>;
}

/** a link to another page of the app; where the host cannot navigate, the same content as a plain label */
export function AppLink({ children, className, title, ...props }: LinkProps) {
    return useCan('navigate') ? (
        <Link className={className} title={title} {...props}>
            {children}
        </Link>
    ) : (
        <span className={className} title={title}>
            {children}
        </span>
    );
}
