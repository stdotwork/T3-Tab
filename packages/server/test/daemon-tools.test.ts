import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { EXTENSION_ORIGIN, PROTOCOL_VERSION } from '@t3-tab/protocol';
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
    headers: { authorization: `Bearer ${handle.token}`, ...(origin === undefined ? {} : { origin }) },
  });
  sockets.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve());
    socket.once('error', reject);
  });
  return socket;
}

async function control(handle: DaemonHandle, request: Record<string, unknown>): Promise<Record<string, unknown>> {
  const socket = await open(handle);
  const reply = new Promise<Record<string, unknown>>((resolve) => {
    socket.once('message', (data) => resolve(JSON.parse(data.toString()) as Record<string, unknown>));
  });
  socket.send(JSON.stringify({ type: 'control.request', protocolVersion: PROTOCOL_VERSION, requestId: 'r1', ...request }));
  return await reply;
}

describe('browser tools through the daemon', () => {
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
          result: { tabs: [{ id: 3, title: 'Home', url: 'http://localhost/', active: true }] },
        }),
      );
    });

    const reply = await control(handle, { method: 'tabs', session: 'agent-1', params: {} });
    expect(reply).toMatchObject({
      ok: true,
      result: { content: [{ type: 'text', text: '3 [front] Home — http://localhost/' }] },
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ type: 'browser.request', method: 'tabs.list', params: {} });
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
          ok: false,
          error: 'Cannot access a chrome:// URL',
        }),
      );
    });
    const reply = await control(handle, { method: 'read', session: 'agent-1', params: {} });
    expect(reply).toMatchObject({ ok: false, error: 'Cannot access a chrome:// URL' });
  });

  it('says so when no browser is connected, and rejects a malformed call', async () => {
    const handle = await start();
    expect(await control(handle, { method: 'tabs', session: 'agent-1', params: {} })).toMatchObject({
      ok: false,
      error: expect.stringContaining('No browser is connected'),
    });
    expect(await control(handle, { method: 'tabs', params: {} })).toMatchObject({ ok: false, error: 'Invalid session' });
    expect(await control(handle, { method: 'tabs', session: 'a', params: [] })).toMatchObject({ ok: false, error: 'Invalid params' });
    expect(await control(handle, { method: 'nope', session: 'a', params: {} })).toMatchObject({
      ok: false,
      error: 'Unknown method: nope',
    });
  });

  it('fails a waiting call when the browser disconnects', async () => {
    const handle = await start();
    const browser = await open(handle, EXTENSION_ORIGIN);
    browser.on('message', () => browser.terminate());
    const reply = await control(handle, { method: 'tabs', session: 'agent-1', params: {} });
    expect(reply).toMatchObject({ ok: false, error: 'The browser disconnected' });
  });

  it('answers extension keepalive pings without adding a browser', async () => {
    const handle = await start();
    const browser = await open(handle, EXTENSION_ORIGIN);
    const pong = new Promise<Record<string, unknown>>((resolve) => {
      browser.once('message', (data) => resolve(JSON.parse(data.toString()) as Record<string, unknown>));
    });
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
