import type { ComponentLogic } from '#types/component-logic.type';
import { aggregate } from './built-in/aggregate';
import { datagrid } from './built-in/datagrid';
import { distinct } from './built-in/distinct';
import { filter } from './built-in/filter';
import { httpRequest } from './built-in/http-request';
import { limit } from './built-in/limit';
import { log } from './built-in/log';
import { lookup } from './built-in/lookup';
import { mapper } from './built-in/mapper';
import { mongodbDelete } from './built-in/mongodb-delete';
import { mongodbPipeline } from './built-in/mongodb-pipeline';
import { mongodbUpsert } from './built-in/mongodb-upsert';
import { router } from './built-in/router';
import { split } from './built-in/split';
import { sort } from './built-in/sort';
import { sqlserverQuery } from './built-in/sqlserver-query';
import { redshiftQuery } from './built-in/redshift-query';
import { redshiftDelete, redshiftInsert, redshiftUpsert } from './built-in/redshift-write';
import { sqlServerDelete, sqlServerInsert, sqlServerUpdate } from './sqlserver-write';
import { redshiftExecute, sqlServerExecute } from './built-in/sql-execute';
import { typescript } from './built-in/typescript';
import { flowInvoker } from './built-in/flow-invoker';
import { scriptInvoker } from './built-in/script-invoker';
import { discard } from './built-in/discard';
import { wait } from './built-in/wait';
import { loop } from './built-in/loop';
import { loopBreak, loopContinueWith, loopNext } from './built-in/loop-control';

/** Logic of each component, by type. New component = add it here (and its visual part in the editor). */
export const COMPONENTS: Record<string, ComponentLogic> = {
    [mapper.type]: mapper,
    [filter.type]: filter,
    [router.type]: router,
    [lookup.type]: lookup,
    [typescript.type]: typescript,
    [aggregate.type]: aggregate,
    [split.type]: split,
    [distinct.type]: distinct,
    [sort.type]: sort,
    [limit.type]: limit,
    [datagrid.type]: datagrid,
    [sqlserverQuery.type]: sqlserverQuery,
    [redshiftQuery.type]: redshiftQuery,
    [redshiftInsert.type]: redshiftInsert,
    [redshiftUpsert.type]: redshiftUpsert,
    [redshiftDelete.type]: redshiftDelete,
    [redshiftExecute.type]: redshiftExecute,
    [sqlServerInsert.type]: sqlServerInsert,
    [sqlServerUpdate.type]: sqlServerUpdate,
    [sqlServerDelete.type]: sqlServerDelete,
    [sqlServerExecute.type]: sqlServerExecute,
    [mongodbPipeline.type]: mongodbPipeline,
    [mongodbUpsert.type]: mongodbUpsert,
    [mongodbDelete.type]: mongodbDelete,
    [httpRequest.type]: httpRequest,
    [flowInvoker.type]: flowInvoker,
    [scriptInvoker.type]: scriptInvoker,
    [log.type]: log,
    [discard.type]: discard,
    [wait.type]: wait,
    [loop.type]: loop,
    [loopContinueWith.type]: loopContinueWith,
    [loopNext.type]: loopNext,
    [loopBreak.type]: loopBreak,
};
