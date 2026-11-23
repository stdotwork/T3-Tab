import { readdir, readFile, readlink } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { connect, type Socket } from 'node:net';
import { endianness } from 'node:os';
import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';

/** The process T3 recorded in `server-runtime.json`. */
export interface T3Process {
  pid: number;
  /** When T3 wrote its record, in milliseconds since the epoch. */
  startedAt: number;
}

export type T3Fetch = (url: string | URL, init?: RequestInit) => Promise<Response>;

const UNCONFIRMED = 'T3-Tab could not confirm that the running T3 Code owns its address, so it sent nothing.';
const CONNECT_TIMEOUT_MS = 5_000;
const ACCEPT_TIMEOUT_MS = 2_000;
const ACCEPT_POLL_MS = 10;
// Linux reports process start times in units of 1/100 s on every architecture Node.js supports.
const MS_PER_TICK = 10;
const ESTABLISHED = '01';

/** Thrown with one fixed message before anything is written to the connection. */
export class T3ConnectionError extends Error {
  constructor() {
    super(UNCONFIRMED);
  }
}

/**
 * A `fetch` for one T3 origin that sends a request only on a connection the recorded T3 process accepted.
 *
 * Each request opens its own TCP connection. Before a byte is written, the server's end of that exact connection is
 * looked up in `/proc/net/tcp{,6}` and its socket must be among the open files of the recorded pid, and that process
 * must not have started after T3 wrote its record. The request then goes out on the same socket, so no name is resolved
 * again between the check and the send. Without `/proc` (any platform but Linux) nothing is sent. Redirects are refused.
 */
export function confirmedFetch(origin: string, owner: T3Process): T3Fetch {
  return async (url, init = {}) => {
    const target = new URL(url);
    if (target.origin !== origin || target.protocol !== 'http:') throw new T3ConnectionError();
    init.signal?.throwIfAborted();
    const socket = await openConfirmed(target, owner, init.signal ?? undefined);
    try {
      return await send(socket, target, init);
    } catch (error) {
      socket.destroy();
      throw error;
    }
  };
}

async function openConfirmed(target: URL, owner: T3Process, signal: AbortSignal | undefined): Promise<Socket> {
  if (process.platform !== 'linux') throw new T3ConnectionError();
  const socket = await open(target, signal);
  try {
    await confirmOwner(socket, owner, signal);
    return socket;
  } catch (error) {
    socket.destroy();
    if (signal?.aborted === true) throw error;
    throw new T3ConnectionError();
  }
}

async function open(target: URL, signal: AbortSignal | undefined): Promise<Socket> {
  const socket = connect({ host: target.hostname.replace(/^\[|\]$/g, ''), port: Number(target.port || 80) });
  // The request takes over error reporting once it is sent; until then a failure is reported by the steps below.
  socket.on('error', () => undefined);
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new T3ConnectionError()), CONNECT_TIMEOUT_MS);
      const finish = (error?: unknown): void => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        if (error === undefined) resolve();
        else reject(error instanceof Error ? error : new T3ConnectionError());
      };
      const onAbort = (): void => finish(signal?.reason);
      signal?.addEventListener('abort', onAbort, { once: true });
      socket.once('connect', () => finish());
      socket.once('error', () => finish(new T3ConnectionError()));
    });
    return socket;
  } catch (error) {
    socket.destroy();
    throw error;
  }
}

async function confirmOwner(socket: Socket, owner: T3Process, signal: AbortSignal | undefined): Promise<void> {
  const server = endpoint(socket.remoteAddress, socket.remotePort);
  const client = endpoint(socket.localAddress, socket.localPort);
  if (server === undefined || client === undefined || !isLoopback(server.address)) throw new T3ConnectionError();

  const deadline = Date.now() + ACCEPT_TIMEOUT_MS;
  for (;;) {
    signal?.throwIfAborted();
    // A connection still waiting to be accepted has inode 0: it belongs to no process yet.
    const inode = await serverSocketInode(server, client);
    if (inode !== undefined && inode !== '0') {
      if (!(await processHoldsSocket(owner.pid, inode))) throw new T3ConnectionError();
      if ((await processStartMs(owner.pid)) > owner.startedAt) throw new T3ConnectionError();
      return;
    }
    if (Date.now() >= deadline) throw new T3ConnectionError();
    await new Promise((resolve) => setTimeout(resolve, ACCEPT_POLL_MS));
  }
}

interface Endpoint {
  address: string;
  port: number;
}

function endpoint(address: string | undefined, port: number | undefined): Endpoint | undefined {
  if (address === undefined || port === undefined) return undefined;
  return { address: address.toLowerCase().replace(/^::ffff:(?=\d+\.)/, ''), port };
}

function isLoopback(address: string): boolean {
  return address === '::1' || /^127\.\d+\.\d+\.\d+$/.test(address);
}

/** The inode of the server's end of this connection: the row whose local end is the server and remote end is us. */
async function serverSocketInode(server: Endpoint, client: Endpoint): Promise<string | undefined> {
  for (const table of ['/proc/net/tcp', '/proc/net/tcp6']) {
    const rows = await readFile(table, 'utf8').catch(() => '');
    for (const row of rows.split('\n').slice(1)) {
      const fields = row.trim().split(/\s+/);
      if (fields.length < 10 || fields[3] !== ESTABLISHED) continue;
      if (sameEndpoint(fields[1], server) && sameEndpoint(fields[2], client)) return fields[9];
    }
  }
  return undefined;
}

function sameEndpoint(field: string | undefined, expected: Endpoint): boolean {
  const [address, port] = (field ?? '').split(':');
  return address !== undefined && port !== undefined && Number.parseInt(port, 16) === expected.port && procAddress(address) === expected.address;
}

/** `/proc/net/tcp` prints an address as 32-bit words in host byte order; only loopback forms are named here. */
function procAddress(hex: string): string | undefined {
  const words = hex.match(/.{8}/g) ?? [];
  const bytes = words.flatMap((word) => {
    const value = Buffer.from(word, 'hex');
    return [...(endianness() === 'LE' ? value.reverse() : value)];
  });
  if (bytes.length === 4) return bytes.join('.');
  if (bytes.length !== 16) return undefined;
  if (bytes.slice(0, 15).every((byte) => byte === 0) && bytes[15] === 1) return '::1';
  const mapped = bytes.slice(0, 10).every((byte) => byte === 0) && bytes[10] === 0xff && bytes[11] === 0xff;
  return mapped ? bytes.slice(12).join('.') : undefined;
}

/** The inode of a client's end of a loopback connection to this process, or undefined when it has none. */
export async function peerSocketInode(
  peer: { address: string | undefined; port: number | undefined },
  local: { address: string | undefined; port: number | undefined },
): Promise<string | undefined> {
  const peerEnd = endpoint(peer.address, peer.port);
  const localEnd = endpoint(local.address, local.port);
  if (peerEnd === undefined || localEnd === undefined || !isLoopback(peerEnd.address)) return undefined;
  const inode = await serverSocketInode(peerEnd, localEnd);
  return inode === '0' ? undefined : inode;
}

export async function processHoldsSocket(pid: number, inode: string): Promise<boolean> {
  const directory = `/proc/${pid}/fd`;
  const expected = `socket:[${inode}]`;
  for (const entry of await readdir(directory)) {
    const link = await readlink(`${directory}/${entry}`).catch(() => undefined);
    if (link === expected) return true;
  }
  return false;
}

/**
 * When the process started, rounded down: the boot time in `/proc/stat` drops its fraction of a second and the start
 * time drops its fraction of a tick, so the result is at most 1.01 s before the real start and never after it. T3 writes
 * its record after it starts, so the real T3 passes with no tolerance, and a process that started more than 1.01 s after
 * the record is refused. The boot time moves when the wall clock is stepped: a forward step after T3 started, larger
 * than the time T3 took to write its record plus that rounding, refuses T3 until it restarts. A backward step makes
 * processes look as if they started earlier, so a process that reused T3's recorded pid could pass this check; it still
 * has to hold the accepted connection, and programs running as the owner are outside T3-Tab's trust model anyway.
 */
export async function processStartMs(pid: number): Promise<number> {
  const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
  // The command name, field 2, may hold spaces and brackets; field 22 is the start time in ticks after boot.
  const ticks = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]);
  const bootSeconds = Number(/^btime (\d+)$/m.exec(await readFile('/proc/stat', 'utf8'))?.[1]);
  if (!Number.isFinite(ticks) || !Number.isFinite(bootSeconds)) throw new T3ConnectionError();
  return bootSeconds * 1_000 + ticks * MS_PER_TICK;
}

async function send(socket: Socket, target: URL, init: RequestInit): Promise<Response> {
  const headers: Record<string, string> = { host: target.host, ...Object.fromEntries(new Headers(init.headers)) };
  if (init.body !== undefined && init.body !== null && typeof init.body !== 'string') throw new TypeError('Only text bodies are sent to T3');
  const body = init.body ?? undefined;
  if (body !== undefined) headers['content-length'] = String(Buffer.byteLength(body));
  return await new Promise<Response>((resolve, reject) => {
    const request = httpRequest(
      {
        createConnection: () => socket,
        method: init.method ?? 'GET',
        path: `${target.pathname}${target.search}`,
        headers,
        ...(init.signal === undefined || init.signal === null ? {} : { signal: init.signal }),
      },
      (message) => {
        const status = message.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          request.destroy();
          reject(new TypeError('T3 Code answered with a redirect'));
          return;
        }
        try {
          const answer = new Headers();
          for (let index = 0; index + 1 < message.rawHeaders.length; index += 2) {
            answer.append(message.rawHeaders[index] as string, message.rawHeaders[index + 1] as string);
          }
          const empty = status === 204 || status === 205 || (init.method ?? 'GET') === 'HEAD';
          if (empty) message.resume();
          const stream = empty ? null : (Readable.toWeb(message) as NodeReadableStream<Uint8Array> as ReadableStream<Uint8Array>);
          resolve(new Response(stream, { status, statusText: message.statusMessage ?? '', headers: answer }));
        } catch (error) {
          request.destroy();
          reject(error instanceof Error ? error : new TypeError('T3 Code sent an answer T3-Tab cannot read'));
        }
      },
    );
    request.on('error', reject);
    request.end(body);
  });
}
