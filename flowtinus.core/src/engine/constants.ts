import { COMPONENT_TYPE } from '#components/component-types';
export const START = COMPONENT_TYPE.start;
export const END = COMPONENT_TYPE.end;
export const LOOP = COMPONENT_TYPE.loop;
export const LOOP_CONTINUE_WITH = COMPONENT_TYPE.loopContinueWith;
export const LOOP_NEXT = COMPONENT_TYPE.loopNext;
export const LOOP_BREAK = COMPONENT_TYPE.loopBreak;
export const LOOP_CONTROLS: readonly string[] = [LOOP_CONTINUE_WITH, LOOP_NEXT, LOOP_BREAK];

export const ITERATION_START = 'iteration-start';
export const ITERATION_END = 'iteration-end';

export const TEST_RUN_MAX_ITERATIONS = 50;

export const SAMPLE_SIZE = 50;

/**
 * How many bytes (of the envelopes' JSON) a component's samples may take in a run's record, all its samples together:
 * whole envelopes, the first ones; the first that does not fit ends its sample and the others are only counted
 * (samplesNotKept). A page of thousands of rows in one envelope is kept by none, instead of a copy in every component.
 * The End has its own, larger: what reached it is what a webhook that waits answers with.
 */
export const RECORD_SAMPLE_BYTES = 1024 * 1024;
export const END_SAMPLE_BYTES = 10 * 1024 * 1024;

export const MAX_FLOW_DEPTH = 10;

export const MAX_SUB_RUNS = 50;

export const SUB_RUN_SAMPLE_SIZE = 5;

/**
 * The bytes (of the envelopes' JSON) the samples of each component of a sub-run's record may take, whole envelopes
 * (its End too: nothing reads a called flow's End from the record, the Flow Invoker takes its envelopes as they come);
 * and the bytes all the sub-run records of a run's record may take together: past that, the calls that end later keep
 * their counts, times, status, logs and errors, but no samples (samplesNotKept). Without them a run that calls a flow
 * per page kept up to 1 MiB per component of up to 50 calls per Flow Invoker.
 */
export const SUB_RUN_SAMPLE_BYTES = 64 * 1024;
export const SUB_RUNS_TOTAL_SAMPLE_BYTES = 16 * 1024 * 1024;

export const INITIAL_MEASURES = 50;
export const MEASURE_INTERVAL = 100;

export const PROGRESS_SAMPLE_BYTES = 256 * 1024;
export const PROGRESS_SUB_RUN_SAMPLE_BYTES = 32 * 1024;
export const PROGRESS_TOTAL_SAMPLE_BYTES = 4 * 1024 * 1024;
