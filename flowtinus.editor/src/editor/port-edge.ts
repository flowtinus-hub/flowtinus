import type { Edge } from '@xyflow/react';
import type { PortEdge } from '@flowtinus/core';

/** a canvas edge as the core's edge between ports: no handle is a card's first port */
export const portEdge = (e: Pick<Edge, 'source' | 'target' | 'sourceHandle' | 'targetHandle'>): PortEdge => ({
    source: e.source,
    sourcePort: e.sourceHandle ?? 'out-0',
    target: e.target,
    targetPort: e.targetHandle ?? 'in-0',
});
