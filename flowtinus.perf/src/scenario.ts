import type { Db } from 'mongodb';
import type { ISqlType } from 'mssql';
import type { CompactRecord } from '#perf/compact';

export type ServiceName = 'mssql' | 'mongodb' | 'postgres' | 'fake-api';
export type Direction = 'lower-is-better' | 'higher-is-better';
export type FakeApiStats = { requests: number; failures: number; p50Ms: number; p95Ms: number };
export type RunMetric =
    | 'durationMs'
    | 'envelopesPerSecond'
    | 'cpuMs'
    | 'cpuPercent'
    | 'memoryStartBytes'
    | 'memoryPeakBytes'
    | 'memoryEndBytes'
    | 'memoryDeltaBytes'
    | 'recordBytes'
    | 'progressCount'
    | 'progressBytes'
    | 'progressMaxBytes';
export type ComponentField = 'activeMs' | 'waitingMs' | 'peakBytes';
export type ComponentMetric = `component.${string}.${ComponentField}`;
export type FakeApiMetric = `fakeApi.${keyof FakeApiStats}`;
export type Metric = RunMetric | ComponentMetric | FakeApiMetric;

export type Ruler = { metric: Metric; direction: Direction };
export type SqlColumn = { name: string; type: ISqlType | (() => ISqlType); nullable?: boolean };
export type LoadContext = {
    size: number;
    seed: number;
    log(line: string): void;
    sqlserver?: {
        query(sql: string, parameters?: Record<string, unknown>): Promise<Record<string, unknown>[]>;
        bulk(table: string, columns: SqlColumn[], rows: unknown[][]): Promise<void>;
    };
    mongo?: Db;
    /** the Postgres that stands in for Redshift, through the Redshift Execute driver: `@name` parameters, one transaction per call, the rows of its last statement */
    postgres?: { query(sql: string, parameters?: Record<string, unknown>): Promise<Record<string, unknown>[]> };
    fakeApi?: { reset(): Promise<void>; stats(): Promise<FakeApiStats> };
};
export type Scenario = {
    id: string;
    description: string;
    services: ServiceName[];
    size: number;
    quickSize: number;
    seed: number;
    runs?: number;
    timeoutMs: number;
    dataVersion: number;
    throughputNode: string;
    rulers: Ruler[];
    load(ctx: LoadContext): Promise<void>;
    reset(ctx: LoadContext): Promise<void>;
    input?(size: number, seed: number): unknown;
    /** after each run that ended (warm-up too): what is wrong with the targets; any line marks the run as wrong */
    verify?(ctx: LoadContext): Promise<string[]>;
};
export type Sample = {
    iteration: number;
    warmup: boolean;
    record: CompactRecord;
    memory: {
        startRssBytes: number;
        peakRssBytes: number;
        endRssBytes: number;
        heapStartBytes: number;
        heapEndBytes: number;
        samples: number;
    };
    cpu: { cpuMs: number; userMs: number; systemMs: number };
    /**
     * what the run hands to whoever follows it, as JSON (what a worker sends to its supervisor and the supervisor writes
     * to the database): the final record, and the progress sent while it went (how many, all of them, the largest).
     * Results from before these were measured do not have it.
     */
    sizes?: { recordBytes: number; progressCount: number; progressBytes: number; progressMaxBytes: number };
    fakeApi?: FakeApiStats;
};
export type RulerResult = {
    metric: Metric;
    direction: Direction;
    median?: number;
    min?: number;
    max?: number;
    previous?: number;
};
