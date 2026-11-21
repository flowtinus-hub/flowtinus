import { Fragment, type ComponentType } from 'react';
import { Blocks, GitFork, Hand, Keyboard, Maximize, MousePointer2, MousePointerClick, Network, PanelBottom, Play, Redo2, Save, Scissors, SquareDashed, Trash2, Undo2, ZoomIn } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';

const MOD = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl';

type Shortcut = { icon: ComponentType<{ className?: string }>; keys: string[][]; what: string; readOnly?: boolean };

const Arrange = ({ className }: { className?: string }) => <Network className={cn('-rotate-90', className)} />;

const GROUPS: { title: string; items: Shortcut[] }[] = [
    {
        title: 'Canvas',
        items: [
            { icon: Arrange, keys: [['A']], what: 'Arrange the flow from left to right' },
            { icon: SquareDashed, keys: [['G']], what: 'Add a group' },
            { icon: Blocks, keys: [['C']], what: 'Open or close the components' },
            { icon: Maximize, keys: [['F']], what: 'Fit the flow to the screen', readOnly: true },
            { icon: GitFork, keys: [['D']], what: 'Open or close the Calls panel', readOnly: true },
            { icon: PanelBottom, keys: [['B']], what: "Open or close the run's panel", readOnly: true },
            { icon: Scissors, keys: [['X', 'drag']], what: 'Cut connections: drag across them' },
            { icon: Keyboard, keys: [['K']], what: 'Show these shortcuts', readOnly: true },
        ],
    },
    {
        title: 'Editing',
        items: [
            { icon: Undo2, keys: [[MOD, 'Z']], what: 'Undo' },
            {
                icon: Redo2,
                keys: [
                    [MOD, 'Y'],
                    [MOD, 'Shift', 'Z'],
                ],
                what: 'Redo',
            },
            { icon: Trash2, keys: [['Delete'], ['Backspace']], what: 'Remove what is selected' },
            { icon: Save, keys: [[MOD, 'S']], what: 'Save now (it also saves by itself)' },
            { icon: Play, keys: [[MOD, 'Enter']], what: 'Test run', readOnly: true },
        ],
    },
    {
        title: 'Mouse',
        items: [
            {
                icon: MousePointer2,
                keys: [
                    [MOD, 'click'],
                    ['Shift', 'click'],
                ],
                what: 'Select several',
            },
            { icon: MousePointerClick, keys: [['double-click']], what: "Open a component's settings" },
            { icon: Hand, keys: [['scroll'], ['right drag'], ['middle drag']], what: 'Pan', readOnly: true },
            { icon: ZoomIn, keys: [[MOD, 'scroll']], what: 'Zoom', readOnly: true },
        ],
    },
];

function Keys({ keys }: { keys: string[][] }) {
    return (
        <span className="flex flex-wrap items-center justify-end gap-1">
            {keys.map((combo, i) => (
                <Fragment key={combo.join('+')}>
                    {i > 0 && <span className="text-xs text-muted-foreground">or</span>}
                    {combo.map((key, j) => (
                        <Fragment key={key}>
                            {j > 0 && <span className="text-xs text-muted-foreground">+</span>}
                            <kbd className="rounded border bg-muted px-1.5 py-0.5 font-mono text-[11px] text-foreground">{key}</kbd>
                        </Fragment>
                    ))}
                </Fragment>
            ))}
        </span>
    );
}

/** the canvas's keyboard and mouse shortcuts (K); a read-only flow lists only the ones it takes */
export function ShortcutsDialog({ open, readOnly, onClose }: { open: boolean; readOnly: boolean; onClose: () => void }) {
    return (
        <Dialog open={open} onOpenChange={isOpen => !isOpen && onClose()}>
            <DialogContent
                className="w-[42rem] sm:max-w-2xl"
                onKeyDown={event => {
                    if (event.key.toLowerCase() === 'k' && !event.ctrlKey && !event.metaKey && !event.altKey) {
                        event.preventDefault();
                        onClose();
                    }
                }}
            >
                <DialogHeader>
                    <DialogTitle>Shortcuts</DialogTitle>
                    <DialogDescription>Not while typing in a field or in a window.</DialogDescription>
                </DialogHeader>
                <div className="grid gap-4">
                    {GROUPS.map(group => {
                        const items = group.items.filter(item => !readOnly || item.readOnly);
                        return (
                            items.length > 0 && (
                                <section key={group.title} className="grid gap-1.5">
                                    <h3 className="text-xs font-medium text-muted-foreground uppercase">{group.title}</h3>
                                    <ul className="grid gap-1">
                                        {items.map(item => (
                                            <li key={item.what} className="flex items-center justify-between gap-6 text-sm">
                                                <span className="flex items-center gap-2">
                                                    <item.icon className="size-4 shrink-0 text-muted-foreground" />
                                                    {item.what}
                                                </span>
                                                <Keys keys={item.keys} />
                                            </li>
                                        ))}
                                    </ul>
                                </section>
                            )
                        );
                    })}
                </div>
            </DialogContent>
        </Dialog>
    );
}
