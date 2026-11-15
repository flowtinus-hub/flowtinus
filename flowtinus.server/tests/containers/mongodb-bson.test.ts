import { afterAll, expect, setDefaultTimeout, test } from 'bun:test';
import { BSON, Binary, Decimal128, Double, Int32, Long, MongoClient, ObjectId } from 'mongodb';
import { GenericContainer, Wait } from 'testcontainers';
import { flowRunner, type ExecutableFlow } from '@flowtinus/core';
import { evaluate } from '#shared/runner/evaluate';
import { aggregateMongoDb, closeMongoClients, upsertMongoDb } from '#shared/runner/mongodb-driver';

setDefaultTimeout(180_000);

const mongo = await new GenericContainer('mongo:8.0')
    .withExposedPorts(27017)
    .withWaitStrategy(Wait.forLogMessage(/Waiting for connections/))
    .start()
    .catch(() => null);

afterAll(async () => {
    await closeMongoClients();
    await mongo?.stop();
});

test.skipIf(!mongo)('canonical Extended JSON round trips nested BSON types without changing their representation', async () => {
    const connection = `mongodb://${mongo!.getHost()}:${mongo!.getMappedPort(27017)}`;
    const client = await new MongoClient(connection).connect();
    try {
        const source = client.db('shop').collection('bson_source');
        const target = client.db('shop').collection('bson_target');
        const id = new ObjectId();
        await source.insertOne({
            _id: id,
            nested: {
                objectId: new ObjectId(),
                date: new Date('2026-01-02T03:04:05.678Z'),
                long: Long.fromString('9007199254740993'),
                smallLong: Long.fromInt(5),
                integer: new Int32(7),
                double: new Double(2),
                decimal: Decimal128.fromString('123.4500'),
                binary: new Binary(Buffer.from([0, 1, 255])),
                uuid: new Binary(Buffer.from('00112233445566778899aabbccddeeff', 'hex'), Binary.SUBTYPE_UUID),
                values: [Long.fromInt(3), new Date('2025-01-01T00:00:00Z')],
            },
        });
        const before = await source.findOne({ _id: id }, { promoteValues: false });
        const plain: Record<string, unknown>[] = [];
        for await (const row of aggregateMongoDb({
            connection,
            database: 'shop',
            collection: 'bson_source',
            pipeline: [],
            timeoutMs: 30_000,
            signal: new AbortController().signal,
        })) {
            plain.push(row);
        }
        expect(plain[0]).toMatchObject({
            _id: id.toHexString(),
            nested: { date: '2026-01-02T03:04:05.678Z', integer: 7, double: 2, decimal: '123.4500' },
        });
        const rows: Record<string, unknown>[] = [];
        for await (const row of aggregateMongoDb({
            connection,
            database: 'shop',
            collection: 'bson_source',
            pipeline: [],
            outputFormat: 'extended-json',
            timeoutMs: 30_000,
            signal: new AbortController().signal,
        })) {
            rows.push(row);
        }
        expect(rows).toHaveLength(1);
        expect(rows[0]).toEqual(BSON.EJSON.serialize(before, { relaxed: false }));
        const { _id, ...document } = rows[0]!;
        const result = await upsertMongoDb({
            connection,
            database: 'shop',
            collection: 'bson_target',
            valueFormat: 'extended-json',
            upserts: [{ filter: { _id }, document }],
            signal: new AbortController().signal,
        });
        expect(result.results[0]).toMatchObject({ matched: 0 });
        const retry = await upsertMongoDb({
            connection,
            database: 'shop',
            collection: 'bson_target',
            valueFormat: 'extended-json',
            upserts: [{ filter: { _id }, document }],
            signal: new AbortController().signal,
        });
        expect(retry.results[0]).toMatchObject({ matched: 1 });
        expect(await target.countDocuments()).toBe(1);
        await target.updateOne({ _id: id }, { $set: { removedOnRetry: true } });
        const replaced = await upsertMongoDb({
            connection,
            database: 'shop',
            collection: 'bson_target',
            valueFormat: 'extended-json',
            writeMode: 'replace',
            upserts: [{ filter: { _id }, document }],
            signal: new AbortController().signal,
        });
        expect(replaced.results[0]).toMatchObject({ matched: 1 });
        const replacement = await target.findOne({ _id: id }, { promoteValues: false });
        expect(BSON.EJSON.serialize(replacement, { relaxed: false })).toEqual(BSON.EJSON.serialize(before, { relaxed: false }));
        const bulkTarget = client.db('shop').collection('replacement_batch');
        const bulkId = new ObjectId();
        const newId = new ObjectId();
        await bulkTarget.insertOne({ _id: bulkId, removedOnRetry: true });
        const bulk = await upsertMongoDb({
            connection,
            database: 'shop',
            collection: 'replacement_batch',
            valueFormat: 'extended-json',
            writeMode: 'replace',
            upserts: [
                { filter: { _id: { $oid: bulkId.toHexString() } }, document: { kept: 'updated' } },
                { filter: { _id: { $oid: newId.toHexString() } }, document: { kept: 'inserted' } },
            ],
            signal: new AbortController().signal,
        });
        expect(bulk.results[0]).toMatchObject({ matched: 1 });
        expect(bulk.results[1]).toMatchObject({ matched: 0 });
        expect(await bulkTarget.findOne({ _id: bulkId })).toEqual({ _id: bulkId, kept: 'updated' });
        expect(await bulkTarget.findOne({ _id: newId })).toEqual({ _id: newId, kept: 'inserted' });
        for (const valueFormat of [undefined, 'extended-json' as const]) {
            const date = new Date('2026-03-04T05:06:07Z');
            const marker = valueFormat ?? 'plain';
            await upsertMongoDb({
                connection,
                database: 'shop',
                collection: 'date_inputs',
                valueFormat,
                upserts: [{ filter: { marker }, document: { nested: { date }, text: date.toISOString() } }],
                signal: new AbortController().signal,
            });
            const saved = await client.db('shop').collection('date_inputs').findOne({ marker });
            expect(saved?.nested.date).toBeInstanceOf(Date);
            expect(saved?.nested.date).toEqual(date);
            expect(saved?.text).toBe(date.toISOString());
        }
        const after = await target.findOne({ _id: id }, { promoteValues: false });
        expect(BSON.EJSON.serialize(after, { relaxed: false })).toEqual(BSON.EJSON.serialize(before, { relaxed: false }));

        const flow: ExecutableFlow = {
            project: 'Test',
            flow: 'BSON copy',
            parameters: [],
            nodes: [
                { id: 'start', type: 'start', label: 'Start', config: {} },
                {
                    id: 'read',
                    type: 'mongodb-pipeline',
                    label: 'Read',
                    override: true,
                    config: {
                        connectionString: 'MONGO',
                        database: 'shop',
                        collection: 'bson_source',
                        pipeline: '[]',
                        outputFormat: 'extended-json',
                    },
                },
                {
                    id: 'write',
                    type: 'mongodb-upsert',
                    label: 'Write',
                    config: {
                        connectionString: 'MONGO',
                        database: 'shop',
                        collection: 'bson_flow_target',
                        filter: [{ field: '_id', value: '$_id', expression: true }],
                        valueFormat: 'extended-json',
                    },
                },
                { id: 'end', type: 'end', label: 'End', config: {} },
            ],
            edges: [
                { source: 'start', sourcePort: 'out-0', target: 'read', targetPort: 'in-0' },
                { source: 'read', sourcePort: 'out-0', target: 'write', targetPort: 'in-0' },
                { source: 'write', sourcePort: 'out-0', target: 'end', targetPort: 'in-0' },
            ],
        };
        const run = await flowRunner(flow, {
            mode: 'execution',
            id: 'mongo-bson',
            evaluate,
            documentQueries: { mongodb: aggregateMongoDb },
            documentStores: { mongodb: upsertMongoDb },
            secrets: { MONGO: connection },
        });
        expect(run.status).toBe('completed');
        const throughFlow = await client.db('shop').collection('bson_flow_target').findOne({ _id: id }, { promoteValues: false });
        expect(BSON.EJSON.serialize(throughFlow, { relaxed: false })).toEqual(BSON.EJSON.serialize(before, { relaxed: false }));

        await client
            .db('shop')
            .collection('ambiguous')
            .insertOne({ literal: { $numberInt: '12' } });
        const ambiguous = async () => {
            for await (const _ of aggregateMongoDb({
                connection,
                database: 'shop',
                collection: 'ambiguous',
                pipeline: [],
                outputFormat: 'extended-json',
                timeoutMs: 30_000,
                signal: new AbortController().signal,
            })) {
                throw new Error('Expected serialization to reject the document.');
            }
        };
        await expect(ambiguous()).rejects.toThrow('cannot be represented losslessly');
    } finally {
        await client.close();
    }
});
