import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { EXTENSION_ORIGIN, PROTOCOL_VERSION, type ToolSession } from '@t3-tab/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';

import { startDaemon, type DaemonHandle } from '../src/index.js';

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
  directory = await mkdtemp(join(tmpdir(), 't3-tab-daemon-tools-'));
  daemon = await startDaemon({ port: 0, stateDir: directory });
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

async function register(handle: DaemonHandle, clientName = 'Agent'): Promise<{ socket: WebSocket; session: ToolSession }> {
  const socket = await open(handle);
  const reply = next(socket);
  socket.send(
    JSON.stringify({
      type: 'control.request',
      protocolVersion: PROTOCOL_VERSION,
      requestId: 'register',
      method: 'session.register',
      clientName,
    }),
  );
  const response = await reply;
  expect(response).toMatchObject({ ok: true });
  const result = response.result as { session?: ToolSession } | undefined;
  if (result?.session === undefined) throw new Error('Daemon did not issue a session');
  expect(result.session.name.endsWith(result.session.id.slice(0, 8))).toBe(true);
  return { socket, session: result.session };
}

async function control(
  socket: WebSocket,
  session: ToolSession,
  request: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const reply = next(socket);
  socket.send(
    JSON.stringify({
      type: 'control.request',
      protocolVersion: PROTOCOL_VERSION,
      requestId: `r-${Math.random()}`,
      session,
      ...request,
    }),
  );
  return await reply;
}

describe('browser tools through the daemon', () => {
  it('binds the daemon-issued session id to its control socket', async () => {
    const handle = await start();
    const browser = await open(handle, EXTENSION_ORIGIN);
    browser.on('message', (data) => {
      const message = JSON.parse(data.toString()) as Record<string, unknown>;
      browser.send(
        JSON.stringify({
          type: 'browser.response',
          protocolVersion: PROTOCOL_VERSION,
          requestId: message.requestId,
          ok: true,
          result: { tabs: [] },
        }),
      );
    });
    const a = await register(handle, 'Agent A');
    const b = await register(handle, 'Agent B');
    expect(a.session.id).not.toBe(b.session.id);

    expect(await control(a.socket, b.session, { method: 'tabs', params: {} })).toMatchObject({
      ok: false,
      error: 'Session does not match this control connection',
    });
    expect(await control(b.socket, b.session, { method: 'tabs', params: {} })).toMatchObject({
      ok: true,
      result: { content: [{ type: 'text', text: 'No tabs.' }] },
    });

    const unregistered = await open(handle);
    expect(await control(unregistered, a.session, { method: 'tabs', params: {} })).toMatchObject({
      ok: false,
      error: 'Session is not registered on this control connection',
    });
  });

  it('does not broadcast registered sessions to a new extension connection', async () => {
    const handle = await start();
    const { socket, session } = await register(handle, 'Agent A');
    const browser = await open(handle, EXTENSION_ORIGIN);
    const seen: Record<string, unknown>[] = [];
    browser.on('message', (data) => {
      const message = JSON.parse(data.toString()) as Record<string, unknown>;
      seen.push(message);
      browser.send(
        JSON.stringify({
          type: 'browser.response',
          protocolVersion: PROTOCOL_VERSION,
          requestId: message.requestId,
          ok: true,
          result: message.method === 'tabs.list' ? { tabs: [] } : { registered: true },
        }),
      );
    });
    browser.send(JSON.stringify({ type: 'browser.hello', protocolVersion: PROTOCOL_VERSION, browserId: 'b2', browserName: 'Test' }));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(seen).toEqual([]);

    expect(await control(socket, session, { method: 'tabs', params: {} })).toMatchObject({ ok: true });
    expect(seen.map((message) => message.method)).toEqual(['session.register', 'tabs.list']);
  });

  it('forwards a tool call to the connected browser and returns its answer', async () => {
    const handle = await start();
    const browser = await open(handle, EXTENSION_ORIGIN);
    browser.send(JSON.stringify({ type: 'browser.hello', protocolVersion: PROTOCOL_VERSION, browserId: 'b1', browserName: 'Test' }));
    const seen: Record<string, unknown>[] = [];
    browser.on('message', (data) => {
      const message = JSON.parse(data.toString()) as Record<string, unknown>;
      seen.push(message);
      browser.send(
        JSON.stringify({
          type: 'browser.response',
          protocolVersion: PROTOCOL_VERSION,
          requestId: message.requestId,
          ok: true,
          result:
            message.method === 'tabs.list'
              ? { tabs: [{ id: 3, title: 'Home', url: 'http://localhost/', active: true }] }
              : { registered: true },
        }),
      );
    });
    const { socket, session } = await register(handle);

    const reply = await control(socket, session, { method: 'tabs', params: {} });
    expect(reply).toMatchObject({
      ok: true,
      result: { content: [{ type: 'text', text: '3 [front] Home — http://localhost/' }] },
    });
    const toolCall = seen.find((message) => message.method === 'tabs.list');
    expect(toolCall).toMatchObject({ type: 'browser.request', method: 'tabs.list', session, params: {} });
  });

  it('passes a browser error on to the caller', async () => {
    const handle = await start();
    const browser = await open(handle, EXTENSION_ORIGIN);
    browser.on('message', (data) => {
      const message = JSON.parse(data.toString()) as Record<string, unknown>;
      browser.send(
        JSON.stringify({
          type: 'browser.response',
          protocolVersion: PROTOCOL_VERSION,
          requestId: message.requestId,
          ok: message.method === 'session.register',
          ...(message.method === 'session.register' ? { result: { registered: true } } : { error: 'Cannot access a chrome:// URL' }),
        }),
      );
    });
    const { socket, session } = await register(handle);
    const reply = await control(socket, session, { method: 'read', params: {} });
    expect(reply).toMatchObject({ ok: false, error: 'Cannot access a chrome:// URL' });
  });

  it('says so when no browser is connected, and rejects a mismatched or malformed call', async () => {
    const handle = await start();
    const { socket, session } = await register(handle);
    expect(await control(socket, session, { method: 'tabs', params: {} })).toMatchObject({
      ok: false,
      error: expect.stringContaining('No browser is connected'),
    });
    expect(await control(socket, { id: 'different', name: 'Other' }, { method: 'tabs', params: {} })).toMatchObject({
      ok: false,
      error: 'Session does not match this control connection',
    });
    expect(await control(socket, session, { method: 'tabs', params: [] })).toMatchObject({ ok: false, error: 'Invalid params' });
    expect(await control(socket, session, { method: 'nope', params: {} })).toMatchObject({
      ok: false,
      error: 'Unknown method: nope',
    });
  });

  it('fails a waiting call when the browser disconnects', async () => {
    const handle = await start();
    const browser = await open(handle, EXTENSION_ORIGIN);
    browser.on('message', (data) => {
      const message = JSON.parse(data.toString()) as Record<string, unknown>;
      if (message.method === 'session.register') {
        browser.send(
          JSON.stringify({
            type: 'browser.response',
            protocolVersion: PROTOCOL_VERSION,
            requestId: message.requestId,
            ok: true,
            result: { registered: true },
          }),
        );
      } else {
        browser.terminate();
      }
    });
    const { socket, session } = await register(handle);
    expect(await control(socket, session, { method: 'tabs', params: {} })).toMatchObject({
      ok: false,
      error: 'The browser disconnected',
    });
  });

  it('answers extension keepalive pings without adding a browser', async () => {
    const handle = await start();
    const browser = await open(handle, EXTENSION_ORIGIN);
    const pong = next(browser);
    browser.send(JSON.stringify({ type: 'browser.ping', protocolVersion: PROTOCOL_VERSION }));
    expect(await pong).toMatchObject({ type: 'browser.pong', protocolVersion: PROTOCOL_VERSION });
    expect(browser.readyState).toBe(WebSocket.OPEN);
  });

  it('accepts a browser message larger than a control message may be', async () => {
    const handle = await start();
    const browser = await open(handle, EXTENSION_ORIGIN);
    const closed = new Promise<number>((resolve) => browser.once('close', (code) => resolve(code)));
    const big = 'x'.repeat(2_000_000);
    browser.send(JSON.stringify({ type: 'browser.response', protocolVersion: PROTOCOL_VERSION, requestId: 'none', ok: true, result: big }));
    const stillOpen = await Promise.race([closed.then(() => false), new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 300))]);
    expect(stillOpen).toBe(true);

    const control = await open(handle);
    const controlClosed = new Promise<number>((resolve) => control.once('close', (code) => resolve(code)));
    control.send(big);
    expect(await controlClosed).toBe(1009);
  });
});
