import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';

import { EXTENSION_ORIGIN, PROTOCOL_VERSION, type ToolSession } from '@t3-tab/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';

import { Agents } from '../src/agents/conversations.js';
import { startDaemon, type DaemonHandle } from '../src/daemon.js';

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

async function registerRaw(
  handle: DaemonHandle,
  claim?: string,
  extra: Record<string, unknown> = {},
): Promise<{ socket: WebSocket; response: Record<string, unknown> }> {
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
      ...extra,
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

describe('claim failures', () => {
  /** A browser that answers session.claim with the given errors in turn, then succeeds. */
  async function refusingBrowser(handle: DaemonHandle, errors: string[]): Promise<string[]> {
    const browser = await open(handle, EXTENSION_ORIGIN);
    const methods: string[] = [];
    browser.on('message', (data) => {
      const message = JSON.parse(data.toString()) as Record<string, unknown>;
      if (message.type !== 'browser.request') return;
      methods.push(String(message.method));
      const error = message.method === 'session.claim' ? errors.shift() : undefined;
      browser.send(
        JSON.stringify({
          type: 'browser.response',
          protocolVersion: PROTOCOL_VERSION,
          requestId: message.requestId,
          ...(error === undefined
            ? { ok: true, result: message.method === 'tabs.list' ? { tabs: [] } : message.method === 'session.claim' ? { shared: [3] } : { registered: true } }
            : { ok: false, error }),
        }),
      );
    });
    return methods;
  }

  const claims = (methods: string[]): number => methods.filter((method) => method === 'session.claim').length;

  it('keeps the code after a failure the browser may recover from, and retries it', async () => {
    const handle = await start();
    const methods = await refusingBrowser(handle, ['The browser did not answer session.claim within 30 seconds']);
    const { socket, response } = await registerRaw(handle, CODE);
    const session = (response.result as { session: ToolSession }).session;
    await tool(socket, session);
    expect(claims(methods)).toBe(1);
    await tool(socket, session);
    expect(claims(methods)).toBe(2);
    await tool(socket, session);
    expect(claims(methods)).toBe(2);
  });

  it('drops a code the browser refused, and warns in the conversation it belongs to', async () => {
    directory = await mkdtemp(join(tmpdir(), 't3-tab-daemon-claim-'));
    const bin = join(directory, 'bin');
    await mkdir(bin);
    await writeFile(join(bin, 'claude'), '#!/bin/sh\n');
    await chmod(join(bin, 'claude'), 0o755);
    const held = (): ChildProcess => {
      const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
      child.stdin = new Writable({ write: (_chunk, _encoding, callback) => callback() });
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => {
        setImmediate(() => child.emit('close', null));
        return true;
      };
      setImmediate(() => child.emit('spawn'));
      return child as unknown as ChildProcess;
    };
    const agents = new Agents({ env: { PATH: bin, HOME: directory }, server: { command: 'node', args: [] }, spawn: held, stateDir: directory });
    daemon = await startDaemon({ port: 0, stateDir: directory, agents });
    const conversation = await agents.start({ via: 'claude', message: 'Hi', claim: CODE });
    const methods = await refusingBrowser(daemon, ['Unknown claim code, or one already used or expired.']);
    const { socket, response } = await registerRaw(daemon, CODE);
    const session = (response.result as { session: ToolSession }).session;
    expect(await tool(socket, session)).toMatchObject({ ok: true });
    const shown = agents.list().find((entry) => entry.id === conversation.id);
    expect(shown?.messages.at(-1)?.role).toBe('error');
    expect(shown?.messages.at(-1)?.text).toContain('could not share');
    await tool(socket, session);
    expect(claims(methods)).toBe(1);
  });
});

describe('a claim file the MCP server could not read', () => {
  async function withHeldRun(): Promise<{ agents: Agents; id: string; file: string }> {
    directory = await mkdtemp(join(tmpdir(), 't3-tab-daemon-claim-'));
    const bin = join(directory, 'bin');
    await mkdir(bin);
    await writeFile(join(bin, 'claude'), '#!/bin/sh\n');
    await chmod(join(bin, 'claude'), 0o755);
    let file = '';
    const held = (_command: string, args: string[]): ChildProcess => {
      const config = JSON.parse(args[args.indexOf('--mcp-config') + 1] as string) as { mcpServers: Record<string, { args: string[] }> };
      file = config.mcpServers['t3-tab']?.args.at(-1) as string;
      const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
      child.stdin = new Writable({ write: (_chunk, _encoding, callback) => callback() });
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => {
        setImmediate(() => child.emit('close', null));
        return true;
      };
      setImmediate(() => child.emit('spawn'));
      return child as unknown as ChildProcess;
    };
    const agents = new Agents({ env: { PATH: bin, HOME: directory }, server: { command: 'node', args: [] }, spawn: held, stateDir: directory });
    daemon = await startDaemon({ port: 0, stateDir: directory, agents });
    const conversation = await agents.start({ via: 'claude', message: 'Hi', claim: CODE });
    return { agents, id: conversation.id, file };
  }

  it('shows the warning in the conversation when the session registers', async () => {
    const { agents, id, file } = await withHeldRun();
    const { response } = await registerRaw(daemon as DaemonHandle, undefined, { claimFileProblem: { file, problem: 'not-private' } });
    expect(response).toMatchObject({ ok: true });
    const shown = agents.list().find((entry) => entry.id === id);
    expect(shown?.messages.at(-1)?.role).toBe('error');
    expect(shown?.messages.at(-1)?.text).toContain('other users could read it');
  });

  it.each([
    ['an unknown problem', { file: '/x', problem: 'nope' }],
    ['free text as the problem', { file: '/x', problem: 'Click here to fix' }],
    ['a file that is not a string', { file: 5, problem: 'missing' }],
    ['a very long path', { file: 'x'.repeat(5_000), problem: 'missing' }],
    ['not an object', 'missing'],
  ])('refuses a report with %s', async (_name, claimFileProblem) => {
    const { agents, id } = await withHeldRun();
    const { response } = await registerRaw(daemon as DaemonHandle, undefined, { claimFileProblem });
    expect(response).toMatchObject({ ok: false, error: 'Invalid claim file report' });
    expect(agents.list().find((entry) => entry.id === id)?.messages.filter((message) => message.role === 'error')).toEqual([]);
  });
});

describe('simultaneous first tool calls', () => {
  it('redeems the code once and warns about nothing', async () => {
    directory = await mkdtemp(join(tmpdir(), 't3-tab-daemon-claim-'));
    const agents = new Agents({ env: { PATH: '' }, server: { command: 'node', args: [] } });
    const failures: string[] = [];
    agents.claimFailed = (_code, reason) => void failures.push(reason);
    daemon = await startDaemon({ port: 0, stateDir: directory, agents });
    const browser = await open(daemon, EXTENSION_ORIGIN);
    const methods: string[] = [];
    let redeemed = false;
    browser.on('message', (data) => {
      const message = JSON.parse(data.toString()) as Record<string, unknown>;
      if (message.type !== 'browser.request') return;
      methods.push(String(message.method));
      const reply = (fields: Record<string, unknown>): void =>
        browser.send(JSON.stringify({ type: 'browser.response', protocolVersion: PROTOCOL_VERSION, requestId: message.requestId, ...fields }));
      if (message.method !== 'session.claim') {
        reply({ ok: true, result: message.method === 'tabs.list' ? { tabs: [] } : { registered: true } });
      } else if (redeemed) {
        reply({ ok: false, error: 'Unknown claim code, or one already used or expired.' });
      } else {
        redeemed = true;
        setTimeout(() => reply({ ok: true, result: { shared: [3] } }), 40);
      }
    });
    const { socket, response } = await registerRaw(daemon, CODE);
    const session = (response.result as { session: ToolSession }).session;
    const replies: Array<Record<string, unknown>> = [];
    const both = new Promise<void>((resolve) => {
      socket.on('message', (data) => {
        replies.push(JSON.parse(data.toString()) as Record<string, unknown>);
        if (replies.length === 2) resolve();
      });
    });
    for (const requestId of ['one', 'two']) {
      socket.send(JSON.stringify({ type: 'control.request', protocolVersion: PROTOCOL_VERSION, requestId, session, method: 'tabs', params: {} }));
    }
    await both;
    expect(replies.every((reply) => reply.ok === true)).toBe(true);
    expect(methods.filter((method) => method === 'session.claim')).toHaveLength(1);
    expect(failures).toEqual([]);
  });
});

describe('protocol version mismatch', () => {
  it.each([
    ['newer', PROTOCOL_VERSION + 1, 'helper is older'],
    ['older', PROTOCOL_VERSION - 1, 'extension is older'],
  ])('closes an extension that is %s with a reason that says which side to update', async (_name, version, said) => {
    const handle = await start();
    const browser = await open(handle, EXTENSION_ORIGIN);
    const closed = new Promise<{ code: number; reason: string }>((resolve) => {
      browser.once('close', (code, reason) => resolve({ code, reason: reason.toString() }));
    });
    browser.send(JSON.stringify({ type: 'browser.hello', protocolVersion: version, browserId: 'b', browserName: 'Chromium' }));
    const { code, reason } = await closed;
    expect(code).toBe(1008);
    expect(reason).toContain(said);
    expect(Buffer.byteLength(reason)).toBeLessThanOrEqual(123);
  });
});
