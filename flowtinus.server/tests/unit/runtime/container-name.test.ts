import { describe, expect, test } from 'bun:test';
import { containerName, processName, ptrAnswer, ptrQuery } from '#shared/runtime/container-name';

/** Docker DNS's answer to a PTR query: the question back, one PTR record pointing at it (compressed) */
function reply(query: Buffer, name: string): Buffer {
    const header = Buffer.from(query.subarray(0, 12));
    header.writeUInt16BE(0x8180, 2);
    header.writeUInt16BE(1, 6);
    const data = Buffer.concat([...name.split('.').map(l => Buffer.concat([Buffer.from([l.length]), Buffer.from(l)])), Buffer.from([0])]);
    const record = Buffer.alloc(12);
    record.writeUInt16BE(0xc00c, 0);
    record.writeUInt16BE(12, 2);
    record.writeUInt16BE(1, 4);
    record.writeUInt32BE(600, 6);
    record.writeUInt16BE(data.length, 10);
    return Buffer.concat([header, query.subarray(12), record, data]);
}

describe('container name', () => {
    test('the PTR query of an IP, and the name in its answer', () => {
        const query = ptrQuery('172.24.0.5', 0x1234);
        expect(query.readUInt16BE(0)).toBe(0x1234);
        expect(query.toString('ascii')).toContain('in-addr');
        expect(ptrAnswer(reply(query, 'flowtinus-supervisor-1.flowtinus_default'))).toBe('flowtinus-supervisor-1.flowtinus_default');
        // an error answer (NXDOMAIN) or one without records: none
        const failed = Buffer.from(query);
        failed.writeUInt16BE(0x8183, 2);
        expect(ptrAnswer(failed)).toBeNull();
    });

    test("without the network nor Compose's project prefix", () => {
        expect(containerName('flowtinus-supervisor-1.flowtinus_default')).toBe('supervisor-1');
        expect(containerName('flowtinus-supervisor-super-parallel.flowtinus_default')).toBe('supervisor-super-parallel');
        // another network (not a project's default one), or no prefix: as it is
        expect(containerName('workers-a.backend')).toBe('workers-a');
        expect(containerName('flowtinus.flowtinus_default')).toBe('flowtinus');
    });

    test('SUPERVISOR_NAME wins', async () => {
        expect(await processName({ SUPERVISOR_NAME: ' box-a ' })).toBe('box-a');
    });
});
