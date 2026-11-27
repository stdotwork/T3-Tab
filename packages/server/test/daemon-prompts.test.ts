import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { EXTENSION_ORIGIN, PROTOCOL_VERSION, type ToolSession } from '@t3-tab/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';

import { Agents } from '../src/agents/conversations.js';
import type { T3PanelPairing } from '../src/agents/t3-pairing.js';
import { parsePromptNotice } from '../src/daemon-prompts.js';
import { startDaemon, type DaemonHandle } from '../src/daemon.js';
import type { Setup } from '../src/setup.js';

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

async function start(extra: { setup?: Setup; pairing?: T3PanelPairing } = {}): Promise<DaemonHandle> {
  directory = await mkdtemp(join(tmpdir(), 't3-tab-daemon-prompts-'));
  const agents = new Agents({ env: { PATH: '' }, server: { command: 'node', args: [] } });
  daemon = await startDaemon({ port: 0, stateDir: directory, agents, ...extra });
  return daemon;
}

async function open(handle: DaemonHandle, extension = false): Promise<WebSocket> {
  const socket = new WebSocket(`ws://127.0.0.1:${handle.port}/`, {
    headers: extension ? { authorization: `Bearer ${handle.extensionToken}`, origin: EXTENSION_ORIGIN } : { authorization: `Bearer ${handle.token}` },
  });
  sockets.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve());
    socket.once('error', reject);
  });
  return socket;
}

/** Collects what a socket receives, so a test can look at everything that arrived. */
function listen(socket: WebSocket): Array<Record<string, unknown>> {
  const received: Array<Record<string, unknown>> = [];
  socket.on('message', (data) => received.push(JSON.parse(data.toString()) as Record<string, unknown>));
  return received;
}

async function until(check: () => boolean, what: string): Promise<void> {
  const end = Date.now() + 3_000;
  while (!check()) {
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const settle = async (): Promise<void> => await new Promise((resolve) => setTimeout(resolve, 60));

interface Agent {
  socket: WebSocket;
  session: ToolSession;
  received: Array<Record<string, unknown>>;
}

async function agent(handle: DaemonHandle, name: string): Promise<Agent> {
  const socket = await open(handle);
  const received = listen(socket);
  socket.send(JSON.stringify({ type: 'control.request', protocolVersion: PROTOCOL_VERSION, requestId: 'reg', method: 'session.register', clientName: name }));
  await until(() => received.some((message) => message.requestId === 'reg'), 'registration');
  const registered = received.find((message) => message.requestId === 'reg');
  return { socket, received, session: (registered?.result as { session: ToolSession } | undefined)?.session as ToolSession };
}

/** An extension that answers every request the daemon sends it and keeps a record of them. */
async function extension(handle: DaemonHandle): Promise<{ socket: WebSocket; requests: Array<Record<string, unknown>> }> {
  const socket = await open(handle, true);
  const requests: Array<Record<string, unknown>> = [];
  socket.on('message', (data) => {
    const message = JSON.parse(data.toString()) as Record<string, unknown>;
    if (message.type !== 'browser.request') return;
    requests.push(message);
    socket.send(JSON.stringify({ type: 'browser.response', protocolVersion: PROTOCOL_VERSION, requestId: message.requestId, ok: true, result: message.method === 'prompt.decide' ? { decided: true } : { registered: true } }));
  });
  return { socket, requests };
}

const notice = (id: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id,
  tool: 'read',
  origin: 'https://example.com',
  tab: { id: 7, title: 'Example' },
  ...extra,
});

function opened(browser: WebSocket, session: ToolSession, prompt: Record<string, unknown>): void {
  browser.send(JSON.stringify({ type: 'browser.promptOpened', protocolVersion: PROTOCOL_VERSION, session, prompt }));
}

function answer(owner: Agent, promptId: string, decision: unknown, requestId = 'ans'): void {
  owner.socket.send(JSON.stringify({ type: 'control.request', protocolVersion: PROTOCOL_VERSION, requestId, method: 'prompt.answer', promptId, decision }));
}

const events = (owner: Agent): Array<Record<string, unknown>> => owner.received.filter((message) => message.type === 'control.event');

describe('a permission prompt in the thread of the session that asked', () => {
  it('tells only the owning session\'s connection, and passes its answer to the browser', async () => {
    const handle = await start();
    const { socket: browser, requests } = await extension(handle);
    const owner = await agent(handle, 'Codex CLI');
    const other = await agent(handle, 'Claude Code');
    opened(browser, owner.session, notice('p1'));
    await until(() => events(owner).length === 1, 'the event');
    expect(events(owner)[0]).toEqual({ type: 'control.event', protocolVersion: PROTOCOL_VERSION, event: 'prompt.opened', prompt: notice('p1') });
    await settle();
    expect(events(other)).toEqual([]);

    answer(owner, 'p1', 'allow-once');
    await until(() => owner.received.some((message) => message.requestId === 'ans'), 'the answer');
    expect(owner.received.find((message) => message.requestId === 'ans')).toMatchObject({ ok: true, result: { answered: true } });
    expect(requests.find((request) => request.method === 'prompt.decide')).toMatchObject({
      session: owner.session,
      params: { promptId: 'p1', decision: 'allow-once' },
    });
  });

  it('refuses another session\'s answer, an unknown prompt and a made-up decision, and tells the browser nothing', async () => {
    const handle = await start();
    const { socket: browser, requests } = await extension(handle);
    const owner = await agent(handle, 'Codex CLI');
    const other = await agent(handle, 'Claude Code');
    opened(browser, owner.session, notice('p1'));
    await until(() => events(owner).length === 1, 'the event');

    answer(other, 'p1', 'allow-once', 'wrong');
    answer(owner, 'nope', 'allow-once', 'unknown');
    answer(owner, 'p1', 'always-allow', 'lasting');
    answer(owner, 'p1', undefined, 'none');
    await until(() => ['wrong', 'unknown', 'lasting', 'none'].every((id) => [...owner.received, ...other.received].some((message) => message.requestId === id)), 'the refusals');
    const reply = (who: Agent, id: string): unknown => who.received.find((message) => message.requestId === id);
    expect(reply(other, 'wrong')).toMatchObject({ ok: false, error: 'No such permission request for this session' });
    expect(reply(owner, 'unknown')).toMatchObject({ ok: false, error: 'No such permission request for this session' });
    expect(reply(owner, 'lasting')).toMatchObject({ ok: false, error: 'Invalid answer' });
    expect(reply(owner, 'none')).toMatchObject({ ok: false, error: 'Invalid answer' });
    expect(requests.filter((request) => request.method === 'prompt.decide')).toEqual([]);
  });

  it('closes the prompt for its session when the browser says it is over, and refuses a late answer', async () => {
    const handle = await start();
    const { socket: browser, requests } = await extension(handle);
    const owner = await agent(handle, 'Codex CLI');
    opened(browser, owner.session, notice('p1'));
    await until(() => events(owner).length === 1, 'the event');
    browser.send(JSON.stringify({ type: 'browser.promptClosed', protocolVersion: PROTOCOL_VERSION, promptId: 'p1' }));
    await until(() => events(owner).length === 2, 'the close');
    expect(events(owner)[1]).toEqual({ type: 'control.event', protocolVersion: PROTOCOL_VERSION, event: 'prompt.closed', promptId: 'p1' });
    answer(owner, 'p1', 'decline');
    await until(() => owner.received.some((message) => message.requestId === 'ans'), 'the refusal');
    expect(owner.received.find((message) => message.requestId === 'ans')).toMatchObject({ ok: false });
    expect(requests.filter((request) => request.method === 'prompt.decide')).toEqual([]);
  });

  it('closes the prompts a browser held when it disconnects', async () => {
    const handle = await start();
    const { socket: browser } = await extension(handle);
    const owner = await agent(handle, 'Codex CLI');
    opened(browser, owner.session, notice('p1'));
    await until(() => events(owner).length === 1, 'the event');
    browser.terminate();
    await until(() => events(owner).length === 2, 'the close');
    expect(events(owner)[1]).toMatchObject({ event: 'prompt.closed', promptId: 'p1' });
  });

  it('ignores a prompt for a session it does not know, and one with an invalid shape, and cuts a long title', async () => {
    const handle = await start();
    const { socket: browser } = await extension(handle);
    const owner = await agent(handle, 'Codex CLI');
    opened(browser, { id: 'nobody', name: 'Nobody' }, notice('p0'));
    opened(browser, owner.session, notice('p2', { tool: 'format' }));
    opened(browser, owner.session, notice('p3', { tab: { id: 'x', title: 'y' } }));
    opened(browser, owner.session, notice('p4', { tab: { id: 1, title: 'T'.repeat(5_000) } }));
    await until(() => events(owner).length === 1, 'the one valid event');
    await settle();
    expect(events(owner)).toHaveLength(1);
    const delivered = events(owner)[0]?.prompt as { id: string; tab: { title: string } } | undefined;
    expect(delivered?.id).toBe('p4');
    expect(delivered?.tab.title).toHaveLength(300);
  });
});

describe('the panel\'s setup and pairing requests', () => {
  async function ask(browser: WebSocket, method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const received = listen(browser);
    browser.send(JSON.stringify({ type: 'browser.daemonRequest', protocolVersion: PROTOCOL_VERSION, requestId: method, method, params }));
    await until(() => received.some((message) => message.requestId === method), method);
    return received.find((message) => message.requestId === method) as Record<string, unknown>;
  }

  it('answers each with what the setup and pairing services return, and with their error when they fail', async () => {
    const calls: string[] = [];
    const setup = {
      status: async (refresh: boolean) => (calls.push(`status:${String(refresh)}`), { agents: [], t3: { state: 'missing' } }),
      addAgent: async (agentName: unknown) => (calls.push(`add:${String(agentName)}`), { agents: [], t3: { state: 'missing' } }),
    } as unknown as Setup;
    const pairing = {
      pair: async (params: unknown) => (calls.push(`pair:${JSON.stringify(params)}`), { origin: 'http://127.0.0.1:1', accessToken: 'a', expiresIn: 60 }),
      session: async (params: unknown) => (calls.push(`session:${JSON.stringify(params)}`), { outcome: 'moved' }),
      threadMode: async (threadId: unknown) => {
        calls.push(`mode:${String(threadId)}`);
        if (threadId === 'bad') throw new Error('Invalid thread id');
        return { runtimeMode: 'full-access' };
      },
      unpair: async () => {
        throw new Error('no session list');
      },
    } as unknown as T3PanelPairing;
    const handle = await start({ setup, pairing });
    const browser = await open(handle, true);
    expect(await ask(browser, 'setup.status', { refresh: true })).toMatchObject({ ok: true, result: { t3: { state: 'missing' } } });
    expect(await ask(browser, 'setup.addAgent', { agent: 'codex' })).toMatchObject({ ok: true });
    expect(await ask(browser, 't3.pair', { origin: 'http://127.0.0.1:1', dpop: 'a.b.c' })).toMatchObject({
      ok: true,
      result: { origin: 'http://127.0.0.1:1', accessToken: 'a', expiresIn: 60 },
    });
    const sessionParams = { kind: 'ticket', origin: 'http://127.0.0.1:1', accessToken: 'tok', dpop: 'a.b.c' };
    expect(await ask(browser, 't3.session', sessionParams)).toMatchObject({ ok: true, result: { outcome: 'moved' } });
    expect(await ask(browser, 't3.threadMode', { threadId: 'th1' })).toMatchObject({ ok: true, result: { runtimeMode: 'full-access' } });
    expect(await ask(browser, 't3.threadMode', { threadId: 'bad' })).toMatchObject({ ok: false, error: 'Invalid thread id' });
    expect(await ask(browser, 't3.unpair')).toMatchObject({ ok: false, error: 'no session list' });
    expect(await ask(browser, 'agents.get', { id: 'nope' })).toMatchObject({ ok: false, error: expect.stringContaining('No such conversation') });
    expect(await ask(browser, 'agents.stop', { id: 7 })).toMatchObject({ ok: false, error: 'Invalid conversation id' });
    expect(calls).toEqual([
      'status:true',
      'add:codex',
      `pair:${JSON.stringify({ origin: 'http://127.0.0.1:1', dpop: 'a.b.c' })}`,
      `session:${JSON.stringify(sessionParams)}`,
      'mode:th1',
      'mode:bad',
    ]);
  });
});

describe('a prompt notice from the browser', () => {
  const base = { id: 'p1', tool: 'act', origin: 'https://shop.example', tab: { id: 4, title: 'Shop' } };

  it('keeps an act prompt\'s steps, checked, so the question in the agent\'s thread names the action', () => {
    const notice = parsePromptNotice({
      ...base,
      steps: [
        { action: 'click', target: { role: 'button', name: 'Add to cart' } },
        { action: 'press', key: 'Enter' },
        { action: 'press', key: 'x' },
        { action: 'type', target: { role: 'textbox', name: 'Email' }, text: 'ada@example.com' },
        { action: 'launch' },
      ],
    });
    expect(notice?.steps).toEqual([
      { action: 'click', target: { role: 'button', name: 'Add to cart' } },
      { action: 'press', key: 'Enter' },
      { action: 'press' },
      { action: 'type', target: { role: 'textbox', name: 'Email' } },
    ]);
    expect(JSON.stringify(notice)).not.toContain('ada@');
  });

  it('carries no steps for another kind of prompt, or when none are sent', () => {
    expect(parsePromptNotice({ ...base, tool: 'read', steps: [{ action: 'click' }] })?.steps).toBeUndefined();
    expect(parsePromptNotice(base)).toEqual(base);
    expect(parsePromptNotice({ ...base, steps: 'click' })).toEqual(base);
  });
});
