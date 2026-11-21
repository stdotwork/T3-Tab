import { describe, expect, it } from 'vitest';

import {
  claimNote,
  claudeArgs,
  codexArgs,
  firstLine,
  parseClaudeLine,
  parseCodexLine,
  parseT3Launch,
  parseT3Show,
  t3FailureState,
  t3ProbeArgs,
  t3SendArgs,
  t3ShowArgs,
  t3StartArgs,
  withoutClaimNote,
} from '../src/agents/commands.js';

const CODE = 'abcdefghijklmnop1234';
const server = { command: '/usr/bin/node', args: ['/x/cli.js', 'mcp'] };

describe('claim note', () => {
  it('is added after the message and removed again', () => {
    const note = claimNote(CODE);
    expect(note).toContain(`{"claim": "${CODE}"}`);
    expect(withoutClaimNote(`Open the page${note}`)).toBe('Open the page');
  });

  it('leaves a message without a note alone', () => {
    expect(withoutClaimNote('plain\n\n[T3-Tab] something else')).toBe('plain\n\n[T3-Tab] something else');
  });
});

describe('t3 arguments', () => {
  it('puts the message on stdin and the selection before the project', () => {
    expect(t3StartArgs({ project: '/p' })).toEqual(['thread', 'start', '--json', '/p', '-']);
    expect(t3StartArgs({ project: '/p', provider: 'claudeAgent', model: 'm1' })).toEqual([
      'thread', 'start', '--json', '--provider', 'claudeAgent', '--model', 'm1', '/p', '-',
    ]);
  });

  it('ignores a provider given without a model', () => {
    expect(t3StartArgs({ project: '/p', provider: 'claudeAgent' })).toEqual(['thread', 'start', '--json', '/p', '-']);
  });

  it('builds send, show and probe commands', () => {
    expect(t3SendArgs('th1')).toEqual(['thread', 'send', '--json', 'th1', '-']);
    expect(t3ShowArgs('th1')).toEqual(['thread', 'show', '--json', '--messages', '20', 'th1']);
    expect(t3ProbeArgs()).toEqual(['thread', 'list', '--json', '--project', '/']);
  });
});

describe('t3FailureState and firstLine', () => {
  it('reads the server state from stderr', () => {
    expect(t3FailureState("No T3 Code project matches '/'")).toBe('running');
    expect(t3FailureState('No running T3 Code server uses /x')).toBe('stopped');
    expect(t3FailureState('Could not reach the T3 Code server')).toBe('stopped');
    expect(t3FailureState('boom')).toBe('error');
  });

  it('takes the first non-empty trimmed line, cut at 300 characters', () => {
    expect(firstLine('\n  \n  hello  \nworld')).toBe('hello');
    expect(firstLine('')).toBe('');
    expect(firstLine('x'.repeat(400))).toHaveLength(300);
  });
});

describe('parseT3Launch', () => {
  it('reads the thread and run ids', () => {
    expect(parseT3Launch('{"threadId":"t","runId":"r"}\n')).toEqual({ threadId: 't', runId: 'r' });
    expect(parseT3Launch('{"threadId":"t"}')).toEqual({ threadId: 't' });
  });

  it('refuses output without a thread id', () => {
    expect(() => parseT3Launch('{}')).toThrow('t3 did not print a thread id');
    expect(() => parseT3Launch('not json')).toThrow('t3 did not print a thread id');
    expect(() => parseT3Launch('{"threadId":""}')).toThrow('t3 did not print a thread id');
  });
});

describe('parseT3Show', () => {
  const show = (thread: Record<string, unknown>, messages: unknown[] = []): string => JSON.stringify({ thread, messages });

  it.each(['preparing', 'queued', 'starting', 'running'])('maps %s to running and active', (status) => {
    expect(parseT3Show(show({ status }))).toMatchObject({ status: 'running', active: true });
  });

  it('maps waiting, or pending requests, to waiting', () => {
    expect(parseT3Show(show({ status: 'waiting' }))).toMatchObject({ status: 'waiting', active: false });
    expect(parseT3Show(show({ status: 'idle', pendingRequestCount: 1 }))).toMatchObject({ status: 'waiting' });
    expect(parseT3Show(show({ status: 'running', pendingRequestCount: 2 }))).toMatchObject({ status: 'waiting', active: true });
  });

  it('maps failed to failed and anything else to idle', () => {
    expect(parseT3Show(show({ status: 'failed' }))).toMatchObject({ status: 'failed', active: false });
    expect(parseT3Show(show({ status: 'completed' }))).toMatchObject({ status: 'idle', active: false });
    expect(parseT3Show(show({}))).toMatchObject({ status: 'idle' });
  });

  it('keeps title and latest run id, and strips the claim note from user messages only', () => {
    const note = claimNote(CODE);
    const result = parseT3Show(
      show({ status: 'idle', title: 'T', latestRunId: 'r9' }, [
        { role: 'user', text: `Hi${note}` },
        { role: 'assistant', text: `Reply${note}` },
        { role: 'system', text: 'x' },
        { role: 'user' },
        'junk',
      ]),
    );
    expect(result.title).toBe('T');
    expect(result.latestRunId).toBe('r9');
    expect(result.messages).toEqual([
      { role: 'user', text: 'Hi' },
      { role: 'assistant', text: `Reply${note}` },
      { role: 'assistant', text: 'x' },
    ]);
  });

  it('refuses output with no thread', () => {
    expect(() => parseT3Show('{}')).toThrow('t3 thread show printed no thread');
  });
});

describe('claudeArgs', () => {
  it('starts only the t3-tab server with the claim and state folder', () => {
    const args = claudeArgs({ server, claim: CODE, env: { XDG_STATE_HOME: '/state' } });
    expect(args).toEqual(expect.arrayContaining(['-p', '--strict-mcp-config', '--allowedTools', 'mcp__t3-tab']));
    expect(args).not.toContain('--model');
    expect(args).not.toContain('--resume');
    const config = JSON.parse(args[args.indexOf('--mcp-config') + 1] as string) as {
      mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }>;
    };
    expect(Object.keys(config.mcpServers)).toEqual(['t3-tab']);
    expect(config.mcpServers['t3-tab']).toMatchObject({
      command: server.command,
      args: server.args,
      env: { T3_TAB_CLAIM: CODE, XDG_STATE_HOME: '/state' },
    });
  });

  it('leaves out XDG_STATE_HOME when unset or empty', () => {
    for (const env of [{}, { XDG_STATE_HOME: '' }]) {
      const args = claudeArgs({ server, claim: CODE, env });
      const config = JSON.parse(args[args.indexOf('--mcp-config') + 1] as string) as {
        mcpServers: Record<string, { env: Record<string, string> }>;
      };
      expect(config.mcpServers['t3-tab']?.env).toEqual({ T3_TAB_CLAIM: CODE });
    }
  });

  it('adds model and resume', () => {
    const args = claudeArgs({ server, claim: CODE, env: {}, model: 'opus', resume: 'sess-1' });
    expect(args[args.indexOf('--model') + 1]).toBe('opus');
    expect(args[args.indexOf('--resume') + 1]).toBe('sess-1');
  });
});

describe('codexArgs', () => {
  it('runs exec read-only with the server set inline', () => {
    const args = codexArgs({ server, claim: CODE, env: { XDG_STATE_HOME: '/state' } });
    expect(args.slice(0, 3)).toEqual(['exec', '--json', '--skip-git-repo-check']);
    expect(args.at(-1)).toBe('-');
    expect(args).toContain('sandbox_mode="read-only"');
    expect(args).toContain('mcp_servers.t3-tab.command="/usr/bin/node"');
    expect(args).toContain('mcp_servers.t3-tab.args=["/x/cli.js", "mcp"]');
    expect(args).toContain(`mcp_servers.t3-tab.env={ T3_TAB_CLAIM = "${CODE}", XDG_STATE_HOME = "/state" }`);
    expect(args).not.toContain('-m');
    expect(args).not.toContain('resume');
    for (const [index, value] of args.entries()) if (value.includes('=')) expect(args[index - 1]).toBe('-c');
  });

  it('puts the resume id just before the final dash, and the model after the settings', () => {
    const args = codexArgs({ server, claim: CODE, env: {}, model: 'gpt-x', resume: 'th-7' });
    expect(args.slice(0, 2)).toEqual(['exec', 'resume']);
    expect(args.slice(-2)).toEqual(['th-7', '-']);
    expect(args[args.indexOf('-m') + 1]).toBe('gpt-x');
  });
});

describe('parseClaudeLine', () => {
  it('reads the session id, assistant text and the result', () => {
    expect(parseClaudeLine('{"type":"system","session_id":"s1"}')).toEqual({ sessionId: 's1' });
    expect(
      parseClaudeLine(
        JSON.stringify({
          type: 'assistant',
          session_id: 's1',
          message: { content: [{ type: 'text', text: 'a' }, { type: 'tool_use' }, { type: 'text', text: 'b' }] },
        }),
      ),
    ).toEqual({ sessionId: 's1', text: 'a\nb' });
    expect(parseClaudeLine('{"type":"result","subtype":"success","result":"done"}')).toEqual({ done: { ok: true, result: 'done' } });
  });

  it('marks an error result as failed with its message', () => {
    expect(parseClaudeLine('{"type":"result","is_error":true,"result":"bad"}')).toEqual({ done: { ok: false, result: 'bad', error: 'bad' } });
    expect(parseClaudeLine('{"type":"result","subtype":"error_max_turns"}')).toEqual({ done: { ok: false, error: 'error_max_turns' } });
  });

  it('ignores lines that are not JSON objects', () => {
    expect(parseClaudeLine('hello')).toEqual({});
    expect(parseClaudeLine('[1]')).toEqual({});
  });
});

describe('parseCodexLine', () => {
  it('reads thread, message and turn events', () => {
    expect(parseCodexLine('{"type":"thread.started","thread_id":"t1"}')).toEqual({ sessionId: 't1' });
    expect(parseCodexLine('{"type":"item.completed","item":{"type":"agent_message","text":"hi"}}')).toEqual({ text: 'hi' });
    expect(parseCodexLine('{"type":"item.completed","item":{"type":"reasoning","text":"hm"}}')).toEqual({});
    expect(parseCodexLine('{"type":"turn.completed"}')).toEqual({ done: { ok: true } });
    expect(parseCodexLine('{"type":"turn.failed","error":{"message":"no"}}')).toEqual({ done: { ok: false, error: 'no' } });
    expect(parseCodexLine('{"type":"turn.failed"}')).toEqual({ done: { ok: false, error: 'The turn failed' } });
    expect(parseCodexLine('{"type":"error","message":"e"}')).toEqual({ error: 'e' });
    expect(parseCodexLine('nope')).toEqual({});
  });
});
