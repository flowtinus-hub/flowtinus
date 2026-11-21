import { useEffect, useRef } from 'react';
import { CHANGES_CHANGED, GIT_STATUS_CHANGED, TRIGGERS_SWITCHED } from '@/data/git/git-api';

export function useTriggersChanged(load: () => Promise<void>) {
    const latest = useRef(load);
    useEffect(() => {
        latest.current = load;
    });
    useEffect(() => {
        const read = () => void latest.current();
        const events = [TRIGGERS_SWITCHED, CHANGES_CHANGED, GIT_STATUS_CHANGED];
        events.forEach(event => window.addEventListener(event, read));
        return () => events.forEach(event => window.removeEventListener(event, read));
    }, []);
}

export function ArrivedBadge() {
    return (
        <span
            className="shrink-0 rounded-full bg-sky-500/15 px-1.5 py-0.5 text-[10px] font-medium text-sky-700 dark:text-sky-300"
            title="Git created or brought it back: off until turned on in this environment"
        >
            Arrived disabled
        </span>
    );
}
