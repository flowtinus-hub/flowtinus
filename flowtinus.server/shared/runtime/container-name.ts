import { createSocket } from 'node:dgram';
import { readFile } from 'node:fs/promises';
import { hostname, networkInterfaces } from 'node:os';

/*
 * The name a person knows this process by. In a container its host name is the container's id (25efe099bfcf); the
 * Docker DNS knows its name (flowtinus-supervisor-1.flowtinus_default), so this asks it (a PTR query of its own IP, by
 * hand: Bun's dns.reverse answers nothing there). Compose's project prefix goes (supervisor-1). SUPERVISOR_NAME wins;
 * outside Docker, or when the DNS does not answer, the host name.
 */

export function ptrQuery(ip: string, id: number): Buffer {
    const name = `${ip.split('.').reverse().join('.')}.in-addr.arpa`;
    const labels = name.split('.').map(label => Buffer.concat([Buffer.from([label.length]), Buffer.from(label, 'ascii')]));
    const header = Buffer.alloc(12);
    header.writeUInt16BE(id, 0);
    header.writeUInt16BE(0x0100, 2);
    header.writeUInt16BE(1, 4);
    // type PTR (12), class IN (1)
    return Buffer.concat([header, ...labels, Buffer.from([0, 0, 12, 0, 1])]);
}

function readName(message: Buffer, offset: number): { name: string; end: number } {
    const labels: string[] = [];
    let at = offset;
    let end = -1;
    for (let hops = 0; hops < 64; hops++) {
        const length = message[at];
        if (length === undefined) {
            break;
        }

        if (length === 0) {
            at += 1;
            break;
        }

        if ((length & 0xc0) === 0xc0) {
            if (end < 0) {
                end = at + 2;
            }

            at = ((length & 0x3f) << 8) | (message[at + 1] ?? 0);
            continue;
        }

        labels.push(message.toString('ascii', at + 1, at + 1 + length));
        at += 1 + length;
    }

    return { name: labels.join('.'), end: end < 0 ? at : end };
}

export function ptrAnswer(message: Buffer): string | null {
    if (message.length < 12 || (message.readUInt16BE(2) & 0x000f) !== 0) {
        return null;
    }

    const questions = message.readUInt16BE(4);
    const answers = message.readUInt16BE(6);
    let at = 12;
    for (let i = 0; i < questions; i++) {
        at = readName(message, at).end + 4;
    }

    for (let i = 0; i < answers; i++) {
        const { end } = readName(message, at);
        const type = message.readUInt16BE(end);
        const length = message.readUInt16BE(end + 8);
        if (type === 12) {
            return readName(message, end + 10).name || null;
        }

        at = end + 10 + length;
    }

    return null;
}

export function containerName(dnsName: string): string {
    const [container = dnsName, ...rest] = dnsName.split('.');
    const network = rest.join('.');
    const project = network.endsWith('_default') ? network.slice(0, -'_default'.length) : '';
    return project && container.startsWith(`${project}-`) && container.length > project.length + 1
        ? container.slice(project.length + 1)
        : container;
}

async function nameserver(): Promise<string | null> {
    const conf = await readFile('/etc/resolv.conf', 'utf8').catch(() => '');
    return /^nameserver\s+(\d+\.\d+\.\d+\.\d+)/m.exec(conf)?.[1] ?? null;
}

export function reverseLookup(ip: string, server: string, timeoutMs = 1000): Promise<string | null> {
    return new Promise(resolve => {
        const socket = createSocket('udp4');
        const id = Math.floor(Math.random() * 0xffff);
        const done = (name: string | null) => {
            clearTimeout(timer);
            socket.close();
            resolve(name);
        };
        const timer = setTimeout(() => done(null), timeoutMs);
        socket.on('error', () => done(null));
        socket.on('message', message => done(message.readUInt16BE(0) === id ? ptrAnswer(message) : null));
        socket.send(ptrQuery(ip, id), 53, server);
    });
}

export async function processName(env: Record<string, string | undefined> = process.env): Promise<string> {
    const given = env.SUPERVISOR_NAME?.trim();
    if (given) {
        return given;
    }

    const ip = Object.values(networkInterfaces())
        .flat()
        .find(i => i?.family === 'IPv4' && !i.internal)?.address;
    const server = await nameserver();
    // Docker's own DNS (user-defined networks): elsewhere a PTR answer is the machine's, not a container's
    if (!ip || server !== '127.0.0.11') {
        return hostname();
    }

    const name = await reverseLookup(ip, server).catch(() => null);
    return name ? containerName(name) : hostname();
}
