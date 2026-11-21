import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { projectsPath } from '@/app/paths';
import { Button } from '@/components/ui/button';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useMe } from '@/data/workspaces/use-workspace';
import { handleOf } from '@flowtinus/core';
import { validateNewWorkspace } from '@/data/workspaces/workspace';
import { createWorkspace } from '@/data/workspaces/workspaces-api';

type Props = { open: boolean; onOpenChange: (open: boolean) => void };

const FieldError = ({ message }: { message?: string }) => (message ? <p className="text-sm text-destructive">{message}</p> : null);

/**
 * A new workspace (only an admin of the environment sees this): its name and its ID, the slug of its addresses
 * (/w/<id>/...), suggested from the name while it is not typed, and never changed after. Its creator becomes its admin.
 */
export function NewWorkspaceDialog({ open, onOpenChange }: Props) {
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-md">{open && <NewWorkspaceForm onDone={() => onOpenChange(false)} />}</DialogContent>
        </Dialog>
    );
}

function NewWorkspaceForm({ onDone }: { onDone: () => void }) {
    const navigate = useNavigate();
    const { reload } = useMe();
    const [name, setName] = useState('');
    const [description, setDescription] = useState('');
    // the slug follows the name until the user types one
    const [typedSlug, setTypedSlug] = useState<string | null>(null);
    const slug = typedSlug ?? handleOf(name);
    const [errors, setErrors] = useState<Record<string, string>>({});
    const [failure, setFailure] = useState('');
    const [saving, setSaving] = useState(false);

    const submit = async (event: FormEvent) => {
        event.preventDefault();
        const found = validateNewWorkspace({ name, slug });
        setErrors(found);
        setFailure('');
        if (Object.keys(found).length > 0) {
            return;
        }

        setSaving(true);
        const result = await createWorkspace({ slug, name: name.trim(), description: description.trim(), icon: 'layers', color: 'blue' });
        setSaving(false);
        if (!result.ok) {
            if (result.error.fields) {
                setErrors(result.error.fields);
            } else {
                setFailure(result.error.message);
            }
            return;
        }

        await reload();
        onDone();
        navigate(projectsPath(result.value.slug));
    };

    return (
        <form onSubmit={submit} noValidate className="grid gap-4">
            <DialogHeader>
                <DialogTitle>New workspace</DialogTitle>
                <DialogDescription>
                    A workspace holds projects and the connections, secrets and variables they share. You become its admin.
                </DialogDescription>
            </DialogHeader>

            <div className="grid gap-2">
                <Label htmlFor="workspace-name">Name</Label>
                <Input
                    id="workspace-name"
                    autoFocus
                    maxLength={100}
                    value={name}
                    aria-invalid={errors.name ? true : undefined}
                    onChange={event => setName(event.target.value)}
                />
                <FieldError message={errors.name} />
            </div>

            <div className="grid gap-2">
                <Label htmlFor="workspace-slug">ID</Label>
                <div className="flex items-center gap-1 text-sm text-muted-foreground">
                    <span>/w/</span>
                    <Input
                        id="workspace-slug"
                        maxLength={40}
                        value={slug}
                        className="font-mono"
                        aria-invalid={errors.slug ? true : undefined}
                        onChange={event => setTypedSlug(event.target.value.toLowerCase())}
                    />
                </div>
                <p className="text-xs text-muted-foreground">In its addresses; it cannot change later.</p>
                <FieldError message={errors.slug} />
            </div>

            <div className="grid gap-2">
                <Label htmlFor="workspace-description">Description</Label>
                <Textarea
                    id="workspace-description"
                    maxLength={500}
                    value={description}
                    onChange={event => setDescription(event.target.value)}
                />
            </div>

            {failure && <p className="text-sm text-destructive">{failure}</p>}

            <DialogFooter>
                <DialogClose asChild>
                    <Button type="button" variant="outline">
                        Cancel
                    </Button>
                </DialogClose>
                <Button type="submit" disabled={saving}>
                    {saving ? 'Creating...' : 'Create'}
                </Button>
            </DialogFooter>
        </form>
    );
}
