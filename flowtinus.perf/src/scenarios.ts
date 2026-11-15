import in_memory_pipeline from '#scenarios/in-memory-pipeline/scenario';
import flow_invoker_fanout from '#scenarios/flow-invoker-fanout/scenario';
import http_slow_api from '#scenarios/http-slow-api/scenario';
import mongodb_pipeline_aggregate from '#scenarios/mongodb-pipeline-aggregate/scenario';
import sqlserver_to_mongodb from '#scenarios/sqlserver-to-mongodb/scenario';
import redshift_batch_replace from '#scenarios/redshift-batch-replace/scenario';
import collection_etl_per_document from '#scenarios/collection-etl-per-document/scenario';
import page_router_fanout from '#scenarios/page-router-fanout/scenario';
import loop_iterations from '#scenarios/loop-iterations/scenario';
import loop_iterations_parallel from '#scenarios/loop-iterations-parallel/scenario';
import type { Scenario } from '#perf/scenario';

export const SCENARIOS: Scenario[] = [
    in_memory_pipeline,
    flow_invoker_fanout,
    loop_iterations,
    loop_iterations_parallel,
    http_slow_api,
    mongodb_pipeline_aggregate,
    sqlserver_to_mongodb,
    redshift_batch_replace,
    collection_etl_per_document,
    page_router_fanout,
];
export const scenarioById = (id: string): Scenario | undefined => SCENARIOS.find(s => s.id === id);
