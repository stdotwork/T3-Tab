import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { directParser, newClaudeState, parseClaudeLine, parseCodexLine, type DirectPart } from '../src/agents/commands.js';

const FIXTURE = join(import.meta.dirname, 'fixtures', 'claude-stream-partial.ndjson');

function partsOf(lines: string[], parse: (line: string) => { parts?: DirectPart[] }): DirectPart[] {
  return lines.flatMap((line) => parse(line).parts ?? []);
}

describe('claude -p --include-partial-messages', () => {
  // Captured from a real `claude -p` run (Claude Code 2.1.329) that called two tools, the second of which failed,
  // then answered; secrets, usage and signatures removed.
  const lines = readFileSync(FIXTURE, 'utf8').split('\n').filter((line) => line !== '');

  it('turns a real stream into tool calls that start, finish and fail, and a reply that streams', () => {
    const parts = partsOf(lines, directParser('claude'));
    const tools = parts.filter((part) => part.op === 'tool');
    expect(tools).toEqual([
      { op: 'tool', id: 'toolu_01KKH8qWzyWxHNLob5U6D5nt', name: 'status', status: 'running' },
      { op: 'tool', id: 'toolu_01KKH8qWzyWxHNLob5U6D5nt', name: 'status', status: 'running' },
      { op: 'tool', id: 'toolu_018XQ9zwjmHLvxfD6AuNBZ3L', name: 'fail', status: 'running' },
      { op: 'tool', id: 'toolu_01KKH8qWzyWxHNLob5U6D5nt', output: 'Browsers: 0', status: 'done' },
      { op: 'tool', id: 'toolu_018XQ9zwjmHLvxfD6AuNBZ3L', name: 'fail', status: 'running' },
      { op: 'tool', id: 'toolu_018XQ9zwjmHLvxfD6AuNBZ3L', output: 'boom', status: 'failed' },
    ]);
    const reply = parts.filter((part) => part.op === 'text' && part.kind === 'assistant');
    const deltas = reply.filter((part) => part.op === 'text' && !part.final).map((part) => (part.op === 'text' ? part.text : ''));
    expect(deltas.join('')).toBe('Done: status reported 0 browsers connected, and fail returned the error "boom" as expected.');
    expect(deltas.length).toBeGreaterThan(1);
    // The complete text arrives in the full assistant line, under the same key the deltas used.
    const final = reply.find((part) => part.op === 'text' && part.final);
    const keys = new Set(reply.flatMap((part) => (part.op === 'text' ? [part.key] : [])));
    expect(keys.size).toBe(1);
    expect(final).toMatchObject({ text: deltas.join(''), key: [...keys][0] });
  });

  it('still reads the reply and the session id for the existing message list', () => {
    const parse = directParser('claude');
    const events = lines.map((line) => parse(line));
    expect(events.find((event) => event.sessionId !== undefined)?.sessionId).toBe('00000000-0000-4000-8000-000000000001');
    expect(events.flatMap((event) => (event.text === undefined ? [] : [event.text]))).toEqual([
      'Done: status reported 0 browsers connected, and fail returned the error "boom" as expected.',
    ]);
    expect(events.at(-1)?.done).toMatchObject({ ok: true });
  });

  it('gives a block that has no partial events a key of its own and ends it', () => {
    const line = JSON.stringify({ type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] } });
    const parts = parseClaudeLine(line, newClaudeState()).parts ?? [];
    expect(parts.filter((part) => part.op === 'text').map((part) => part.key)).toEqual(['m1:x0', 'm1:x1']);
    expect(parts.filter((part) => part.op === 'end').length).toBe(2);
  });

  it('streams thinking as reasoning', () => {
    const state = newClaudeState();
    const parse = (event: unknown): DirectPart[] => parseClaudeLine(JSON.stringify({ type: 'stream_event', event }), state).parts ?? [];
    parse({ type: 'message_start', message: { id: 'm2' } });
    expect(parse({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } })).toEqual([
      { op: 'text', key: 'm2:0', kind: 'reasoning', text: '', final: false },
    ]);
    expect(parse({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'hm' } })).toEqual([
      { op: 'text', key: 'm2:0', kind: 'reasoning', text: 'hm', final: false },
    ]);
    expect(parse({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'x' } })).toEqual([]);
  });

  it('names a tool without its server prefix and shortens its arguments to one line', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: { id: 'm3', content: [{ type: 'tool_use', id: 't1', name: 'mcp__t3-tab__read', input: { tab: 4, find: 'x'.repeat(500) } }] },
    });
    const [part] = parseClaudeLine(line, newClaudeState()).parts ?? [];
    expect(part).toMatchObject({ op: 'tool', id: 't1', name: 'read', status: 'running' });
    expect(part?.op === 'tool' ? part.summary?.length : 0).toBe(201);
  });

  it('reads a tool result given as text, blocks with an image, or an error', () => {
    const result = (content: unknown, isError?: boolean): DirectPart[] =>
      parseClaudeLine(
        JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'u', content, ...(isError ? { is_error: true } : {}) }] } }),
        newClaudeState(),
      ).parts ?? [];
    expect(result('plain')).toEqual([{ op: 'tool', id: 'u', output: 'plain', status: 'done' }]);
    expect(result([{ type: 'text', text: 'a' }, { type: 'image', source: {} }])).toEqual([{ op: 'tool', id: 'u', output: 'a\n[image]', status: 'done' }]);
    expect(result('nope', true)).toEqual([{ op: 'tool', id: 'u', output: 'nope', status: 'failed' }]);
  });
});

describe('codex exec --json items', () => {
  const part = (line: string): DirectPart | undefined => parseCodexLine(line).parts?.[0];

  it('reads a message and reasoning as text that ends, and a message as a reply too', () => {
    const message = parseCodexLine('{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"hi"}}');
    expect(message.text).toBe('hi');
    expect(message.parts).toEqual([
      { op: 'text', key: 'item_1', kind: 'assistant', text: 'hi', final: true },
      { op: 'end', key: 'item_1' },
    ]);
    const reasoning = parseCodexLine('{"type":"item.completed","item":{"id":"item_0","type":"reasoning","text":"hm"}}');
    expect(reasoning.text).toBeUndefined();
    expect(reasoning.parts?.[0]).toMatchObject({ kind: 'reasoning', text: 'hm' });
  });

  it('follows an MCP tool call from started to completed, and to failed', () => {
    expect(part('{"type":"item.started","item":{"id":"i2","type":"mcp_tool_call","server":"t3-tab","tool":"read","arguments":{"tab":1},"status":"in_progress"}}')).toEqual({
      op: 'tool', id: 'i2', name: 'read', summary: '{"tab":1}', status: 'running',
    });
    expect(
      part('{"type":"item.completed","item":{"id":"i2","type":"mcp_tool_call","server":"t3-tab","tool":"read","arguments":{"tab":1},"result":{"content":[{"type":"text","text":"page"}]},"status":"completed"}}'),
    ).toMatchObject({ op: 'tool', id: 'i2', output: 'page', status: 'done' });
    expect(
      part('{"type":"item.completed","item":{"id":"i3","type":"mcp_tool_call","server":"t3-tab","tool":"act","arguments":{},"error":{"message":"denied"},"status":"failed"}}'),
    ).toEqual({ op: 'tool', id: 'i3', name: 'act', output: 'denied', status: 'failed' });
  });

  it('names other item types as tools and a non-fatal error as an error', () => {
    expect(part('{"type":"item.started","item":{"id":"c1","type":"command_execution","command":"ls","aggregated_output":"","status":"in_progress"}}')).toMatchObject({
      op: 'tool', name: 'command', summary: 'ls', status: 'running',
    });
    expect(part('{"type":"item.completed","item":{"id":"t1","type":"todo_list","items":[{"text":"a","completed":true},{"text":"b","completed":false}]}}')).toMatchObject({
      name: 'plan', output: '[x] a\n[ ] b', status: 'done',
    });
    expect(part('{"type":"item.completed","item":{"id":"e1","type":"error","message":"warn"}}')).toEqual({ op: 'error', key: 'e1', text: 'warn' });
    expect(part('{"type":"item.started","item":{"id":"w1","type":"web_search","query":"q"}}')).toMatchObject({ name: 'web search', summary: 'q' });
  });

  it('ignores an item it cannot read', () => {
    expect(parseCodexLine('{"type":"item.completed","item":"x"}')).toEqual({});
    expect(parseCodexLine('{"type":"item.completed","item":{"type":"agent_message"}}')).toEqual({});
  });
});
