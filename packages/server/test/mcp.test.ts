import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';

import { makeSessionName } from '../src/daemon-messages.js';
import { createMcpServer, listedTools } from '../src/mcp.js';

describe('MCP sessions', () => {
  it('names a session from the MCP client name and a short id', () => {
    expect(makeSessionName('Codex CLI', '12345678-aaaa-bbbb-cccc-123456789abc')).toBe('Codex CLI · 12345678');
  });

  it('sanitizes and falls back for an unnamed client', () => {
    expect(makeSessionName('  bad\u0000  name  ', 'abc')).toBe('bad name · abc');
    expect(makeSessionName('', '')).toBe('MCP client · session');
  });
});

describe('the tool list', () => {
  async function connected(): Promise<{ client: Client; calls: Array<[string, Record<string, unknown>]> }> {
    const calls: Array<[string, Record<string, unknown>]> = [];
    const control = {
      callTool: async (method: string, params: Record<string, unknown>) => {
        calls.push([method, params]);
        return [{ type: 'text' as const, text: 'ok' }];
      },
      takeReconnected: () => false,
      answerPrompt: async () => undefined,
      onEvent: () => undefined,
      setClientName: () => undefined,
      register: async () => ({ id: 's', name: 'S' }),
    };
    const server = createMcpServer(control, () => []);
    const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: 'test', version: '0' });
    await client.connect(clientSide);
    return { client, calls };
  }

  it('lists five tools with no keyword the call is checked against anyway', async () => {
    const { client } = await connected();
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(['tabs', 'read', 'screenshot', 'act', 'run_js']);
    expect(tools).toEqual(listedTools());
    const json = JSON.stringify(tools);
    for (const keyword of ['$schema', 'minItems', 'maxItems', 'minLength', 'maxLength', 'minimum', 'maximum', 'additionalProperties', 'execution']) {
      expect(json).not.toContain(`"${keyword}"`);
    }
    const read = tools.find((tool) => tool.name === 'read');
    expect(Object.keys(read?.inputSchema.properties ?? {})).toEqual(['tab', 'url', 'all', 'find', 'ref', 'full']);
    expect(read?.description).toContain('tab defaults to the current tab in every tool.');
    // The default is said once: no `tab` parameter carries a description of its own.
    for (const tool of tools) expect((tool.inputSchema.properties as Record<string, object> | undefined)?.tab).toEqual({ type: 'number' });
    const act = JSON.stringify(tools.find((tool) => tool.name === 'act'));
    expect(act).toContain('press: key (Enter, Escape, Control+A)');
    expect(act).not.toContain('F5');
    expect(tools.find((tool) => tool.name === 'act')?.inputSchema.required).toEqual(['steps']);
    await client.close();
  });

  it('still checks every call against the whole shape, unlisted parameters and limits included', async () => {
    const { client, calls } = await connected();
    expect((await client.callTool({ name: 'read', arguments: { find: 'a(b', regex: true, depth: 0 } })).isError).toBeFalsy();
    expect(calls.at(-1)).toEqual(['read', { find: 'a(b', regex: true, depth: 0 }]);
    const refused = async (name: string, args: Record<string, unknown>): Promise<boolean> =>
      (await client.callTool({ name, arguments: args })).isError === true;
    const before = calls.length;
    expect(await refused('read', { depth: -1 })).toBe(true);
    expect(await refused('read', { find: 'x'.repeat(201) })).toBe(true);
    expect(await refused('screenshot', { maxEdge: 10 })).toBe(true);
    expect(await refused('act', { steps: [] })).toBe(true);
    expect(await refused('act', { steps: [{ action: 'click', ref: 'e1', extra: 1 }] })).toBe(true);
    expect(await refused('run_js', { expression: '' })).toBe(true);
    expect(await refused('status', {})).toBe(true);
    expect(calls.length).toBe(before);
    await client.close();
  });
});
