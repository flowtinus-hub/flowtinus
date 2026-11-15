import { useState } from 'react';
import { Ellipsis, Folder as FolderIcon, KeySquare, Plus, Trash, Workflow } from 'lucide-react';
import { ConfirmDialog, type ConfirmTarget } from '@/components/confirm-dialog';
import { ResourceView } from '@/components/resource-view';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { isExpired, runForRealText, type ApiToken, type RunScopeItem, type ScopeInfo } from '@/data/tokens/api-token';
import { createToken, listTokens, revokeToken } from '@/data/tokens/tokens-api';
import { useResource } from '@/data/use-resource';
import { useMe } from '@/data/workspaces/use-workspace';
import { formatDateTime } from '@/lib/format';
import { relativeTime } from '@/lib/relative-time';
import { TokenDialog } from './token-dialog';

/**
 * The user's personal access tokens (/tokens): what an agent sends to the MCP. Theirs only (a token is its user's, not a
 * workspace's): name, scopes, what its runs:execute may run, when it was made and last used; New token shows its value
 * once; Revoke refuses it at once.
 */
export function TokensPage() {
    const tokens = useResource('tokens', () => listTokens());
    const { state: me } = useMe();
    const workspaces = me.status === 'ready' ? me.me.workspaces : [];
    const scopes = tokens.state.status === 'ready' ? tokens.state.value.scopes : [];
    const [creating, setCreating] = useState(false);
    const [confirm, setConfirm] = useState<ConfirmTarget | null>(null);
    // what has expired, as of when the page opened
    const [now] = useState(() => new Date());

    return (
        <div className="mx-auto flex w-full max-w-screen-2xl flex-1 flex-col gap-6">
            <div className="flex flex-wrap items-center justify-between gap-4">
                <h1 className="text-2xl font-semibold tracking-tight">Access tokens</h1>
                <Button onClick={() => setCreating(true)}>
                    <Plus /> New token
                </Button>
            </div>

            <ResourceView
                state={tokens.state}
                onRetry={() => void tokens.reload()}
                empty={{ icon: KeySquare, text: 'No access tokens yet.' }}
                isEmpty={value => value.items.length === 0}
            >
                {value => (
                    <TokenList
                        now={now}
                        tokens={value.items}
                        scopes={value.scopes}
                        onRevoke={token =>
                            setConfirm({
                                title: `Revoke ${token.name}?`,
                                description: `Agents using ${token.prefix}… lose access at once.`,
                                confirmLabel: 'Revoke',
                                busyLabel: 'Revoking...',
                                destructive: true,
                                onConfirm: () => tokens.run(revokeToken(token.id)),
                            })
                        }
                    />
                )}
            </ResourceView>

            <TokenDialog
                open={creating}
                scopes={scopes}
                workspaces={workspaces}
                onClose={() => setCreating(false)}
                onCreate={token => tokens.run(createToken(token))}
            />
            <ConfirmDialog target={confirm} onClose={() => setConfirm(null)} />
        </div>
    );
}

/** the tokens, each with its scopes, its run for real, its dates and Revoke */
export function TokenList({
    tokens,
    scopes,
    onRevoke,
    now,
}: {
    tokens: ApiToken[];
    scopes: ScopeInfo[];
    onRevoke: (token: ApiToken) => void;
    now: Date;
}) {
    const describe = (scope: string) => scopes.find(s => s.scope === scope)?.description ?? scope;
    return (
        <ul className="divide-y overflow-hidden rounded-xl border bg-card">
            {tokens.map(token => (
                <li key={token.id} className="flex flex-wrap items-start gap-3 px-4 py-3">
                    <KeySquare className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
                    <div className="grid min-w-0 flex-1 gap-1.5">
                        <span className="flex flex-wrap items-baseline gap-2">
                            <span className="font-medium">{token.name}</span>
                            <span className="font-mono text-xs text-muted-foreground">{token.prefix}…</span>
                            {isExpired(token, now) && (
                                <span className="rounded bg-destructive/10 px-1.5 text-xs text-destructive">Expired</span>
                            )}
                        </span>
                        <span className="flex flex-wrap gap-1" aria-label="Scopes">
                            {token.scopes.map(scope => (
                                <span key={scope} title={describe(scope)} className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-xs">
                                    {scope}
                                </span>
                            ))}
                        </span>
                        <RunForReal token={token} />
                    </div>
                    <span className="hidden w-56 shrink-0 text-right text-xs text-muted-foreground md:grid">
                        <span title={formatDateTime(token.createdAt)}>Created {relativeTime(token.createdAt)}</span>
                        <span title={token.lastUsedAt ? formatDateTime(token.lastUsedAt) : undefined}>
                            {token.lastUsedAt ? `Last used ${relativeTime(token.lastUsedAt)}` : 'Never used'}
                        </span>
                        {token.expiresAt && (
                            <span title={formatDateTime(token.expiresAt)}>
                                {isExpired(token, now) ? 'Expired' : 'Expires'} {relativeTime(token.expiresAt)}
                            </span>
                        )}
                    </span>
                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon" className="size-8 shrink-0" aria-label={`Actions for ${token.name}`}>
                                <Ellipsis />
                            </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                            <DropdownMenuItem variant="destructive" onSelect={() => onRevoke(token)}>
                                <Trash /> Revoke
                            </DropdownMenuItem>
                        </DropdownMenuContent>
                    </DropdownMenu>
                </li>
            ))}
        </ul>
    );
}

/** what the token may run for real: none, any flow (with approval), or its folders and flows */
function RunForReal({ token }: { token: ApiToken }) {
    const items: (RunScopeItem & { kind: 'folder' | 'flow' })[] = token.runScope
        ? [
              ...token.runScope.folders.map(f => ({ ...f, kind: 'folder' as const })),
              ...token.runScope.flows.map(f => ({ ...f, kind: 'flow' as const })),
          ]
        : [];
    return (
        <span className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
            <span>Run for real: {runForRealText(token)}</span>
            {items.map(item => (
                <span
                    key={item.id}
                    title={item.workspace ? `${item.workspace} › ${item.project}` : 'Not available'}
                    className={`flex items-center gap-1 rounded-md border px-1.5 py-0.5 ${item.unavailable ? 'line-through opacity-60' : ''}`}
                >
                    {item.kind === 'folder' ? <FolderIcon className="size-3" /> : <Workflow className="size-3" />}
                    {item.project ? `${item.project} › ${item.path}` : item.path}
                </span>
            ))}
        </span>
    );
}
