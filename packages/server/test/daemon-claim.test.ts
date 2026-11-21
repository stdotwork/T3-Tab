import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { EXTENSION_ORIGIN, PROTOCOL_VERSION, type ToolSession } from '@t3-tab/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';

import { Agents } from '../src/agents/conversations.js';
import { startDaemon, type DaemonHandle } from '../src/index.js';

const CODE = 'abcdefghijklmnop1234';

let daemon: DaemonHandle | undefined;
let directory: string | undefined;
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  await daemon?.close();
  daemon = undefined;
  if (directory !== undefined) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

async function start(): Promise<DaemonHandle> {
  directory = await mkdtemp(join(tmpdir(), 't3-tab-daemon-claim-'));
  const agents = new Agents({ env: { PATH: '' }, server: { command: 'node', args: [] } });
  daemon = await startDaemon({ port: 0, stateDir: directory, agents });
  return daemon;
}

async function open(handle: DaemonHandle, origin?: string): Promise<WebSocket> {
  const socket = new WebSocket(`ws://127.0.0.1:${handle.port}/`, {
    headers: { authorization: `Bearer ${origin === undefined ? handle.token : handle.extensionToken}`, ...(origin === undefined ? {} : { origin }) },
  });
  sockets.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve());
    socket.once('error', reject);
  });
  return socket;
}

async function next(socket: WebSocket): Promise<Record<string, unknown>> {
  return await new Promise<Record<string, unknown>>((resolve) => {
    socket.once('message', (data) => resolve(JSON.parse(data.toString()) as Record<string, unknown>));
  });
}

async function registerRaw(handle: DaemonHandle, claim?: string): Promise<{ socket: WebSocket; response: Record<string, unknown> }> {
  const socket = await open(handle);
  const reply = next(socket);
  socket.send(
    JSON.stringify({
      type: 'control.request',
      protocolVersion: PROTOCOL_VERSION,
      requestId: 'register',
      method: 'session.register',
      clientName: 'Agent',
      ...(claim === undefined ? {} : { claim }),
    }),
  );
  return { socket, response: await reply };
}

async function tool(socket: WebSocket, session: ToolSession): Promise<Record<string, unknown>> {
  const reply = next(socket);
  socket.send(
    JSON.stringify({
      type: 'control.request',
      protocolVersion: PROTOCOL_VERSION,
      requestId: `r-${Math.random()}`,
      session,
      method: 'tabs',
      params: {},
    }),
  );
  return await reply;
}

async function fakeExtension(handle: DaemonHandle): Promise<Array<Record<string, unknown>>> {
  const browser = await open(handle, EXTENSION_ORIGIN);
  const seen: Array<Record<string, unknown>> = [];
  browser.on('message', (data) => {
    const message = JSON.parse(data.toString()) as Record<string, unknown>;
    if (message.type !== 'browser.request') return;
    seen.push(message);
    const result =
      message.method === 'tabs.list' ? { tabs: [] } : message.method === 'session.claim' ? { shared: [3] } : { registered: true };
    browser.send(JSON.stringify({ type: 'browser.response', protocolVersion: PROTOCOL_VERSION, requestId: message.requestId, ok: true, result }));
  });
  return seen;
}

describe('claim codes through the daemon', () => {
  it('sends session.claim once, after session.register and before the first tool request', async () => {
    const handle = await start();
    const seen = await fakeExtension(handle);
    const { socket, response } = await registerRaw(handle, CODE);
    expect(response).toMatchObject({ ok: true });
    const session = (response.result as { session: ToolSession }).session;

    expect(await tool(socket, session)).toMatchObject({ ok: true });
    const methods = (): unknown[] => seen.map((message) => message.method);
    const claimAt = methods().indexOf('session.claim');
    expect(methods().filter((method) => method === 'session.claim')).toHaveLength(1);
    expect(methods().slice(0, claimAt)).toContain('session.register');
    expect(methods()[claimAt + 1]).toBe('tabs.list');
    expect(seen[claimAt]).toMatchObject({ session, params: { code: CODE } });

    const before = seen.length;
    expect(await tool(socket, session)).toMatchObject({ ok: true });
    expect(seen.slice(before).map((message) => message.method)).toEqual(['session.register', 'tabs.list']);
  });

  it('does not send session.claim for a session that registered without a code', async () => {
    const handle = await start();
    const seen = await fakeExtension(handle);
    const { socket, response } = await registerRaw(handle);
    await tool(socket, (response.result as { session: ToolSession }).session);
    expect(seen.map((message) => message.method)).not.toContain('session.claim');
  });

  it('still runs the tool when the browser refuses the claim', async () => {
    const handle = await start();
    const browser = await open(handle, EXTENSION_ORIGIN);
    browser.on('message', (data) => {
      const message = JSON.parse(data.toString()) as Record<string, unknown>;
      const claim = message.method === 'session.claim';
      browser.send(
        JSON.stringify({
          type: 'browser.response',
          protocolVersion: PROTOCOL_VERSION,
          requestId: message.requestId,
          ...(claim
            ? { ok: false, error: 'Unknown claim code' }
            : { ok: true, result: message.method === 'tabs.list' ? { tabs: [] } : { registered: true } }),
        }),
      );
    });
    const { socket, response } = await registerRaw(handle, CODE);
    expect(await tool(socket, (response.result as { session: ToolSession }).session)).toMatchObject({ ok: true });
  });

  it.each(['short', 'has spaces in it 12345', `${'a'.repeat(65)}`])('refuses an invalid claim %j', async (claim) => {
    const handle = await start();
    const { response } = await registerRaw(handle, claim);
    expect(response).toMatchObject({ ok: false, error: 'Invalid claim code' });
  });

  it('refuses a claim that is not a string', async () => {
    const handle = await start();
    const socket = await open(handle);
    const reply = next(socket);
    socket.send(
      JSON.stringify({
        type: 'control.request',
        protocolVersion: PROTOCOL_VERSION,
        requestId: 'register',
        method: 'session.register',
        clientName: 'Agent',
        claim: 1234567890123456,
      }),
    );
    expect(await reply).toMatchObject({ ok: false, error: 'Invalid claim code' });
  });
});

describe('side-panel requests through the daemon', () => {
  it('answers agents.list from the extension socket', async () => {
    const handle = await start();
    const browser = await open(handle, EXTENSION_ORIGIN);
    const reply = next(browser);
    browser.send(JSON.stringify({ type: 'browser.daemonRequest', protocolVersion: PROTOCOL_VERSION, requestId: 'q1', method: 'agents.list', params: {} }));
    expect(await reply).toEqual({
      type: 'daemon.reply',
      protocolVersion: PROTOCOL_VERSION,
      requestId: 'q1',
      ok: true,
      result: { conversations: [] },
    });
  });

  it('answers an invalid agents.start with ok:false and the reason', async () => {
    const handle = await start();
    const browser = await open(handle, EXTENSION_ORIGIN);
    const reply = next(browser);
    browser.send(JSON.stringify({ type: 'browser.daemonRequest', protocolVersion: PROTOCOL_VERSION, requestId: 'q2', method: 'agents.start', params: { via: 'claude', message: 'x', claim: 'short' } }));
    expect(await reply).toMatchObject({ type: 'daemon.reply', requestId: 'q2', ok: false, error: 'Invalid claim code' });
  });

  it('answers an unknown method with ok:false', async () => {
    const handle = await start();
    const browser = await open(handle, EXTENSION_ORIGIN);
    const reply = next(browser);
    browser.send(JSON.stringify({ type: 'browser.daemonRequest', protocolVersion: PROTOCOL_VERSION, requestId: 'q3', method: 'agents.nope', params: {} }));
    expect(await reply).toMatchObject({ requestId: 'q3', ok: false, error: 'Unknown method: agents.nope' });
  });
});
