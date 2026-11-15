import type { AggregateDocuments, DeleteDocuments, UpsertDocuments, UpsertResult } from '@flowtinus/core';
import type { Document, MongoClient } from 'mongodb';

/*
 * MongoDB's drivers, in the worker (the official driver): Pipeline's aggregation read through the cursor (the next batch
 * only when the flow asks), Upsert's batches as one unordered bulk write (one result per upsert, a failed one does not
 * stop the others), Delete's deleteMany (or only a count, in a test run). What the components send may use Extended JSON
 * ({$oid}, {$date}); what comes back is plain JSON: ids as text, dates as ISO text. A client per connection string, kept
 * by this worker.
 */

const KEPT_CLIENTS = 8;
const clients = new Map<string, Promise<MongoClient>>();

async function clientOf(connection: string): Promise<MongoClient> {
    const known = clients.get(connection);
    if (known) {
        clients.delete(connection);
        clients.set(connection, known);
        return known;
    }

    const { MongoClient } = await import('mongodb');
    const connected = new MongoClient(connection, { appName: 'flowtinus', serverSelectionTimeoutMS: 15_000 }).connect().catch(e => {
        clients.delete(connection);
        throw e;
    });
    clients.set(connection, connected);
    if (clients.size > KEPT_CLIENTS) {
        const [oldest, gone] = clients.entries().next().value!;
        clients.delete(oldest);
        void gone.then(c => c.close()).catch(() => undefined);
    }

    return connected;
}

export async function closeMongoClients() {
    const all = [...clients.values()];
    clients.clear();
    await Promise.all(all.map(c => c.then(client => client.close()).catch(() => undefined)));
}

function datesAsExtendedJson(value: unknown): unknown {
    if (value instanceof Date) {
        return { $date: value.toISOString() };
    }
    if (Array.isArray(value)) {
        return value.map(datesAsExtendedJson);
    }
    if (value !== null && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, datesAsExtendedJson(child)]));
    }
    return value;
}

async function fromExtendedJson<T>(value: T, canonical = false): Promise<T> {
    const { BSON } = await import('mongodb');
    return BSON.EJSON.deserialize(datesAsExtendedJson(value) as Document, { relaxed: !canonical }) as T;
}

export function plainJson(value: unknown): unknown {
    if (value === null || typeof value !== 'object') {
        return typeof value === 'bigint' ? Number(value) : value;
    }

    if (value instanceof Date) {
        return value.toISOString();
    }

    if (Array.isArray(value)) {
        return value.map(plainJson);
    }

    const bson = (value as { _bsontype?: string })._bsontype;
    switch (bson) {
        case 'ObjectId':
        case 'ObjectID':
            return (value as { toHexString(): string }).toHexString();
        case 'Decimal128':
        case 'UUID':
            return String(value);
        case 'Long':
        case 'Int32':
        case 'Double':
            return Number(value);
        case 'Binary':
            return (value as { toString(encoding: string): string }).toString('base64');
        case 'Timestamp':
            return (value as { toString(): string }).toString();
        default:
            break;
    }

    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, plainJson(v)]));
}

export const aggregateMongoDb: AggregateDocuments = async function* ({
    connection,
    database,
    collection,
    pipeline,
    outputFormat,
    timeoutMs,
    signal,
}) {
    if (signal.aborted) {
        return;
    }

    const bson = outputFormat === 'extended-json' ? (await import('mongodb')).BSON : undefined;
    const client = await clientOf(connection);
    const cursor = client
        .db(database)
        .collection(collection)
        .aggregate(await fromExtendedJson(pipeline), {
            maxTimeMS: timeoutMs,
            ...(outputFormat === 'extended-json' ? { promoteValues: false } : {}),
        });
    const close = () => void cursor.close().catch(() => undefined);
    signal.addEventListener('abort', close, { once: true });
    try {
        for await (const doc of cursor) {
            if (signal.aborted) {
                return;
            }

            if (bson) {
                const encoded = bson.EJSON.serialize(doc, { relaxed: false }) as Record<string, unknown>;
                const restored = bson.EJSON.deserialize(encoded, { relaxed: false });
                if (Buffer.compare(bson.serialize(doc), bson.serialize(restored)) !== 0) {
                    throw new Error('This document cannot be represented losslessly as canonical Extended JSON.');
                }
                yield encoded;
            } else {
                yield plainJson(doc) as Record<string, unknown>;
            }
        }
    } finally {
        signal.removeEventListener('abort', close);
        await cursor.close().catch(() => undefined);
    }
};

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export const upsertMongoDb: UpsertDocuments = async ({ connection, database, collection, upserts, valueFormat, writeMode, signal }) => {
    if (signal.aborted) {
        throw Object.assign(new Error('Run stopped.'), { name: 'AbortError' });
    }

    const target = (await clientOf(connection)).db(database).collection(collection);
    const operations = await Promise.all(
        upserts.map(async u => {
            const filter = await fromExtendedJson(u.filter, valueFormat === 'extended-json');
            const document = await fromExtendedJson(u.document, valueFormat === 'extended-json');
            return writeMode === 'replace'
                ? { replaceOne: { filter, replacement: document, upsert: true as const } }
                : { updateOne: { filter, update: { $set: document }, upsert: true as const } };
        }),
    );
    // one on its own: whether it changed the document is known
    if (operations.length === 1) {
        try {
            const operation = operations[0]!;
            const r =
                'replaceOne' in operation && operation.replaceOne
                    ? await target.replaceOne(operation.replaceOne.filter, operation.replaceOne.replacement, { upsert: true })
                    : await target.updateOne(operation.updateOne!.filter, operation.updateOne!.update, { upsert: true });
            return {
                results: [
                    {
                        matched: r.matchedCount,
                        upsertedId: r.upsertedId ? String(plainJson(r.upsertedId)) : null,
                        modified: r.modifiedCount,
                    },
                ],
                modified: r.modifiedCount,
            };
        } catch (e) {
            if ((e as { code?: unknown }).code !== undefined) {
                return { results: [{ error: message(e) }], modified: 0 };
            }

            throw e;
        }
    }

    type BulkResult = { upsertedIds: Record<number, unknown>; modifiedCount: number };
    let result: BulkResult;
    const failed = new Map<number, string>();
    try {
        result = (await target.bulkWrite(operations, { ordered: false })) as unknown as BulkResult;
    } catch (e) {
        // some failed: the others went through, each one says how it went
        const bulk = e as { result?: BulkResult; writeErrors?: { index: number; errmsg?: string }[] | { index: number; errmsg?: string } };
        if (!bulk.result) {
            throw e;
        }

        result = bulk.result;
        const errors = Array.isArray(bulk.writeErrors) ? bulk.writeErrors : bulk.writeErrors ? [bulk.writeErrors] : [];
        for (const w of errors) {
            failed.set(w.index, w.errmsg ?? 'Write failed.');
        }
    }

    const results: UpsertResult[] = upserts.map((_, i) => {
        if (failed.has(i)) {
            return { error: failed.get(i)! };
        }

        const upserted = result.upsertedIds?.[i];
        return upserted !== undefined ? { matched: 0, upsertedId: String(plainJson(upserted)) } : { matched: 1, upsertedId: null };
    });
    return { results, modified: result.modifiedCount ?? 0 };
};

export const deleteMongoDb: DeleteDocuments = async ({ connection, database, collection, filter, countOnly, signal }) => {
    if (signal.aborted) {
        throw Object.assign(new Error('Run stopped.'), { name: 'AbortError' });
    }

    const target = (await clientOf(connection)).db(database).collection(collection);
    const query = await fromExtendedJson(filter);
    return countOnly ? target.countDocuments(query) : (await target.deleteMany(query)).deletedCount;
};
