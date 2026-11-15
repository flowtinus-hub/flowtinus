import type { ExecutableEdge } from '#types/executable-edge.type';
import type { ExecutableNode } from '#types/executable-node.type';
import type { FlowParameter } from '#types/flow-parameter.type';
import type { TypeShape } from '../scripts/type-shape';

export type ExecutableFlow = {
    id?: string;
    path?: string;
    workspace?: string;
    project: string;
    flow: string;
    parameters: FlowParameter[];
    nodes: ExecutableNode[];
    edges: ExecutableEdge[];
    inputType?: { name: string; shape: TypeShape };
    unavailable?: string;
};
