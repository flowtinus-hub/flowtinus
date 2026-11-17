import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import type { State } from './model';
import { seed } from './seed';

type Store = { state: State; act: <T>(fn: (draft: State) => T) => T; reset: () => void };

const StoreContext = createContext<Store | null>(null);

const KEY = 'flowtinus.prototype-git-sync';

function load(): State {
    try {
        const saved = sessionStorage.getItem(KEY);
        if (saved) {
            return JSON.parse(saved) as State;
        }
    } catch {
        // private mode or a stale shape: the seed
    }
    return seed();
}

function save(state: State) {
    try {
        sessionStorage.setItem(KEY, JSON.stringify(state));
    } catch {
        // full or blocked: memory only
    }
}

export function PrototypeStore({ children }: { children: ReactNode }) {
    const [state, setState] = useState(load);
    const ref = useRef(state);
    const act = useCallback(<T,>(fn: (draft: State) => T): T => {
        const next = structuredClone(ref.current);
        const result = fn(next);
        ref.current = next;
        setState(next);
        save(next);
        return result;
    }, []);
    const reset = useCallback(() => {
        const fresh = seed();
        ref.current = fresh;
        setState(fresh);
        save(fresh);
    }, []);
    const value = useMemo(() => ({ state, act, reset }), [state, act, reset]);
    return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useStore(): Store {
    const store = useContext(StoreContext);
    if (!store) {
        throw new Error('useStore outside PrototypeStore');
    }
    return store;
}
