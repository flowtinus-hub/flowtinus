import { useId, useState, type CSSProperties } from 'react';
import { Blocks, ChevronRight, GripVertical, Search } from 'lucide-react';
import { Panel } from '@xyflow/react';
import { Input } from '@/components/ui/input';
import { CATEGORIES, paletteSections } from '@/editor/catalog';
import { COMPONENT_DRAG_TYPE } from '@/editor/drag';
import { cn } from '@/lib/utils';

/** the category's color, and a tint of it for the icon tiles (as in the PoC) */
const categoryStyle = (color: string) =>
    ({ '--category': color, '--category-tint': `color-mix(in oklch, ${color} 15%, transparent)` }) as CSSProperties;

const COLLAPSED_KEY = 'flowtinus.palette.collapsed';

/** the categories left collapsed, remembered in this browser */
function readCollapsed(): Set<string> {
    try {
        const value: unknown = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? '[]');
        return new Set(Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []);
    } catch {
        return new Set();
    }
}

/** the width of the components' rail on the canvas' left edge */
export const PALETTE_RAIL = 36;
/** the width of their drawer, open */
export const PALETTE_WIDTH = 288;

/**
 * The components: a rail on the whole height of the canvas, "Components" written up it, that opens and closes their
 * drawer (remembered in this browser): the drawer grows from the left edge and pushes the rail along. The drawer: the whole height, the components by category with a
 * search, in the PoC's style: each category's name in its color, each component a card with its icon on a tinted tile,
 * its name and description; dragged onto the canvas, it is added there. It does not cover the canvas: the canvas is
 * used beside it. nopan/nowheel/nodrag keep the canvas from panning or zooming while the pointer is over it.
 */
export function ComponentPalette({ open, onToggle }: { open: boolean; onToggle: () => void }) {
    const [search, setSearch] = useState('');
    const contentId = useId();
    const sections = paletteSections(search);

    return (
        // the drawer grows from the canvas' left edge and pushes the rail along: the rail is its edge
        <Panel position="top-left" className="nopan nowheel nodrag flex" style={{ margin: 0, height: '100%' }}>
            <div
                id={contentId}
                inert={!open}
                aria-hidden={!open}
                className="h-full shrink-0 overflow-hidden bg-card transition-[width] duration-200"
                style={{ width: open ? PALETTE_WIDTH : 0 }}
            >
                <ComponentDrawer search={search} setSearch={setSearch} sections={sections} />
            </div>
            <button
                type="button"
                onClick={onToggle}
                aria-expanded={open}
                aria-controls={contentId}
                title={open ? 'Close the components (C)' : 'The components, to drag onto the canvas (C)'}
                style={{ width: PALETTE_RAIL }}
                className={cn(
                    'flex h-full shrink-0 flex-col items-center gap-2 border-x bg-card pt-3 text-sm font-medium text-muted-foreground outline-none hover:bg-accent/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring',
                    open && 'bg-accent text-foreground',
                )}
            >
                <Blocks className="size-4 shrink-0" />
                <span className="rotate-180 [writing-mode:vertical-rl]">Components</span>
            </button>
        </Panel>
    );
}

/** the drawer's content: the search, and the components by category (its width fixed: the drawer opens over it) */
function ComponentDrawer(props: { search: string; setSearch: (search: string) => void; sections: ReturnType<typeof paletteSections> }) {
    const { search, setSearch, sections } = props;
    const [collapsedCategories, setCollapsedCategories] = useState<Set<string>>(readCollapsed);
    const toggle = (category: string) =>
        setCollapsedCategories(current => {
            const next = new Set(current);
            if (!next.delete(category)) {
                next.add(category);
            }
            try {
                localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next]));
            } catch {
                // storage unavailable: it only stays for this session
            }
            return next;
        });
    return (
        <>
            <div className="flex h-full w-72 flex-col overflow-hidden">
                <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
                    <div className="relative shrink-0 p-3">
                        <Search className="pointer-events-none absolute top-1/2 left-5.5 size-4 -translate-y-1/2 text-muted-foreground" />
                        <Input
                            value={search}
                            onChange={event => setSearch(event.target.value)}
                            placeholder="Search..."
                            aria-label="Search components"
                            className="h-9 pl-8"
                        />
                    </div>

                    <div className="flex min-h-0 flex-col gap-5 overflow-y-auto px-3 pb-3 [&>*]:shrink-0">
                        {sections.length === 0 && <p className="text-sm text-muted-foreground">No components found.</p>}
                        {sections.map(({ category, components }) => {
                            const { label, color } = CATEGORIES[category];
                            // a search shows every match, whatever is collapsed
                            const collapsed = !search.trim() && collapsedCategories.has(category);
                            return (
                                <section
                                    key={category}
                                    className="flex flex-col gap-2"
                                    style={categoryStyle(color)}
                                    aria-labelledby={`palette-${category}`}
                                >
                                    <h3 id={`palette-${category}`} className="text-xs">
                                        <button
                                            type="button"
                                            onClick={() => toggle(category)}
                                            aria-expanded={!collapsed}
                                            aria-controls={`palette-list-${category}`}
                                            title={collapsed ? 'Expand' : 'Collapse'}
                                            className="flex w-full items-center gap-2 rounded-sm font-mono tracking-wider text-[var(--category)] uppercase outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                        >
                                            <ChevronRight
                                                className={cn('size-3.5 shrink-0 transition-transform', !collapsed && 'rotate-90')}
                                                aria-hidden
                                            />
                                            <span
                                                className="size-2 rounded-sm border border-[var(--category)] bg-[var(--category-tint)]"
                                                aria-hidden
                                            />
                                            {label}
                                            <span className="ml-auto text-muted-foreground">{components.length}</span>
                                        </button>
                                    </h3>
                                    <ul id={`palette-list-${category}`} hidden={collapsed} className="flex flex-col gap-1.5">
                                        {components.map(component => (
                                            // dragged onto the canvas, it adds the component where it is dropped
                                            <li
                                                key={component.type}
                                                draggable
                                                onDragStart={event => {
                                                    event.dataTransfer.setData(COMPONENT_DRAG_TYPE, component.type);
                                                    event.dataTransfer.effectAllowed = 'copy';
                                                }}
                                                className="group flex cursor-grab items-center gap-3 rounded-md border border-transparent bg-accent/50 p-2 transition-colors hover:border-border hover:bg-accent active:cursor-grabbing"
                                            >
                                                <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-[var(--category-tint)] text-[var(--category)]">
                                                    <component.icon className="size-4" aria-hidden />
                                                </div>
                                                <div className="flex min-w-0 flex-1 flex-col">
                                                    <span className="truncate text-sm font-medium">{component.label}</span>
                                                    <span className="truncate text-xs text-muted-foreground" title={component.description}>
                                                        {component.description}
                                                    </span>
                                                </div>
                                                <GripVertical
                                                    className="size-4 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100"
                                                    aria-hidden
                                                />
                                            </li>
                                        ))}
                                    </ul>
                                </section>
                            );
                        })}
                    </div>
                </div>
            </div>
        </>
    );
}
