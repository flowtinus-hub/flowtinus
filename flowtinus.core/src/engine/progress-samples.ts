import { PROGRESS_SAMPLE_BYTES, PROGRESS_SUB_RUN_SAMPLE_BYTES, PROGRESS_TOTAL_SAMPLE_BYTES } from '#engine/constants';
import type { ComponentRun, SubRun } from '#types/component-run.type';
import type { EnvelopeData } from '#types/envelope-data.type';

const sizes = new WeakMap<object, number>();

export function rememberSize(value: unknown, bytes: number) {
    if (typeof value === 'object' && value !== null) {
        sizes.set(value, bytes);
    }
}

function sizeOf(value: EnvelopeData): number {
    const known = sizes.get(value);
    if (known !== undefined) {
        return known;
    }

    const bytes = JSON.stringify(value)?.length ?? 0;
    sizes.set(value, bytes);
    return bytes;
}

type Budget = { component: number; total: number };

function fit(sample: EnvelopeData[], budget: Budget): { kept: EnvelopeData[]; left: number } {
    let n = 0;
    for (; n < sample.length; n++) {
        const bytes = sizeOf(sample[n]!);
        if (bytes > budget.component || bytes > budget.total) {
            break;
        }

        budget.component -= bytes;
        budget.total -= bytes;
    }

    return { kept: n === sample.length ? sample.slice() : sample.slice(0, n), left: sample.length - n };
}

function fitPorts(ports: Record<string, EnvelopeData[]>, budget: Budget): { kept: Record<string, EnvelopeData[]>; left: number } {
    let left = 0;
    const kept: Record<string, EnvelopeData[]> = {};
    for (const [port, sample] of Object.entries(ports)) {
        const part = fit(sample, budget);
        kept[port] = part.kept;
        left += part.left;
    }

    return { kept, left };
}

export type SampleSizes = { perComponent: number; perSubRunComponent: number; total: { bytes: number } };

function component(c: ComponentRun, perComponent: number, sizes: SampleSizes): ComponentRun {
    const budget: Budget = { component: perComponent, total: sizes.total.bytes };
    const input = fit(c.inputSample, budget);
    const output = fitPorts(c.outputSample, budget);
    const byPort = c.inputSampleByPort ? fitPorts(c.inputSampleByPort, budget) : undefined;
    sizes.total.bytes = budget.total;
    const notKept = {
        input: (c.samplesNotKept?.input ?? 0) + input.left + (byPort?.left ?? 0),
        output: (c.samplesNotKept?.output ?? 0) + output.left,
    };
    const { samplesNotKept: _, ...rest } = c;
    return {
        ...rest,
        inputSample: input.kept,
        outputSample: output.kept,
        ...(byPort ? { inputSampleByPort: byPort.kept } : {}),
        ...(c.subRuns ? { subRuns: c.subRuns.map(sub => subRun(sub, sizes)) } : {}),
        ...(notKept.input > 0 || notKept.output > 0 ? { samplesNotKept: notKept } : {}),
    };
}

function subRun(sub: SubRun, sizes: SampleSizes): SubRun {
    if (!sub.record) {
        return { ...sub };
    }

    return {
        ...sub,
        record: { ...sub.record, components: sub.record.components.map(c => component(c, sizes.perSubRunComponent, sizes)) },
    };
}

export function samplesWithin(components: ComponentRun[], sizes: SampleSizes): ComponentRun[] {
    return components.map(c => component(c, sizes.perComponent, sizes));
}

export function progressComponents(components: ComponentRun[]): ComponentRun[] {
    return samplesWithin(components, {
        perComponent: PROGRESS_SAMPLE_BYTES,
        perSubRunComponent: PROGRESS_SUB_RUN_SAMPLE_BYTES,
        total: { bytes: PROGRESS_TOTAL_SAMPLE_BYTES },
    });
}
