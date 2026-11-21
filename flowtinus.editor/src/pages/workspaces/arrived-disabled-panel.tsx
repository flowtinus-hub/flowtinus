import { useEffect, useState } from 'react';
import { CirclePause } from 'lucide-react';
import { ArrivedDisabledList } from '@/components/arrived-disabled-list';
import { arrivedCount, CHANGES_CHANGED, GIT_STATUS_CHANGED, listArrivedDisabled, type ArrivedDisabled } from '@/data/git/git-api';

export function ArrivedDisabledPanel({ slug }: { slug: string }) {
    const [items, setItems] = useState<{ slug: string; value: ArrivedDisabled[]; read: number } | null>(null);
    useEffect(() => {
        let gone = false;
        const read = () =>
            void listArrivedDisabled(slug).then(
                result => !gone && result.ok && setItems(current => ({ slug, value: result.value, read: (current?.read ?? 0) + 1 })),
            );
        read();
        window.addEventListener(GIT_STATUS_CHANGED, read);
        window.addEventListener(CHANGES_CHANGED, read);
        return () => {
            gone = true;
            window.removeEventListener(GIT_STATUS_CHANGED, read);
            window.removeEventListener(CHANGES_CHANGED, read);
        };
    }, [slug]);

    const shown = items?.slug === slug ? items : null;
    if (!shown) {
        return null;
    }
    const count = arrivedCount(shown.value);
    return (
        <div id="arrived-disabled" className="grid scroll-mt-4 gap-3 rounded-lg border p-4 text-sm">
            <div className="flex items-start gap-2">
                <CirclePause className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                <div className="grid gap-0.5">
                    <span className="font-medium">Arrived disabled{count > 0 ? ` · ${count}` : ''}</span>
                    <span className="text-muted-foreground">
                        {count > 0
                            ? 'Schedules and webhooks git created or brought back. None runs until it is turned on in this environment.'
                            : 'Nothing waits to be turned on: every schedule and webhook git brought was turned on, or left.'}
                    </span>
                </div>
            </div>
            {count > 0 && <ArrivedDisabledList key={shown.read} slug={slug} items={shown.value} />}
        </div>
    );
}
