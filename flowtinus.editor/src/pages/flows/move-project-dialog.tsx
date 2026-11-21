import { useState } from 'react';
import { useNavigate } from 'react-router';
import { projectsPath } from '@/app/paths';
import { Button } from '@/components/ui/button';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import type { Project } from '@/data/projects/project';
import { moveProject } from '@/data/projects/projects-api';
import { useMe, useWorkspaceHandle } from '@/data/workspaces/use-workspace';
import { roleAtLeast } from '@/data/workspaces/workspace';

const KIND_LABEL: Record<string, string> = { connections: 'Connections', secrets: 'Secrets', variables: 'Variables' };

/**
 * Moves a project to another workspace of the user (one where they are at least an editor). The connections, secrets
 * and variables its flows use must be there by the same names: otherwise nothing moves and this lists what to create
 * there. Its deployed flows are undeployed (said before).
 */
export function MoveProjectDialog({ project, onClose }: { project: Project | null; onClose: () => void }) {
    const ws = useWorkspaceHandle();
    const navigate = useNavigate();
    const { state } = useMe();
    const targets = state.status === 'ready' ? state.me.workspaces.filter(w => w.handle !== ws && roleAtLeast(w.role, 'editor')) : [];
    const [target, setTarget] = useState('');
    const [missing, setMissing] = useState<Record<string, string> | null>(null);
    const [failure, setFailure] = useState('');
    const [moving, setMoving] = useState(false);
    const chosen = target || targets[0]?.handle || '';

    const close = () => {
        setMissing(null);
        setFailure('');
        setTarget('');
        onClose();
    };

    const move = async () => {
        if (!project || !chosen) {
            return;
        }
        setMoving(true);
        const result = await moveProject(project.id, chosen);
        setMoving(false);
        if (result.ok) {
            close();
            navigate(projectsPath(chosen));
            return;
        }
        setMissing(result.error.code === 'conflict' && result.error.fields ? result.error.fields : null);
        setFailure(result.error.message);
    };

    return (
        <Dialog open={project !== null} onOpenChange={open => !open && close()}>
            <DialogContent className="sm:max-w-md">
                <DialogHeader>
                    <DialogTitle>Move {project?.name} to another workspace</DialogTitle>
                    <DialogDescription>
                        Its folders, flows, scripts, schedules, webhooks and runs go with it. Its flows will use the connections, secrets
                        and variables of the other workspace with the same names. Its deployed flows are undeployed: deploy them there
                        again.
                    </DialogDescription>
                </DialogHeader>

                {targets.length === 0 ? (
                    <p className="text-sm text-muted-foreground">You are not an editor of any other workspace.</p>
                ) : (
                    <div className="grid gap-2">
                        <Label htmlFor="move-target">Workspace</Label>
                        <select
                            id="move-target"
                            className="h-9 rounded-md border bg-background px-2 text-sm"
                            value={chosen}
                            onChange={e => {
                                setTarget(e.target.value);
                                setMissing(null);
                                setFailure('');
                            }}
                        >
                            {targets.map(w => (
                                <option key={w.handle} value={w.handle}>
                                    {w.name} ({w.handle})
                                </option>
                            ))}
                        </select>
                    </div>
                )}

                {missing ? (
                    <div className="grid gap-1 rounded-md border border-destructive/40 p-3 text-sm">
                        <p className="font-medium">Create these in the other workspace first:</p>
                        {Object.entries(missing).map(([kind, names]) => (
                            <p key={kind}>
                                <span className="text-muted-foreground">{KIND_LABEL[kind] ?? kind}:</span> {names}
                            </p>
                        ))}
                    </div>
                ) : (
                    failure && <p className="text-sm text-destructive">{failure}</p>
                )}

                <DialogFooter>
                    <DialogClose asChild>
                        <Button type="button" variant="outline">
                            Cancel
                        </Button>
                    </DialogClose>
                    <Button onClick={() => void move()} disabled={moving || !chosen}>
                        {moving ? 'Moving...' : 'Move'}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
