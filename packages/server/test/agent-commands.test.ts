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
import { t3ShowJson } from './t3-show-fixture.js';

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
    expect(parseT3Show(show({ status: 'waiting' }))).toMatchObject({ status: 'waiting', active: true });
    expect(parseT3Show(show({ status: 'idle', pendingRequestCount: 1 }))).toMatchObject({ status: 'waiting' });
    expect(parseT3Show(show({ status: 'running', pendingRequestCount: 2 }))).toMatchObject({ status: 'waiting', active: true });
  });

  it('maps failed to failed, and completed or no status to idle', () => {
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
  it('starts only the t3-tab server with the claim file and state folder', () => {
    const args = claudeArgs({ server, claimFile: '/run/claim', env: { XDG_STATE_HOME: '/state' } });
    expect(args).toEqual(expect.arrayContaining(['-p', '--strict-mcp-config', '--allowedTools', 'mcp__t3-tab']));
    expect(args).not.toContain('--model');
    expect(args).not.toContain('--resume');
    const config = JSON.parse(args[args.indexOf('--mcp-config') + 1] as string) as {
      mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }>;
    };
    expect(Object.keys(config.mcpServers)).toEqual(['t3-tab']);
    expect(config.mcpServers['t3-tab']).toMatchObject({
      command: server.command,
      args: [...server.args, '--claim-file', '/run/claim'],
      env: { XDG_STATE_HOME: '/state' },
    });
  });

  it('leaves out XDG_STATE_HOME when unset or empty', () => {
    for (const env of [{}, { XDG_STATE_HOME: '' }]) {
      const args = claudeArgs({ server, env });
      const config = JSON.parse(args[args.indexOf('--mcp-config') + 1] as string) as {
        mcpServers: Record<string, { env: Record<string, string> }>;
      };
      expect(config.mcpServers['t3-tab']?.env).toEqual({});
    }
  });

  it('adds model and resume', () => {
    const args = claudeArgs({ server, env: {}, model: 'opus', resume: 'sess-1' });
    expect(args[args.indexOf('--model') + 1]).toBe('opus');
    expect(args[args.indexOf('--resume') + 1]).toBe('sess-1');
  });
});

describe('codexArgs', () => {
  it('runs exec read-only with the server set inline', () => {
    const args = codexArgs({ server, claimFile: '/run/claim', env: { XDG_STATE_HOME: '/state' } });
    expect(args.slice(0, 3)).toEqual(['exec', '--json', '--skip-git-repo-check']);
    expect(args.at(-1)).toBe('-');
    expect(args).toContain('sandbox_mode="read-only"');
    expect(args).toContain('mcp_servers.t3-tab.command="/usr/bin/node"');
    expect(args).toContain('mcp_servers.t3-tab.args=["/x/cli.js", "mcp", "--claim-file", "/run/claim"]');
    expect(args).toContain('mcp_servers.t3-tab.env={ XDG_STATE_HOME = "/state" }');
    expect(args).not.toContain('-m');
    expect(args).not.toContain('resume');
    for (const [index, value] of args.entries()) if (value.includes('=')) expect(args[index - 1]).toBe('-c');
  });

  it('puts the resume id just before the final dash, and the model after the settings', () => {
    const args = codexArgs({ server, env: {}, model: 'gpt-x', resume: 'th-7' });
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

describe('direct run isolation', () => {
  const claimFile = '/state/claims/run-x/claim';

  it('limits Claude Code to the T3-Tab server, with no settings, hooks or built-in tools', () => {
    const args = claudeArgs({ server, claimFile, env: {} });
    const config = args[args.indexOf('--mcp-config') + 1] as string;
    expect(args).toEqual([
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--restricted',
      '--setting-sources',
      '',
      '--strict-mcp-config',
      '--mcp-config',
      config,
      '--tools',
      '',
      '--allowedTools',
      'mcp__t3-tab',
      '--permission-mode',
      'dontAsk',
      '--disable-slash-commands',
    ]);
    const parsed = JSON.parse(config) as { mcpServers: Record<string, { args: string[]; env: Record<string, string> }> };
    expect(Object.keys(parsed.mcpServers)).toEqual(['t3-tab']);
    expect(parsed.mcpServers['t3-tab']?.args).toEqual(['/x/cli.js', 'mcp', '--claim-file', claimFile]);
    expect(parsed.mcpServers['t3-tab']?.env).toEqual({});
  });

  it('limits Codex to the T3-Tab server, ignoring user config and turning off shell, apps, plugins and hooks', () => {
    const args = codexArgs({ server, claimFile, env: { XDG_STATE_HOME: '/state' } });
    const disabled = [
      'shell_tool',
      'unified_exec',
      'view_image',
      'apps',
      'plugins',
      'remote_plugin',
      'hooks',
      'plugin_hooks',
      'multi_agent',
      'tool_suggest',
      'in_app_browser',
      'browser_use',
      'browser_use_external',
      'computer_use',
      'image_generation',
      'skill_mcp_dependency_install',
      'goals',
      'memories',
      'standalone_web_search',
    ];
    expect(args).toEqual([
      'exec',
      '--json',
      '--skip-git-repo-check',
      '--ignore-user-config',
      '--ignore-rules',
      ...disabled.flatMap((feature) => ['--disable', feature]),
      '-c',
      'approval_policy="never"',
      '-c',
      'sandbox_mode="read-only"',
      '-c',
      'web_search="disabled"',
      '-c',
      'mcp_servers.t3-tab.command="/usr/bin/node"',
      '-c',
      `mcp_servers.t3-tab.args=["/x/cli.js", "mcp", "--claim-file", "${claimFile}"]`,
      '-c',
      'mcp_servers.t3-tab.env={ XDG_STATE_HOME = "/state" }',
      '-c',
      'mcp_servers.t3-tab.env_vars=[]',
      '-c',
      'mcp_servers.t3-tab.enabled=true',
      '-c',
      'mcp_servers.t3-tab.enabled_tools=["status", "tabs", "read", "screenshot", "act", "run_js"]',
      '-c',
      'mcp_servers.t3-tab.disabled_tools=[]',
      '-c',
      'mcp_servers.t3-tab.default_tools_approval_mode="approve"',
      '-c',
      'mcp_servers.t3-tab.tool_timeout_sec=330',
      '-',
    ]);
  });

  it('gives a Codex tool call longer than the 310 seconds T3-Tab itself waits', () => {
    const args = codexArgs({ server, env: {} });
    const setting = args.find((value) => value.startsWith('mcp_servers.t3-tab.tool_timeout_sec='));
    expect(Number(setting?.split('=')[1])).toBeGreaterThan(310);
  });

  it('keeps the same isolation on a resumed turn', () => {
    const fresh = codexArgs({ server, env: {} });
    const resumed = codexArgs({ server, env: {}, resume: 'th-7' });
    expect(resumed.slice(0, 2)).toEqual(['exec', 'resume']);
    expect(resumed.slice(2, -2)).toEqual(fresh.slice(1, -1));
    expect(resumed.slice(-2)).toEqual(['th-7', '-']);
  });

  it('puts no claim code on the command line', () => {
    for (const args of [claudeArgs({ server, claimFile, env: {} }), codexArgs({ server, claimFile, env: {} })]) {
      expect(args.join(' ')).not.toContain(CODE);
      expect(args.join(' ')).not.toContain('T3_TAB_CLAIM');
    }
  });
});

describe('T3 run status', () => {
  const show = (status: string): string => t3ShowJson({ status });

  // Every status in T3 Code's OrchestratorMcpThreadStatus (idle plus OrchestrationV2RunStatus).
  it.each([
    ['idle', 'idle', false],
    ['preparing', 'running', true],
    ['queued', 'running', true],
    ['starting', 'running', true],
    ['running', 'running', true],
    ['waiting', 'waiting', true],
    ['completed', 'idle', false],
    ['interrupted', 'failed', false],
    ['failed', 'failed', false],
    ['cancelled', 'failed', false],
    ['rolled_back', 'failed', false],
  ])('maps %s to %s (still following: %s)', (status, expected, active) => {
    expect(parseT3Show(show(status))).toMatchObject({ status: expected, active });
  });

  it('keeps following a status it does not know', () => {
    expect(parseT3Show(show('paused'))).toMatchObject({ status: 'running', active: true });
  });

  it('reads no failure text from a field `t3 thread show --json` does not print', () => {
    const printed = JSON.parse(show('failed')) as Record<string, unknown>;
    expect(Object.keys(printed)).toEqual(['thread', 'messages']);
    expect(parseT3Show(JSON.stringify({ ...printed, error: 'A field T3 does not have' }))).toMatchObject({ status: 'failed', error: 'The run failed.' });
  });

  it.each([
    ['interrupted', 'The run was interrupted.'],
    ['cancelled', 'The run was cancelled.'],
    ['rolled_back', 'The run was rolled back.'],
    ['failed', 'The run failed.'],
  ])('says what happened to a %s run', (status, text) => {
    expect(parseT3Show(show(status))).toMatchObject({ status: 'failed', error: text });
  });

  it('carries no error for a run that completed', () => {
    expect(parseT3Show(show('completed')).error).toBeUndefined();
  });
});
