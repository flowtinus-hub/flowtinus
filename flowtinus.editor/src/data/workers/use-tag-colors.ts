import { useEffect, useState } from 'react';
import { tagColors } from './worker';
import { getWorkersOverview } from './workers-api';

/** asked again after this long (a supervisor with another color may have started) */
const FRESH_MS = 30_000;

let cached: { at: number; colors: Promise<Record<string, string>> } | null = null;

/** every tag's color (WORKER_COLOR of its supervisors), one request for the whole tab every FRESH_MS at most */
function loadTagColors(): Promise<Record<string, string>> {
    if (!cached || Date.now() - cached.at > FRESH_MS) {
        cached = {
            at: Date.now(),
            colors: getWorkersOverview().then(result => (result.ok ? tagColors(result.value.supervisors) : {})),
        };
    }

    return cached.colors;
}

/** the tags' colors for the lists and menus that show a flow's tag (empty until they come) */
export function useTagColors(): Record<string, string> {
    const [colors, setColors] = useState<Record<string, string>>({});
    useEffect(() => {
        let current = true;
        void loadTagColors().then(value => current && setColors(value));
        return () => {
            current = false;
        };
    }, []);
    return colors;
}
