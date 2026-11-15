import { useEffect, useState } from 'react';
import type { ResourceState } from '@/data/use-resource';
import { usePageVisible } from '@/lib/use-page-visible';
import type { WorkersOverview } from './worker';
import { followWorkers, getWorkersOverview } from './workers-api';

/** while the stream is down: asked again this often, and the stream tried again */
const RETRY_MS = 5000;

/**
 * The Workers page's data, live: asked once, then kept up to date by its stream (GET /workers/events). While the
 * stream is down it is asked again and the stream tried again every RETRY_MS; what was shown stays meanwhile.
 */
export function useWorkers() {
    const [state, setState] = useState<ResourceState<WorkersOverview>>({ status: 'loading' });
    const [attempt, setAttempt] = useState(0);
    // hidden, the stream goes (see use-page-visible) and what was shown stays; shown again, asked and followed again
    const visible = usePageVisible();

    useEffect(() => {
        if (!visible) {
            return;
        }

        const abort = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;
        const ask = async () => {
            const result = await getWorkersOverview();
            if (!abort.signal.aborted) {
                // a failure after a good answer keeps it
                setState(s =>
                    result.ok
                        ? { status: 'ready', value: result.value }
                        : s.status === 'ready'
                          ? s
                          : { status: 'error', error: result.error },
                );
            }
        };
        void ask().then(() =>
            followWorkers(value => setState({ status: 'ready', value }), abort.signal).finally(() => {
                if (!abort.signal.aborted) {
                    timer = setTimeout(() => setAttempt(n => n + 1), RETRY_MS);
                }
            }),
        );
        return () => {
            abort.abort();
            clearTimeout(timer);
        };
    }, [attempt, visible]);

    return { state, reload: () => setAttempt(n => n + 1) };
}
