import { useEffect, useState } from 'react';
import { CirclePause } from 'lucide-react';
import { ArrivedDisabledList, type ShownToken } from '@/components/arrived-disabled-list';
import { arrivedCount, CHANGES_CHANGED, GIT_STATUS_CHANGED, listArrivedDisabled, TREE_APPLIED, type ArrivedDisabled } from '@/data/git/git-api';
import { TokenDialog } from '@/pages/flow-editor/webhooks-menu';

type Read = { handle: string; value: ArrivedDisabled[]; requestedAt: number };

const TEXT = {
    git: {
        waiting: 'Schedules and webhooks git created or brought back. None runs until it is turned on in this environment.',
        none: 'Nothing waits to be turned on: every schedule and webhook git brought was turned on, or left.',
    },
    disk: {
        waiting:
            'Schedules and webhooks the disk brought: a new file, or one a checkout brought back. None runs until it is turned on here.',
        none: 'Nothing waits to be turned on: every schedule and webhook the disk brought was turned on, or left.',
    },
};

export function ArrivedDisabledPanel({ handle, local = false }: { handle: string; local?: boolean }) {
    const [items, setItems] = useState<Read | null>(null);
    const [token, setToken] = useState<(ShownToken & { handle: string }) | null>(null);
    useEffect(() => {
        let gone = false;
        const read = () => {
            const requestedAt = performance.now();
            void listArrivedDisabled(handle).then(result => {
                if (gone || !result.ok) {
                    return;
                }
                setItems(current => {
                    if (current?.handle === handle && current.requestedAt > requestedAt) {
                        return current;
                    }
                    return { handle, value: result.value, requestedAt };
                });
            });
        };
        const events = [GIT_STATUS_CHANGED, CHANGES_CHANGED, TREE_APPLIED];
        read();
        events.forEach(event => window.addEventListener(event, read));
        return () => {
            gone = true;
            events.forEach(event => window.removeEventListener(event, read));
        };
    }, [handle]);

    const shown = items?.handle === handle ? items : null;
    const dialog = token?.handle === handle && (
        <TokenDialog webhook={token.webhook} token={token.token} acceptsInput onClose={() => setToken(null)} />
    );
    if (!shown) {
        return dialog || null;
    }
    const count = arrivedCount(shown.value);
    const text = TEXT[local ? 'disk' : 'git'];
    return (
        <div id="arrived-disabled" className="grid scroll-mt-4 gap-3 rounded-lg border p-4 text-sm">
            <div className="flex items-start gap-2">
                <CirclePause className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                <div className="grid gap-0.5">
                    <span className="font-medium">Arrived disabled{count > 0 ? ` · ${count}` : ''}</span>
                    <span className="text-muted-foreground">{count > 0 ? text.waiting : text.none}</span>
                </div>
            </div>
            {count > 0 && (
                <ArrivedDisabledList
                    handle={handle}
                    items={shown.value}
                    readAt={shown.requestedAt}
                    onToken={value => setToken({ ...value, handle })}
                />
            )}
            {dialog}
        </div>
    );
}
