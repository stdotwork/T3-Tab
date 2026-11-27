import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PROTOCOL_VERSION } from '@t3-tab/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';

import { DaemonSession } from '../src/client.js';
import { browserToolHandler, SESSION_RESTARTED_NOTICE } from '../src/mcp.js';

interface FakeDaemon {
  port: number;
  /** What each registration carried, in order. */
  registrations: Array<{ claim?: unknown; claimFileProblem?: unknown }>;
  sockets: Set<WebSocket>;
  /** Hold tool answers until called, so a call can be in flight when the connection closes. */
  holdTools: boolean;
  /** Make the next registrations fail with this error. */
  refuseRegistration: string | undefined;
  stop(): Promise<void>;
}

const TOKEN = 'test-token';
let directory: string;
let daemons: FakeDaemon[] = [];

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 't3-tab-reconnect-'));
  daemons = [];
});

afterEach(async () => {
  for (const daemon of daemons) await daemon.stop();
  await rm(directory, { recursive: true, force: true });
});

/** A stand-in for the daemon: answers /health, registers sessions and answers tool calls with the session id. */
async function startFake(): Promise<FakeDaemon> {
  const http: Server = createServer((request, response) => {
    if (request.url === '/health' && request.headers.authorization === `Bearer ${TOKEN}`) {
      response.setHeader('content-type', 'application/json');
      response.end('{"ok":true}');
    } else {
      response.statusCode = 401;
      response.end();
    }
  });
  const sockets = new Set<WebSocket>();
  const wss = new WebSocketServer({ server: http });
  const daemon: FakeDaemon = {
    port: 0,
    registrations: [],
    sockets,
    holdTools: false,
    refuseRegistration: undefined,
    stop: async () => {
      for (const socket of sockets) socket.terminate();
      wss.close();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
  let counter = 0;
  wss.on('connection', (socket) => {
    sockets.add(socket);
    let id = '';
    socket.on('close', () => sockets.delete(socket));
    socket.on('message', (data) => {
      const request = JSON.parse(data.toString()) as Record<string, unknown> & { requestId: string; method: string };
      const reply = (ok: boolean, result: unknown): void => {
        socket.send(
          JSON.stringify({ type: 'control.response', protocolVersion: PROTOCOL_VERSION, requestId: request.requestId, ok, ...(ok ? { result } : { error: result }) }),
        );
      };
      if (request.method === 'session.register') {
        daemon.registrations.push({ claim: request.claim, claimFileProblem: request.claimFileProblem });
        if (daemon.refuseRegistration !== undefined) return reply(false, daemon.refuseRegistration);
        id = `s${++counter}-${daemon.port}`;
        return reply(true, { session: { id, name: `fake · ${id}` } });
      }
      if (daemon.holdTools) return;
      reply(true, { content: [{ type: 'text', text: `ok from ${id}` }] });
    });
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  daemon.port = (http.address() as AddressInfo).port;
  daemons.push(daemon);
  const stateDir = join(directory, 't3-tab');
  await mkdir(stateDir, { recursive: true });
  await writeFile(
    join(stateDir, 'daemon.json'),
    JSON.stringify({ protocolVersion: PROTOCOL_VERSION, pid: process.pid, port: daemon.port, token: TOKEN }),
  );
  return daemon;
}

const env = (): NodeJS.ProcessEnv => ({ ...process.env, XDG_STATE_HOME: directory });
const text = (content: Array<{ type: string; text?: string }>): string => content.map((part) => part.text).join('\n');

describe('DaemonSession after its connection closes', () => {
  it('registers a new session on the next call instead of failing for good', async () => {
    const first = await startFake();
    const session = new DaemonSession(env());
    expect(session.link()).toBe('not-started');
    expect(text(await session.callTool('tabs', {}))).toContain('ok from s1');
    expect(session.link()).toBe('connected');

    await first.stop();
    await waitFor(() => session.link() === 'ended');
    const second = await startFake();

    expect(text(await session.callTool('tabs', {}))).toBe(`ok from s1-${second.port}`);
    expect(session.link()).toBe('connected');
    expect(second.registrations).toHaveLength(1);
  });

  it('fails a call that was in flight when the connection closed, and the one after it works', async () => {
    const first = await startFake();
    first.holdTools = true;
    const session = new DaemonSession(env());
    await session.register();
    const inFlight = session.callTool('read', {});
    inFlight.catch(() => undefined);
    await waitFor(() => first.sockets.size === 1);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await first.stop();
    await expect(inFlight).rejects.toThrow(/did not finish and its result is unknown/);

    await startFake();
    expect(text(await session.callTool('read', {}))).toMatch(/^ok from /);
  });

  it('sends the claim code and claim-file report with the first registration only', async () => {
    const first = await startFake();
    const problem = { file: '/x', problem: 'missing' } as never;
    const session = new DaemonSession(env(), 'ABCD-CLAIM', problem);
    await session.register();
    expect(first.registrations[0]).toEqual({ claim: 'ABCD-CLAIM', claimFileProblem: problem });

    await first.stop();
    await waitFor(() => session.link() === 'ended');
    const second = await startFake();
    await session.register();
    expect(second.registrations).toEqual([{}]);
  });

  it('keeps the claim code until a registration succeeds', async () => {
    const daemon = await startFake();
    daemon.refuseRegistration = 'not now';
    const session = new DaemonSession(env(), 'ABCD-CLAIM');
    await expect(session.register()).rejects.toThrow('not now');
    daemon.refuseRegistration = undefined;
    await session.register();
    expect(daemon.registrations.map((entry) => entry.claim)).toEqual(['ABCD-CLAIM', 'ABCD-CLAIM']);
  });

  it('says why a new session could not be started, and tries again on the next call', async () => {
    const first = await startFake();
    const session = new DaemonSession(env());
    await session.register();
    await first.stop();
    await waitFor(() => session.link() === 'ended');
    const second = await startFake();
    second.refuseRegistration = 'protocol version mismatch';

    await expect(session.callTool('tabs', {})).rejects.toThrow(
      'The earlier T3-Tab session ended and a new one could not be started: protocol version mismatch',
    );
    expect(session.link()).toBe('ended');

    second.refuseRegistration = undefined;
    expect(text(await session.callTool('tabs', {}))).toMatch(/^ok from /);
    expect(session.takeReconnected()).toBe(true);
  });

  it('reports a restart once through the tool reply', async () => {
    const first = await startFake();
    const session = new DaemonSession(env());
    const tool = browserToolHandler(session, () => [])('tabs');

    const initial = await tool({});
    expect(text(initial.content)).not.toContain(SESSION_RESTARTED_NOTICE);

    await first.stop();
    await waitFor(() => session.link() === 'ended');
    await startFake();

    const afterRestart = await tool({});
    expect(afterRestart.content[0]).toEqual({ type: 'text', text: SESSION_RESTARTED_NOTICE });
    expect(afterRestart.content).toHaveLength(2);
    const later = await tool({});
    expect(later.content).toHaveLength(1);
    expect(text(later.content)).not.toContain(SESSION_RESTARTED_NOTICE);
  });
});

async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
