import type { ComponentLogic } from '#types/component-logic.type';

export function writesOutside(logic: ComponentLogic | undefined, config: Record<string, unknown>): boolean {
    if (!logic?.sideEffects) {
        return false;
    }
    return typeof logic.sideEffects === 'function' ? logic.sideEffects(config) : logic.sideEffects;
}
