import { END, START } from '#engine/constants';
import type { ExecutableFlow } from '#types/executable-flow.type';

export function flowOrder(flow: ExecutableFlow): string[] {
    const degree = new Map(flow.nodes.map(n => [n.id, 0]));

    for (const e of flow.edges) {
        degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
    }
    const connected = new Set(flow.edges.flatMap(e => [e.source, e.target]));
    const queue = flow.nodes.filter(n => degree.get(n.id) === 0 && (connected.has(n.id) || n.type === START)).map(n => n.id);
    const order: string[] = [];
    while (queue.length) {
        const current = queue.shift()!;
        order.push(current);
        for (const e of flow.edges.filter(x => x.source === current)) {
            const d = (degree.get(e.target) ?? 0) - 1;
            degree.set(e.target, d);
            if (d === 0) {
                queue.push(e.target);
            }
        }
    }

    const rest = flow.nodes.map(n => n.id).filter(id => !order.includes(id));
    const withoutEnd = order.filter(id => flow.nodes.find(n => n.id === id)?.type !== END);
    const ends = order.filter(id => flow.nodes.find(n => n.id === id)?.type === END);

    return [...withoutEnd, ...ends, ...rest];
}
