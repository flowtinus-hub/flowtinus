import { COMPONENT_TYPE } from '#components/component-types';
/* A target picked per envelope by an expression: the runner can't know it beforehand, so such a run loads every flow (or script) of the project. */

export const DYNAMIC_TARGET = '$dynamic';

export function dynamicTargets(nodes: { type: string; config: Record<string, unknown> }[]): { flows: boolean; scripts: boolean } {
    return {
        flows: nodes.some(n => n.type === COMPONENT_TYPE.flowInvoker && n.config.flowId === DYNAMIC_TARGET),
        scripts: nodes.some(n => n.type === COMPONENT_TYPE.scriptInvoker && n.config.function === DYNAMIC_TARGET),
    };
}
