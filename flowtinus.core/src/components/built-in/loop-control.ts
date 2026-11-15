import { COMPONENT_TYPE } from '#components/component-types';
import type { ComponentLogic } from '#types/component-logic.type';
import type { LoopControl } from '#types/loop-control.type';

export const LOOP_CONTROL_LABEL: Record<LoopControl, string> = { continueWith: 'Continue with', next: 'Next', break: 'Break' };

const TYPE: Record<LoopControl, string> = {
    continueWith: COMPONENT_TYPE.loopContinueWith,
    next: COMPONENT_TYPE.loopNext,
    break: COMPONENT_TYPE.loopBreak,
};

const DESCRIPTION: Record<LoopControl, string> = {
    continueWith:
        'Only inside a Loop (`loop: <its id>`): the envelope that reaches it is the loop state of the next iteration. More than one in an iteration is an error of the Loop for that input envelope. It does not cut the iteration short; no output.',
    next: 'Only inside a Loop (`loop: <its id>`): an envelope that reaches it ends the iteration right away (what is still running in it stops; what reached Iteration end already went out) and the next one starts, with the loop state as it is (a Continue with reached before it still sets it). No output.',
    break: 'Only inside a Loop (`loop: <its id>`): an envelope that reaches it ends the loop after the iteration (it does not go out of the Loop), and wins over a Continue with or a Next reached in the same iteration. It does not cut the iteration short; no output.',
};

function loopControl(control: LoopControl): ComponentLogic {
    return {
        type: TYPE[control],
        label: LOOP_CONTROL_LABEL[control],
        category: 'flow',
        description: DESCRIPTION[control],
        example: {},
        inputs: 1,
        outputs: 0,
        settings: [],

        validate() {
            return [];
        },

        async *execute(inputs, _config, ctx) {
            let reached = 0;
            for await (const doc of inputs['in-0'] ?? []) {
                ctx.reachLoop(control, doc);
                reached += 1;
            }
            ctx.log('debug', `${reached} envelope(s) reached ${LOOP_CONTROL_LABEL[control]}.`);
        },
    };
}

export const loopContinueWith = loopControl('continueWith');
export const loopNext = loopControl('next');
export const loopBreak = loopControl('break');
