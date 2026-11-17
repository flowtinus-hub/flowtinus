import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { Archive, ArchiveRestore, Trash, Users } from 'lucide-react';
import { WORKSPACES_PATH } from '@/app/paths';
import { ConfirmDialog, type ConfirmTarget } from '@/components/confirm-dialog';
import { ResourceView } from '@/components/resource-view';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useResource } from '@/data/use-resource';
import { useMe, useWorkspace } from '@/data/workspaces/use-workspace';
import { ROLE_LABEL, type Member, type Workspace, type WorkspaceRole } from '@/data/workspaces/workspace';
import { addMember, archiveWorkspace, getWorkspace, listMembers, removeMember, restoreWorkspace, updateMember, updateWorkspace } from '@/data/workspaces/workspaces-api';
import { GitSection } from './git-section';
import { WorkspacePage } from './workspace-page';

const ROLES: WorkspaceRole[] = ['viewer', 'editor', 'admin'];

const ROLE_HELP: Record<WorkspaceRole, string> = {
    viewer: 'reads projects, flows, runs and the names of connections, secrets and variables',
    editor: 'also creates and changes them, deploys and runs',
    admin: 'also changes the workspace and its members',
};

/**
 * A workspace's settings (/w/:ws/settings): its name and description (its ID never changes), archiving it (only once all
 * its projects are archived) or restoring it, and its members with their roles. Only its admins change anything here.
 */
export function WorkspaceSettingsPage() {
    // the role from the workspace itself: an archived one is not in /me, and its admins restore it here
    const { slug } = useWorkspace();
    const workspace = useResource(`workspace:${slug}`, () => getWorkspace(slug));

    return (
        <WorkspacePage title="Settings">
            <ResourceView state={workspace.state} onRetry={workspace.reload} empty={{ icon: Users, text: '' }} isEmpty={() => false}>
                {value => (
                    <div className="grid max-w-3xl gap-10">
                        <WorkspaceFields
                            workspace={value}
                            readOnly={value.role !== 'admin' || value.archivedAt !== null}
                            onSaved={workspace.reload}
                        />
                        <Members slug={slug} readOnly={value.role !== 'admin' || value.archivedAt !== null} />
                        <GitSection slug={slug} readOnly={value.role !== 'admin' || value.archivedAt !== null} />
                        {value.role === 'admin' && <ArchiveSection workspace={value} onChanged={workspace.reload} />}
                    </div>
                )}
            </ResourceView>
        </WorkspacePage>
    );
}

function WorkspaceFields({ workspace, readOnly, onSaved }: { workspace: Workspace; readOnly: boolean; onSaved: () => Promise<void> }) {
    const { reload } = useMe();
    const [name, setName] = useState(workspace.name);
    const [description, setDescription] = useState(workspace.description);
    const [message, setMessage] = useState('');
    const [saving, setSaving] = useState(false);

    const save = async (event: FormEvent) => {
        event.preventDefault();
        setSaving(true);
        const result = await updateWorkspace(workspace.slug, { name: name.trim(), description: description.trim() });
        setSaving(false);
        setMessage(result.ok ? 'Saved.' : (result.error.fields?.name ?? result.error.message));
        if (result.ok) {
            await Promise.all([reload(), onSaved()]);
        }
    };

    return (
        <form onSubmit={save} className="grid gap-4">
            <h2 className="text-lg font-semibold">Workspace</h2>
            <div className="grid gap-2">
                <Label htmlFor="ws-name">Name</Label>
                <Input id="ws-name" value={name} maxLength={100} disabled={readOnly} onChange={e => setName(e.target.value)} />
            </div>
            <div className="grid gap-2">
                <Label htmlFor="ws-slug">ID</Label>
                <Input id="ws-slug" value={workspace.slug} disabled className="font-mono" />
                <p className="text-xs text-muted-foreground">In its addresses (/w/{workspace.slug}/...); it never changes.</p>
            </div>
            <div className="grid gap-2">
                <Label htmlFor="ws-description">Description</Label>
                <Textarea
                    id="ws-description"
                    value={description}
                    maxLength={500}
                    disabled={readOnly}
                    onChange={e => setDescription(e.target.value)}
                />
            </div>
            {!readOnly && (
                <div className="flex items-center gap-3">
                    <Button type="submit" disabled={saving || !name.trim()}>
                        {saving ? 'Saving...' : 'Save'}
                    </Button>
                    {message && <span className="text-sm text-muted-foreground">{message}</span>}
                </div>
            )}
        </form>
    );
}

function Members({ slug, readOnly }: { slug: string; readOnly: boolean }) {
    const members = useResource(`members:${slug}`, () => listMembers(slug));
    const [email, setEmail] = useState('');
    const [role, setRole] = useState<WorkspaceRole>('editor');
    const [error, setError] = useState('');
    const [confirm, setConfirm] = useState<ConfirmTarget | null>(null);

    const add = async (event: FormEvent) => {
        event.preventDefault();
        const result = await members.run(addMember(slug, email.trim(), role));
        setError(result.ok ? '' : (result.error.fields?.email ?? result.error.message));
        if (result.ok) {
            setEmail('');
        }
    };

    const change = async (member: Member, next: WorkspaceRole) => {
        const result = await members.run(updateMember(slug, member.userId, next));
        setError(result.ok ? '' : result.error.message);
    };

    return (
        <section className="grid gap-4">
            <div>
                <h2 className="text-lg font-semibold">Members</h2>
                <p className="text-sm text-muted-foreground">{ROLES.map(r => `${ROLE_LABEL[r]}: ${ROLE_HELP[r]}`).join('. ')}.</p>
            </div>
            <ResourceView
                state={members.state}
                onRetry={members.reload}
                empty={{ icon: Users, text: 'No members.' }}
                isEmpty={list => list.length === 0}
            >
                {list => (
                    <ul className="divide-y rounded-lg border">
                        {list.map(member => (
                            <li key={member.userId} className="flex items-center gap-3 px-4 py-2 text-sm">
                                <div className="grid min-w-0 flex-1">
                                    <span className="truncate font-medium">{member.name}</span>
                                    <span className="truncate text-xs text-muted-foreground">{member.email}</span>
                                </div>
                                {readOnly ? (
                                    <span className="text-muted-foreground">{ROLE_LABEL[member.role]}</span>
                                ) : (
                                    <>
                                        <select
                                            aria-label={`Role of ${member.name}`}
                                            className="h-8 rounded-md border bg-background px-2 text-sm"
                                            value={member.role}
                                            onChange={e => void change(member, e.target.value as WorkspaceRole)}
                                        >
                                            {ROLES.map(r => (
                                                <option key={r} value={r}>
                                                    {ROLE_LABEL[r]}
                                                </option>
                                            ))}
                                        </select>
                                        <Button
                                            variant="ghost"
                                            size="icon"
                                            aria-label={`Remove ${member.name}`}
                                            onClick={() =>
                                                setConfirm({
                                                    title: `Remove ${member.name}?`,
                                                    description: 'They will no longer see this workspace.',
                                                    confirmLabel: 'Remove',
                                                    busyLabel: 'Removing...',
                                                    destructive: true,
                                                    onConfirm: () => members.run(removeMember(slug, member.userId)),
                                                })
                                            }
                                        >
                                            <Trash />
                                        </Button>
                                    </>
                                )}
                            </li>
                        ))}
                    </ul>
                )}
            </ResourceView>
            {!readOnly && (
                <form onSubmit={add} className="flex flex-wrap items-end gap-2">
                    <div className="grid flex-1 gap-2">
                        <Label htmlFor="member-email">Add a member (a user of this environment, by email)</Label>
                        <Input id="member-email" type="email" value={email} onChange={e => setEmail(e.target.value)} />
                    </div>
                    <select
                        aria-label="Role"
                        className="h-9 rounded-md border bg-background px-2 text-sm"
                        value={role}
                        onChange={e => setRole(e.target.value as WorkspaceRole)}
                    >
                        {ROLES.map(r => (
                            <option key={r} value={r}>
                                {ROLE_LABEL[r]}
                            </option>
                        ))}
                    </select>
                    <Button type="submit" disabled={!email.trim()}>
                        Add
                    </Button>
                </form>
            )}
            {error && <p className="text-sm text-destructive">{error}</p>}
            <ConfirmDialog target={confirm} onClose={() => setConfirm(null)} />
        </section>
    );
}

function ArchiveSection({ workspace, onChanged }: { workspace: Workspace; onChanged: () => Promise<void> }) {
    const navigate = useNavigate();
    const { reload } = useMe();
    const [confirm, setConfirm] = useState<ConfirmTarget | null>(null);
    const archived = workspace.archivedAt !== null;

    return (
        <section className="grid gap-3">
            <h2 className="text-lg font-semibold">{archived ? 'Archived' : 'Archive'}</h2>
            <p className="text-sm text-muted-foreground">
                {archived
                    ? 'This workspace is archived: its pages are closed and its schedules and webhooks do not fire. Restore it to use it again.'
                    : 'Only a workspace whose projects are all archived can be archived. Its schedules and webhooks stop firing.'}
            </p>
            <div>
                {archived ? (
                    <Button
                        variant="outline"
                        onClick={async () => {
                            const result = await restoreWorkspace(workspace.slug);
                            if (result.ok) {
                                await Promise.all([reload(), onChanged()]);
                            }
                        }}
                    >
                        <ArchiveRestore /> Restore
                    </Button>
                ) : (
                    <Button
                        variant="outline"
                        onClick={() =>
                            setConfirm({
                                title: `Archive ${workspace.name}?`,
                                description: 'Its members will no longer open it until an admin restores it.',
                                confirmLabel: 'Archive',
                                busyLabel: 'Archiving...',
                                destructive: true,
                                onConfirm: async () => {
                                    const result = await archiveWorkspace(workspace.slug);
                                    if (result.ok) {
                                        await reload();
                                        navigate(WORKSPACES_PATH);
                                    }
                                    return result;
                                },
                            })
                        }
                    >
                        <Archive /> Archive workspace
                    </Button>
                )}
            </div>
            <ConfirmDialog target={confirm} onClose={() => setConfirm(null)} />
        </section>
    );
}
