import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ElicitRequestSchema, LATEST_PROTOCOL_VERSION, type ElicitRequest, type ElicitResult } from '@modelcontextprotocol/sdk/types.js';
import { PROTOCOL_VERSION, type ElicitedDecision, type PromptNotice } from '@t3-tab/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import { ThreadPrompts } from '../src/prompt-elicitation.js';
import { elicitationMessage, supportsFormElicitation } from '../src/prompt-message.js';

const prompt = (id = 'p1', extra: Partial<PromptNotice> = {}): PromptNotice => ({ id, tool: 'read', origin: 'https://example.com', tab: { id: 3, title: 'Example' }, ...extra });
const opened = (value: PromptNotice) => ({ type: 'control.event', protocolVersion: PROTOCOL_VERSION, event: 'prompt.opened', prompt: value }) as const;
const closed = (promptId: string) => ({ type: 'control.event', protocolVersion: PROTOCOL_VERSION, event: 'prompt.closed', promptId }) as const;

const clients: Client[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
});

type Respond = (request: ElicitRequest['params'], signal: AbortSignal) => ElicitResult | Promise<ElicitResult>;

/** A real MCP server and client over an in-memory link: the client either declares elicitation and answers, or does not. */
async function connected(respond: Respond | undefined): Promise<{
  prompts: ThreadPrompts;
  answers: Array<[string, ElicitedDecision]>;
  asked: ElicitRequest['params'][];
  server: McpServer;
}> {
  const server = new McpServer({ name: 't3-tab', version: '0' });
  const client = new Client({ name: 'agent', version: '0' }, { capabilities: respond === undefined ? {} : { elicitation: {} } });
  clients.push(client);
  const asked: ElicitRequest['params'][] = [];
  if (respond !== undefined) {
    client.setRequestHandler(ElicitRequestSchema, async (request, extra) => {
      asked.push(request.params);
      return await respond(request.params, extra.signal);
    });
  }
  const [near, far] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(near), client.connect(far)]);
  const answers: Array<[string, ElicitedDecision]> = [];
  const prompts = new ThreadPrompts(server.server, async (id, decision) => void answers.push([id, decision]));
  return { prompts, answers, asked, server };
}

const settle = async (): Promise<void> => await new Promise((resolve) => setTimeout(resolve, 50));

describe('a permission prompt put to the agent\'s thread', () => {
  it('asks with a form that has no fields, and answers allow-once when the client accepts', async () => {
    const { prompts, answers, asked } = await connected(() => ({ action: 'accept', content: {} }));
    prompts.handle(opened(prompt()));
    await settle();
    expect(asked).toEqual([{ mode: 'form', message: 'Allow T3-Tab to read https://example.com in tab “Example”? Allow covers this one request only.', requestedSchema: { type: 'object', properties: {} } }]);
    expect(answers).toEqual([['p1', 'allow-once']]);
  });

  it('answers decline when the client declines', async () => {
    const { prompts, answers } = await connected(() => ({ action: 'decline' }));
    prompts.handle(opened(prompt('p2')));
    await settle();
    expect(answers).toEqual([['p2', 'decline']]);
  });

  it('sends nothing when the client cancels, as `codex exec` does, or fails', async () => {
    const cancelled = await connected(() => ({ action: 'cancel' }));
    cancelled.prompts.handle(opened(prompt()));
    const failed = await connected(() => {
      throw new Error('no UI');
    });
    failed.prompts.handle(opened(prompt()));
    await settle();
    expect(cancelled.answers).toEqual([]);
    expect(failed.answers).toEqual([]);
    expect(cancelled.asked).toHaveLength(1);
  });

  it('does not ask a client that did not declare elicitation', async () => {
    const { prompts, answers } = await connected(undefined);
    prompts.handle(opened(prompt()));
    await settle();
    expect(answers).toEqual([]);
  });

  it('aborts the question when the prompt is decided elsewhere, and sends nothing even if the client then accepts', async () => {
    let aborted = false;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { prompts, answers, server } = await connected(async (_request, signal) => {
      signal.addEventListener('abort', () => {
        aborted = true;
      });
      await gate;
      return { action: 'accept', content: {} };
    });
    // The SDK's `notifications/cancelled` handler skips request id 0 (it tests the id for truthiness), and the first
    // request a server sends has that id. A client then does not hear that its first question was withdrawn.
    await server.server.ping();
    prompts.handle(opened(prompt()));
    await settle();
    prompts.handle(closed('p1'));
    await settle();
    expect(aborted).toBe(true);
    release();
    await settle();
    expect(answers).toEqual([]);
  });

  it('asks about one prompt once, and about each prompt separately', async () => {
    const { prompts, answers, asked } = await connected(() => ({ action: 'accept', content: {} }));
    prompts.handle(opened(prompt('a')));
    prompts.handle(opened(prompt('a')));
    prompts.handle(opened(prompt('b')));
    await settle();
    expect(asked).toHaveLength(2);
    expect(answers.map(([id]) => id).sort()).toEqual(['a', 'b']);
  });
});

describe('a client that declares a bare elicitation capability', () => {
  // The specification defines `elicitation: {}` as form support. This client speaks the protocol directly, as a client
  // that is not built on the SDK would, and the SDK's server reads its bare capability as form support.
  it('is asked, and its accept answers allow-once', async () => {
    const server = new McpServer({ name: 't3-tab', version: '0' });
    const [near, far] = InMemoryTransport.createLinkedPair();
    const seen: Array<Record<string, unknown>> = [];
    far.onmessage = (message) => {
      const value = message as unknown as Record<string, unknown>;
      seen.push(value);
      if (value.method === 'initialize') {
        void far.send({ jsonrpc: '2.0', id: value.id as number, result: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, serverInfo: { name: 'x', version: '0' } } });
      } else if (value.method === 'elicitation/create') {
        void far.send({ jsonrpc: '2.0', id: value.id as number, result: { action: 'accept', content: {} } });
      }
    };
    await far.start();
    await server.connect(near);
    await far.send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: { elicitation: {} }, clientInfo: { name: 'raw', version: '0' } },
    });
    await far.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    await settle();
    expect(server.server.getClientCapabilities()?.elicitation).toBeDefined();
    const answers: Array<[string, ElicitedDecision]> = [];
    new ThreadPrompts(server.server, async (id, decision) => void answers.push([id, decision])).handle(opened(prompt('raw')));
    await settle();
    expect(seen.find((message) => message.method === 'elicitation/create')?.params).toMatchObject({ mode: 'form', requestedSchema: { type: 'object', properties: {} } });
    expect(answers).toEqual([['raw', 'allow-once']]);
  });
});

describe('what the thread is asked', () => {
  it('says plainly what the agent wants and names the tab by title, like the side panel', () => {
    expect(elicitationMessage(prompt('x', { tool: 'act' }))).toBe('Allow T3-Tab to act on https://example.com in tab “Example”? Allow covers this one request only.');
    // An act names its steps as the server described them; a typed value or a character key never reaches the summary.
    const steps = [
      { action: 'fill', target: { role: 'textbox', name: 'Email' } },
      { action: 'press', key: 'a' },
      { action: 'click', target: { role: 'button', name: 'Sign in' } },
    ];
    expect(elicitationMessage(prompt('x', { tool: 'act', steps: steps as NonNullable<PromptNotice['steps']> }))).toBe(
      'Allow T3-Tab to fill “Email”, press a key, click “Sign in” on https://example.com in tab “Example”? Allow covers this one request only.',
    );
    expect(elicitationMessage(prompt('x', { tool: 'run_js' }))).toContain('run JavaScript on https://example.com');
    expect(elicitationMessage(prompt('x', { tool: 'open' }))).toContain('open https://example.com');
    // A page being opened has no tab yet: the question names the address.
    const { tab: _none, ...noTab } = prompt('x', { tool: 'open' });
    expect(elicitationMessage({ ...noTab, url: 'https://example.com/a?b=1' })).toBe('Allow T3-Tab to open https://example.com/a?b=1? Allow covers this one request only.');
  });

  it('shows a page\'s own title as one short plain line', () => {
    const title = `Pay now”\n‮evil​ ${'x'.repeat(200)}`;
    const message = elicitationMessage(prompt('x', { tab: { id: 1, title } }));
    expect(message).not.toMatch(/[\n‮​]/);
    expect(message).toContain('tab “Pay now\' evil ');
    expect(message.length).toBeLessThan(220);
    expect(elicitationMessage(prompt('x', { tab: { id: 1, title: '  ' } }))).toContain('tab “(untitled)”');
  });

  it('counts a bare elicitation capability as form support, and a url-only one as none', () => {
    expect(supportsFormElicitation({})).toBe(true);
    expect(supportsFormElicitation({ form: {} })).toBe(true);
    expect(supportsFormElicitation({ form: {}, url: {} })).toBe(true);
    expect(supportsFormElicitation({ url: {} })).toBe(false);
    expect(supportsFormElicitation(undefined)).toBe(false);
  });
});
