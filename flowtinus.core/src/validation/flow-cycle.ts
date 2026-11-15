export function findCycle(ids: string[], edges: { source: string; target: string }[]): string[] | null {
    const outputs = new Map(ids.map(id => [id, edges.filter(e => e.source === id).map(e => e.target)]));
    const state = new Map<string, 'visiting' | 'done'>();
    const stack: string[] = [];

    function visit(id: string): string[] | null {
        state.set(id, 'visiting');
        stack.push(id);
        for (const next of outputs.get(id) ?? []) {
            if (state.get(next) === 'visiting') {
                return [...stack.slice(stack.indexOf(next)), next];
            }

            if (!state.has(next)) {
                const cycle = visit(next);
                if (cycle) {
                    return cycle;
                }
            }
        }
        stack.pop();
        state.set(id, 'done');
        return null;
    }

    for (const id of ids) {
        if (!state.has(id)) {
            const cycle = visit(id);
            if (cycle) {
                return cycle;
            }
        }
    }

    return null;
}
