import { useSyncExternalStore } from 'react';

export function keyedStore<T extends object>(empty: T, onChange?: (values: ReadonlyMap<string, T>) => void) {
    const values = new Map<string, T>();
    const listeners = new Set<() => void>();
    const get = (key: string): T => values.get(key) ?? empty;
    const subscribe = (listener: () => void) => {
        listeners.add(listener);
        return () => {
            listeners.delete(listener);
        };
    };
    return {
        get,
        keys: () => [...values.keys()],
        set(key: string, next: Partial<T>) {
            values.set(key, { ...get(key), ...next });
            onChange?.(values);
            listeners.forEach(listener => listener());
        },
        subscribe,
        // the same on the server (a form rendered to text: tests)
        use: (key: string): T =>
            useSyncExternalStore(
                subscribe,
                () => get(key),
                () => get(key),
            ),
    };
}
