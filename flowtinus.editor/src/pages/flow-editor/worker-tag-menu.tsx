import { useState } from 'react';
import { Check, LoaderCircle, Tag, TriangleAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import type { Flow } from '@/data/flows/flow';
import { setFlowWorkerTag } from '@/data/flows/flows-api';
import { tagChoices, type TagChoice } from '@/data/workers/worker';
import { getWorkersOverview } from '@/data/workers/workers-api';
import { useTagColors } from '@/data/workers/use-tag-colors';
import { cn } from '@/lib/utils';

type Loaded = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; choices: TagChoice[] };

/**
 * The flow's worker tag in the top bar: which supervisors run it (its runs and test runs). The menu offers the tags
 * of the live supervisors (read when it opens); a tag none of them has cannot run, so the button says so.
 */
export function WorkerTagMenu({ flow, readOnly, onChanged }: { flow: Flow; readOnly: boolean; onChanged: (flow: Flow) => void }) {
    const [loaded, setLoaded] = useState<Loaded>({ status: 'loading' });
    // its supervisors' color (WORKER_COLOR) on the button
    const color = useTagColors()[flow.workerTag];
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState('');
    const current = loaded.status === 'ready' ? loaded.choices.find(c => c.tag === flow.workerTag) : undefined;
    const unserved = current?.live === false;

    const open = async (isOpen: boolean) => {
        if (!isOpen) {
            return;
        }

        setError('');
        setLoaded({ status: 'loading' });
        const result = await getWorkersOverview();
        setLoaded(
            result.ok
                ? { status: 'ready', choices: tagChoices(result.value.supervisors, flow.workerTag) }
                : { status: 'error', message: result.error.message },
        );
    };

    const choose = async (tag: string) => {
        if (tag === flow.workerTag) {
            return;
        }

        setSaving(true);
        const result = await setFlowWorkerTag(flow.id, tag);
        setSaving(false);
        if (result.ok) {
            onChanged(result.value);
        } else {
            setError(result.error.message);
        }
    };

    return (
        <DropdownMenu onOpenChange={isOpen => void open(isOpen)}>
            <DropdownMenuTrigger asChild>
                <Button
                    variant="outline"
                    size="sm"
                    disabled={readOnly}
                    aria-label={`Worker tag: ${flow.workerTag}`}
                    title={unserved ? `No worker takes the tag "${flow.workerTag}": the flow cannot run` : 'Which workers run this flow'}
                    className={cn('bg-card font-mono shadow-md', unserved && 'text-amber-600 dark:text-amber-400')}
                >
                    {saving ? (
                        <LoaderCircle className="animate-spin" />
                    ) : unserved ? (
                        <TriangleAlert />
                    ) : (
                        <Tag style={color ? { color } : undefined} />
                    )}
                    {flow.workerTag}
                </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-64">
                <DropdownMenuLabel className="font-normal text-muted-foreground">Workers that run this flow</DropdownMenuLabel>
                <DropdownMenuSeparator />
                {loaded.status === 'loading' && (
                    <div className="flex items-center gap-2 px-2 py-1.5 text-sm text-muted-foreground">
                        <LoaderCircle className="size-4 animate-spin" /> Loading tags...
                    </div>
                )}
                {loaded.status === 'error' && <p className="px-2 py-1.5 text-sm text-destructive">{loaded.message}</p>}
                {loaded.status === 'ready' &&
                    loaded.choices.map(choice => (
                        <DropdownMenuItem key={choice.tag} disabled={!choice.live} onSelect={() => void choose(choice.tag)}>
                            <Check className={cn(choice.tag === flow.workerTag ? 'opacity-100' : 'opacity-0')} />
                            <span
                                className="size-2 shrink-0 rounded-full"
                                style={{ backgroundColor: choice.color ?? 'transparent' }}
                                aria-hidden
                            />
                            <span className="flex-1 font-mono">{choice.tag}</span>
                            <span className="text-xs text-muted-foreground">
                                {choice.live ? `${choice.workers} worker${choice.workers === 1 ? '' : 's'}` : 'no worker'}
                            </span>
                        </DropdownMenuItem>
                    ))}
                {error && <p className="px-2 py-1.5 text-sm text-destructive">{error}</p>}
            </DropdownMenuContent>
        </DropdownMenu>
    );
}
