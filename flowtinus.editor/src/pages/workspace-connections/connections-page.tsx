import { useState } from 'react';
import { CircleCheck, CircleX, Ellipsis, LoaderCircle, Pencil, Plug, Plus, Trash, TriangleAlert, Zap } from 'lucide-react';
import { connectionServerWarning } from '@flowtinus/core';
import { API_WRITE_DONE } from '@/lib/api';
import { ConfirmDialog, type ConfirmTarget } from '@/components/confirm-dialog';
import { FilterToolbar, NoMatch } from '@/components/filter-toolbar';
import { useUrlFilter } from '@/components/use-url-filter';
import { ResourceView } from '@/components/resource-view';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import type { ProfileFields } from '@/data/connections/connection-profile';
import { CONNECTION_GROUPS, connectionType } from '@/data/connections/connection-types';
import { countByGroup, filterConnections, GROUP_FILTERS, type ConnectionFilter } from '@/data/connections/filter-connections';
import { createConnectionWithSecrets, deleteConnection, listConnections, testConnection, testConnectionDraft, updateConnectionWithSecrets, type NewSecret } from '@/data/connections/connections-api';
import { useWorkspace } from '@/data/workspaces/use-workspace';
import { listSecrets } from '@/data/secrets/secrets-api';
import { useResource } from '@/data/use-resource';
import { formatDateTime } from '@/lib/format';
import { relativeTime } from '@/lib/relative-time';
import { WorkspacePage } from '@/pages/workspaces/workspace-page';
import { ConnectionDialog, type ConnectionDialogTarget } from './connection-dialog';
import { ConnectionTypeIcon } from './connection-type-icon';

type TestResult = { status: 'testing' } | { status: 'ok' | 'failed'; message: string };

/**
 * A workspace's connection profiles (/w/:ws/connections): reusable connections to databases, HTTP APIs, OAuth and
 * SFTP that the flows of all its projects use; their passwords and tokens are the workspace's secrets.
 */
export function ConnectionsPage() {
    const { handle, canEdit } = useWorkspace();
    const connections = useResource(`connections:${handle}`, () => listConnections(), { refreshOn: API_WRITE_DONE });
    const secrets = useResource(`secrets:${handle}`, () => listSecrets());
    const profiles = connections.state.status === 'ready' ? connections.state.value : [];
    const secretList = secrets.state.status === 'ready' ? secrets.state.value : [];
    const readOnly = !canEdit;

    const [dialog, setDialog] = useState<ConnectionDialogTarget | null>(null);
    const [confirm, setConfirm] = useState<ConfirmTarget | null>(null);
    const [tests, setTests] = useState<Record<string, TestResult>>({});

    // the filters live in the URL (?group=database&q=orders): a reload or a link keeps them; typing replaces, not pushes
    const { kind: group, search, setFilter, clear } = useUrlFilter('group', GROUP_FILTERS);
    const filter: ConnectionFilter = { group, search };

    // the connection and the secrets typed in its form are saved together; then the secrets list shows the new ones
    const save = async (fields: ProfileFields, newSecrets: NewSecret[]) => {
        const result = await connections.run(
            dialog?.mode === 'edit'
                ? updateConnectionWithSecrets(dialog.profile.id, fields, newSecrets)
                : createConnectionWithSecrets(fields, newSecrets),
        );
        if (result.ok && newSecrets.length > 0) {
            await secrets.reload();
        }

        return result;
    };

    const test = async (id: string) => {
        setTests(current => ({ ...current, [id]: { status: 'testing' } }));
        const result = await testConnection(id);
        setTests(current => ({
            ...current,
            [id]: result.ok
                ? { status: 'ok', message: `${result.value.message} ${result.value.ms} ms` }
                : { status: 'failed', message: result.error.message },
        }));
        // the server it reached is kept with the connection: the list shows it
        if (result.ok && result.value.server) {
            void connections.reload();
        }
    };

    return (
        <WorkspacePage
            title="Connections"
            actions={
                !readOnly && (
                    <Button onClick={() => setDialog({ mode: 'create' })}>
                        <Plus /> New connection
                    </Button>
                )
            }
        >
            <ResourceView
                state={connections.state}
                onRetry={() => void connections.reload()}
                empty={{ icon: Plug, text: 'No connections yet.' }}
                isEmpty={value => value.length === 0}
            >
                {all => {
                    const value = filterConnections(all, filter);
                    const counts = countByGroup(all, filter.search);
                    return (
                        <div className="grid gap-6">
                            <FilterToolbar
                                searchLabel="Search connections"
                                search={search}
                                kind={group}
                                kindLabel="Group"
                                kinds={[
                                    { value: 'all', label: 'All', count: counts.all },
                                    ...CONNECTION_GROUPS.map(g => ({ value: g.group, label: g.label, count: counts[g.group] })),
                                ]}
                                onChange={changes => setFilter(changes)}
                            />
                            {value.length === 0 && <NoMatch text="No connections match." onClear={clear} />}
                            {CONNECTION_GROUPS.map(({ group, label }) => ({
                                group,
                                label,
                                items: value.filter(p => connectionType(p.type).group === group),
                            }))
                                .filter(section => section.items.length > 0)
                                .map(section => (
                                    <section key={section.group} className="grid gap-2">
                                        <h2 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
                                            {section.label}
                                        </h2>
                                        <ul className="divide-y overflow-hidden rounded-xl border bg-card">
                                            {section.items.map(profile => {
                                                const kind = connectionType(profile.type);
                                                const result = tests[profile.id];
                                                // a "Redshift" that answers as PostgreSQL: it works, but its SQL is another's
                                                const warning = connectionServerWarning(profile.type, profile.server);
                                                return (
                                                    <li key={profile.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                                                        <ConnectionTypeIcon type={profile.type} className="size-5" />
                                                        <div className="grid min-w-0 flex-1">
                                                            <span className="truncate font-medium">{profile.name}</span>
                                                            <span className="truncate text-xs text-muted-foreground">
                                                                {kind.label}
                                                                {kind.summary(profile.config) && ` · ${kind.summary(profile.config)}`}
                                                                {profile.server && (
                                                                    <span
                                                                        title={`Tested ${formatDateTime(new Date(profile.server.testedAt))}`}
                                                                    >{` · ${profile.server.engine} ${profile.server.version}`}</span>
                                                                )}
                                                            </span>
                                                        </div>
                                                        {warning && (
                                                            <TriangleAlert
                                                                role="img"
                                                                aria-label={warning}
                                                                className="size-4 shrink-0 text-amber-600 dark:text-amber-400"
                                                            >
                                                                <title>{warning}</title>
                                                            </TriangleAlert>
                                                        )}
                                                        {result && (
                                                            <span
                                                                role="status"
                                                                className={`flex items-center gap-1.5 text-xs ${result.status === 'failed' ? 'text-destructive' : result.status === 'ok' ? 'text-green-600 dark:text-green-400' : 'text-muted-foreground'}`}
                                                            >
                                                                {result.status === 'testing' && (
                                                                    <LoaderCircle className="size-4 animate-spin" />
                                                                )}
                                                                {result.status === 'ok' && <CircleCheck className="size-4" />}
                                                                {result.status === 'failed' && <CircleX className="size-4" />}
                                                                {result.status === 'testing' ? 'Testing…' : result.message}
                                                            </span>
                                                        )}
                                                        <span
                                                            className="hidden w-48 shrink-0 text-right text-xs text-muted-foreground md:inline"
                                                            title={formatDateTime(profile.updatedAt)}
                                                        >
                                                            Updated {relativeTime(profile.updatedAt)} by{' '}
                                                            {profile.updatedByName ?? profile.updatedBy}
                                                        </span>
                                                        <DropdownMenu>
                                                            <DropdownMenuTrigger asChild>
                                                                <Button
                                                                    variant="ghost"
                                                                    size="icon"
                                                                    className="size-8 shrink-0"
                                                                    aria-label={`Actions for ${profile.name}`}
                                                                >
                                                                    <Ellipsis />
                                                                </Button>
                                                            </DropdownMenuTrigger>
                                                            <DropdownMenuContent align="end">
                                                                <DropdownMenuItem onSelect={() => void test(profile.id)}>
                                                                    <Zap /> Test connection
                                                                </DropdownMenuItem>
                                                                {!readOnly && (
                                                                    <>
                                                                        <DropdownMenuItem
                                                                            onSelect={() => setDialog({ mode: 'edit', profile })}
                                                                        >
                                                                            <Pencil /> Edit
                                                                        </DropdownMenuItem>
                                                                        <DropdownMenuItem
                                                                            variant="destructive"
                                                                            onSelect={() =>
                                                                                setConfirm({
                                                                                    title: `Delete ${profile.name}?`,
                                                                                    description:
                                                                                        'Flows that use this connection will fail until they use another one. Its secrets stay.',
                                                                                    confirmLabel: 'Delete',
                                                                                    busyLabel: 'Deleting...',
                                                                                    destructive: true,
                                                                                    onConfirm: () =>
                                                                                        connections.run(deleteConnection(profile.id)),
                                                                                })
                                                                            }
                                                                        >
                                                                            <Trash /> Delete
                                                                        </DropdownMenuItem>
                                                                    </>
                                                                )}
                                                            </DropdownMenuContent>
                                                        </DropdownMenu>
                                                    </li>
                                                );
                                            })}
                                        </ul>
                                    </section>
                                ))}
                        </div>
                    );
                }}
            </ResourceView>

            <ConnectionDialog
                target={dialog}
                profiles={profiles}
                secrets={secretList}
                onClose={() => setDialog(null)}
                onSave={save}
                onTest={(fields, newSecrets) => testConnectionDraft(fields, newSecrets)}
            />
            <ConfirmDialog target={confirm} onClose={() => setConfirm(null)} />
        </WorkspacePage>
    );
}
