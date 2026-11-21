import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { spawn as realSpawn } from 'node:child_process';
import { PassThrough, Writable } from 'node:stream';
import type { ChildProcess } from 'node:child_process';

import type { AgentConversation } from '@t3-tab/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { claimNote, claudeArgs, t3SendArgs, t3ShowArgs, t3StartArgs } from '../src/agents/commands.js';
import { Agents, parseStartParams, run, type Spawn } from '../src/agents/conversations.js';
import { findExecutable } from '../src/agents/locate.js';

const CLAIM = 'abcdefghijklmnop1234';
const realClaude = (await findExecutable('claude', { PATH: '', HOME: '/nonexistent' })) !== undefined;

interface Call {
  command: string;
  args: string[];
  stdin: string;
  cwd?: unknown;
}
interface Script {
  stdout?: string;
  stderr?: string;
  code?: number;
  /** Keeps the process running until this resolves. */
  hold?: Promise<void>;
}
type Handler = (call: Call) => Script | Promise<Script>;

let root: string;
let home: string;
let bin: string;
let agents: Agents | undefined;
let calls: Call[];
let handler: Handler;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 't3-tab-agents-'));
  home = join(root, 'home');
  bin = join(root, 'bin');
  await mkdir(home, { recursive: true });
  await mkdir(bin, { recursive: true });
  calls = [];
  handler = () => ({});
});

afterEach(async () => {
  await agents?.close();
  agents = undefined;
  await rm(root, { recursive: true, force: true });
});

async function install(...names: string[]): Promise<void> {
  for (const name of names) {
    await writeFile(join(bin, name), '#!/bin/sh\n');
    await chmod(join(bin, name), 0o755);
  }
}

function fakeSpawn(command: string, args: string[], options: { cwd?: unknown }): ChildProcess {
  const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let stdin = '';
  const finish = async (): Promise<void> => {
    const call: Call = { command, args, stdin, cwd: options.cwd };
    calls.push(call);
    const script = await handler(call);
    await script.hold;
    if (script.stdout !== undefined) stdout.write(script.stdout);
    if (script.stderr !== undefined) stderr.write(script.stderr);
    stdout.end();
    stderr.end();
    await new Promise((resolve) => setTimeout(resolve, 20));
    child.emit('close', script.code ?? 0);
  };
  child.stdin = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      stdin += chunk.toString();
      callback();
    },
    final(callback) {
      callback();
      void finish();
    },
  });
  child.stdout = stdout;
  child.stderr = stderr;
  child.kill = () => true;
  setImmediate(() => child.emit('spawn'));
  return child as unknown as ChildProcess;
}

function make(extraEnv: NodeJS.ProcessEnv = {}): Agents {
  agents = new Agents({
    env: { PATH: bin, HOME: home, ...extraEnv },
    server: { command: 'node', args: ['/x/cli.js', 'mcp'] },
    spawn: fakeSpawn,
    pollMs: 10,
  });
  return agents;
}

async function waitFor(check: () => boolean, what: string): Promise<void> {
  const end = Date.now() + 4_000;
  while (!check()) {
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function view(id: string): AgentConversation {
  const found = agents?.list().find((conversation) => conversation.id === id);
  if (found === undefined) throw new Error('no conversation');
  return found;
}

const showJson = (status: string, latestRunId: string, messages: unknown[] = []): string =>
  JSON.stringify({ thread: { status, latestRunId, title: 'Thread title' }, messages });

describe('parseStartParams', () => {
  const base = { via: 'claude', message: 'hi', claim: CLAIM };

  it('accepts a valid request and trims optional fields', () => {
    expect(parseStartParams({ ...base, via: 't3', project: ' /p ', provider: 'inst', model: 'm' })).toEqual({
      via: 't3', message: 'hi', claim: CLAIM, project: '/p', provider: 'inst', model: 'm',
    });
    expect(parseStartParams({ ...base, project: '  ', model: null })).toEqual(base);
  });

  it('rejects a project or model starting with a dash', () => {
    expect(() => parseStartParams({ ...base, project: '-rf' })).toThrow('Invalid project');
    expect(() => parseStartParams({ ...base, model: '-x' })).toThrow('Invalid model');
    expect(() => parseStartParams({ ...base, via: 't3', provider: '-x', model: 'm' })).toThrow('Invalid provider');
  });

  it('rejects a model containing a space', () => {
    expect(() => parseStartParams({ ...base, model: 'a b' })).toThrow('Invalid model');
  });

  it('rejects a provider for a direct run', () => {
    expect(() => parseStartParams({ ...base, provider: 'x', model: 'm' })).toThrow('A provider instance applies only to T3 threads');
  });

  it('rejects an invalid claim, message, agent or body', () => {
    expect(() => parseStartParams({ ...base, claim: 'short' })).toThrow('Invalid claim code');
    expect(() => parseStartParams({ ...base, claim: undefined })).toThrow('Invalid claim code');
    expect(() => parseStartParams({ ...base, message: '   ' })).toThrow('The message is empty');
    expect(() => parseStartParams({ ...base, message: 'x'.repeat(100_001) })).toThrow('longer than');
    expect(() => parseStartParams({ ...base, via: 'gemini' })).toThrow('Invalid agent');
    expect(() => parseStartParams('nope')).toThrow('Invalid start request');
    expect(() => parseStartParams({ ...base, model: 5 })).toThrow('Invalid field');
  });
});

describe('Agents.status', () => {
  it('reports T3 running when the probe says no project matches', async () => {
    await install('t3', 'claude');
    handler = () => ({ code: 1, stderr: "No T3 Code project matches '/'\n" });
    const status = await make().status();
    expect(status.t3).toMatchObject({ state: 'running', path: join(bin, 't3') });
    expect(status.claude).toBe(join(bin, 'claude'));
    expect(status.codex).toBeUndefined();
    expect(calls[0]?.args).toEqual(['thread', 'list', '--json', '--project', '/']);
  });

  it('reports T3 stopped with the first stderr line', async () => {
    await install('t3');
    handler = () => ({ code: 1, stderr: 'No running T3 Code server uses /x\nmore' });
    expect((await make().status()).t3).toEqual({
      state: 'stopped', path: join(bin, 't3'), detail: 'No running T3 Code server uses /x',
    });
  });

  it('reports T3 error for other failures', async () => {
    await install('t3');
    handler = () => ({ code: 2 });
    expect((await make().status()).t3).toMatchObject({ state: 'error', detail: 't3 exited with code 2' });
  });

  it('reports T3 missing when there is no t3', async () => {
    // T3_TAB_T3 is used alone when set, so a real t3 in the usual install folders cannot be found instead.
    const status = await make({ T3_TAB_T3: join(bin, 't3') }).status();
    expect(status.t3).toEqual({ state: 'missing', detail: 'T3 Code was not found.' });
  });
});

describe('T3 conversations', () => {
  async function startT3(): Promise<AgentConversation> {
    return await make().start({ via: 't3', message: 'Do it', claim: CLAIM, project: '/proj', provider: 'inst', model: 'm1' });
  }

  it('refuses a provider without a model, and a missing project', async () => {
    await install('t3');
    await expect(make().start({ via: 't3', message: 'x', claim: CLAIM, project: '/p', provider: 'inst' })).rejects.toThrow('both a provider');
    await expect(make().start({ via: 't3', message: 'x', claim: CLAIM })).rejects.toThrow('Choose a T3 project');
    expect(calls).toEqual([]);
  });

  it('starts a thread with the claim note on stdin and follows it until idle', async () => {
    await install('t3');
    let shows = 0;
    handler = (call) => {
      if (call.args[1] === 'start') return { stdout: '{"threadId":"th1","runId":"r1"}' };
      shows += 1;
      return {
        stdout:
          shows < 3
            ? showJson('running', 'r1', [{ role: 'user', text: `Do it${claimNote(CLAIM)}` }])
            : showJson('idle', 'r1', [
                { role: 'user', text: `Do it${claimNote(CLAIM)}` },
                { role: 'assistant', text: 'Done.' },
              ]),
      };
    };
    const started = await startT3();
    expect(calls[0]?.args).toEqual(t3StartArgs({ project: '/proj', provider: 'inst', model: 'm1' }));
    expect(calls[0]?.stdin).toBe(`Do it${claimNote(CLAIM)}`);
    expect(started).toMatchObject({ via: 't3', threadId: 'th1', status: 'running', project: '/proj', provider: 'inst', model: 'm1' });
    expect(started.messages).toEqual([{ role: 'user', text: 'Do it' }]);

    await waitFor(() => view(started.id).status === 'idle', 'idle');
    expect(shows).toBe(3);
    expect(calls.at(-1)?.args).toEqual(t3ShowArgs('th1'));
    expect(view(started.id).messages).toEqual([
      { role: 'user', text: 'Do it' },
      { role: 'assistant', text: 'Done.' },
    ]);
    expect(view(started.id).title).toBe('Thread title');
    const shown = JSON.stringify(view(started.id).messages);
    expect(shown).not.toContain('[T3-Tab]');
  });

  it('keeps polling while the thread still shows an older run than the one just sent', async () => {
    await install('t3');
    let shows = 0;
    handler = (call) => {
      if (call.args[1] === 'start') return { stdout: '{"threadId":"th1","runId":"r2"}' };
      shows += 1;
      return { stdout: shows <= 4 ? showJson('idle', 'r1') : showJson('idle', 'r2', [{ role: 'assistant', text: 'ok' }]) };
    };
    const started = await startT3();
    await waitFor(() => shows >= 3, 'several polls');
    expect(view(started.id).status).toBe('running');
    await waitFor(() => shows >= 5 && view(started.id).status === 'idle', 'idle');
    expect(view(started.id).messages).toEqual([{ role: 'assistant', text: 'ok' }]);
  });

  it('sends a follow-up with thread send and polls again', async () => {
    await install('t3');
    let phase = 'first';
    handler = (call) => {
      if (call.args[1] === 'start') return { stdout: '{"threadId":"th1","runId":"r1"}' };
      if (call.args[1] === 'send') {
        phase = 'second';
        return { stdout: '{"threadId":"th1","runId":"r2"}' };
      }
      return {
        stdout:
          phase === 'first'
            ? showJson('idle', 'r1', [{ role: 'assistant', text: 'one' }])
            : showJson('idle', 'r2', [{ role: 'assistant', text: 'one' }, { role: 'assistant', text: 'two' }]),
      };
    };
    const started = await startT3();
    await waitFor(() => view(started.id).status === 'idle', 'first idle');
    const sent = await make2(agents).send(started.id, 'more');
    expect(sent.status).toBe('running');
    const sendCall = calls.find((call) => call.args[1] === 'send');
    expect(sendCall?.args).toEqual(t3SendArgs('th1'));
    expect(sendCall?.stdin).toBe('more');
    await waitFor(() => view(started.id).messages.length === 2 && view(started.id).status === 'idle', 'second idle');
    expect(view(started.id).messages.at(-1)).toEqual({ role: 'assistant', text: 'two' });
  });

  it('throws the first stderr line when t3 fails to start', async () => {
    await install('t3');
    handler = () => ({ code: 1, stderr: 'No running T3 Code server uses /proj\nx' });
    await expect(startT3()).rejects.toThrow('No running T3 Code server uses /proj');
    expect(agents?.list()).toEqual([]);
  });
});

function make2(value: Agents | undefined): Agents {
  if (value === undefined) throw new Error('no agents');
  return value;
}

describe('direct runs', () => {
  const claudeStream = (sessionId: string, text: string): string =>
    [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: sessionId }),
      JSON.stringify({ type: 'assistant', session_id: sessionId, message: { content: [{ type: 'text', text }] } }),
      JSON.stringify({ type: 'result', subtype: 'success', session_id: sessionId, result: text }),
    ].join('\n') + '\n';

  it('runs claude with the message on stdin, records the reply, and resumes the session on the next send', async () => {
    await install('claude');
    let turn = 0;
    handler = () => {
      turn += 1;
      return { stdout: claudeStream('sess-1', turn === 1 ? 'Hello' : 'Again') };
    };
    const started = await make().start({ via: 'claude', message: 'Hi', claim: CLAIM, model: 'opus', project: home });
    expect(calls[0]?.command).toBe(join(bin, 'claude'));
    expect(calls[0]?.cwd).toBe(home);
    await waitFor(() => view(started.id).status === 'idle', 'idle');
    expect(calls[0]?.stdin).toBe('Hi');
    const sent = calls[0]?.args ?? [];
    const claimFile = (JSON.parse(sent[sent.indexOf('--mcp-config') + 1] as string) as { mcpServers: Record<string, { args: string[] }> }).mcpServers['t3-tab']?.args.at(-1);
    expect(sent).toEqual(claudeArgs({ server: { command: 'node', args: ['/x/cli.js', 'mcp'] }, claimFile, env: { PATH: bin, HOME: home }, model: 'opus' }));
    expect(view(started.id)).toMatchObject({ threadId: 'sess-1', project: home });
    expect(view(started.id).messages).toEqual([
      { role: 'user', text: 'Hi' },
      { role: 'assistant', text: 'Hello' },
    ]);

    await agents?.send(started.id, 'More');
    await waitFor(() => view(started.id).status === 'idle' && view(started.id).messages.length === 4, 'second turn');
    const resume = calls[1]?.args ?? [];
    expect(resume[resume.indexOf('--resume') + 1]).toBe('sess-1');
    expect(calls[1]?.stdin).toBe('More');
    expect(view(started.id).messages.at(-1)).toEqual({ role: 'assistant', text: 'Again' });
  });

  it('refuses a send while the run is still working', async () => {
    await install('claude');
    let release: () => void = () => undefined;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    handler = () => ({ stdout: claudeStream('sess-1', 'late'), hold });
    const started = await make().start({ via: 'claude', message: 'Hi', claim: CLAIM });
    expect(started.status).toBe('running');
    await expect(make2(agents).send(started.id, 'again')).rejects.toThrow('still working');
    release();
    await waitFor(() => view(started.id).status === 'idle', 'idle');
  });

  it('ends failed with an error message when the process exits with an error', async () => {
    await install('claude');
    handler = () => ({ code: 1, stderr: 'boom happened\nsecond line' });
    const started = await make().start({ via: 'claude', message: 'Hi', claim: CLAIM });
    await waitFor(() => view(started.id).status === 'failed', 'failed');
    expect(view(started.id).error).toBe('boom happened');
    expect(view(started.id).messages.at(-1)).toEqual({ role: 'error', text: 'boom happened' });
  });

  it('runs codex and parses its events', async () => {
    await install('codex');
    handler = () => ({
      stdout: [
        '{"type":"thread.started","thread_id":"cx-1"}',
        '{"type":"item.completed","item":{"type":"agent_message","text":"Hi there"}}',
        '{"type":"turn.completed"}',
      ].join('\n') + '\n',
    });
    const started = await make().start({ via: 'codex', message: 'Hi', claim: CLAIM });
    await waitFor(() => view(started.id).status === 'idle', 'idle');
    expect(view(started.id).threadId).toBe('cx-1');
    expect(view(started.id).messages.at(-1)).toEqual({ role: 'assistant', text: 'Hi there' });
    expect(basename(calls[0]?.command ?? '')).toBe('codex');
  });

  // The usual install folders are searched after PATH, so a real claude in /usr/bin would be found.
  it.skipIf(realClaude)('refuses to start when the CLI is missing', async () => {
    await expect(make().start({ via: 'claude', message: 'Hi', claim: CLAIM })).rejects.toThrow('Claude Code was not found');
  });

  it('refuses to start in a folder that does not exist', async () => {
    await install('claude');
    make();
    await expect(make2(agents).start({ via: 'claude', message: 'Hi', claim: CLAIM, project: join(root, 'nope') })).rejects.toThrow('No such folder');
    await expect(make2(agents).start({ via: 'claude', message: 'Hi', claim: CLAIM, project: 'relative' })).rejects.toThrow('absolute path');
    expect(agents?.list()).toEqual([]);
  });

  it('refuses a send to an unknown conversation', async () => {
    await expect(make().send('nope', 'x')).rejects.toThrow('No such conversation');
    await expect(make2(agents).send(5, 'x')).rejects.toThrow('Invalid conversation id');
  });
});

describe('T3 polling', () => {
  const launch = '{"threadId":"th1","runId":"r1"}';

  it('keeps following a waiting run through running to idle', async () => {
    await install('t3');
    const states = ['waiting', 'waiting', 'running', 'idle'];
    let shows = 0;
    handler = (call) => {
      if (call.args[1] === 'start') return { stdout: launch };
      const status = states[Math.min(shows, states.length - 1)] as string;
      shows += 1;
      return { stdout: showJson(status, 'r1', status === 'idle' ? [{ role: 'assistant', text: 'Finished' }] : []) };
    };
    const started = await make().start({ via: 't3', message: 'Do it', claim: CLAIM, project: '/proj' });
    await waitFor(() => view(started.id).status === 'waiting', 'waiting');
    await waitFor(() => view(started.id).status === 'idle', 'idle after waiting');
    expect(shows).toBe(4);
    expect(view(started.id).messages.at(-1)).toEqual({ role: 'assistant', text: 'Finished' });
  });

  it('shows a run that ended without completing as failed, with its error', async () => {
    await install('t3');
    handler = (call) =>
      call.args[1] === 'start'
        ? { stdout: launch }
        : { stdout: JSON.stringify({ thread: { status: 'interrupted', latestRunId: 'r1' }, messages: [{ role: 'user', text: 'Do it' }], error: 'Stopped by the owner' }) };
    const started = await make().start({ via: 't3', message: 'Do it', claim: CLAIM, project: '/proj' });
    await waitFor(() => view(started.id).status === 'failed', 'failed');
    expect(view(started.id).error).toBe('Stopped by the owner');
    expect(view(started.id).messages.at(-1)).toEqual({ role: 'error', text: 'Stopped by the owner' });
  });

  it('ends failed, with a message, when polling reaches its time limit', async () => {
    await install('t3');
    handler = (call) => (call.args[1] === 'start' ? { stdout: launch } : { stdout: showJson('running', 'r1') });
    agents = new Agents({ env: { PATH: bin, HOME: home }, server: { command: 'node', args: [] }, spawn: fakeSpawn, pollMs: 5, pollGiveUpMs: 40 });
    const started = await agents.start({ via: 't3', message: 'Do it', claim: CLAIM, project: '/proj' });
    await waitFor(() => view(started.id).status === 'failed', 'failed at the time limit');
    expect(view(started.id).error).toContain('stopped following');
    expect(view(started.id).messages.at(-1)?.role).toBe('error');
  });

  it('hides the claim code when the agent repeats it in a reply or the title', async () => {
    await install('t3');
    handler = (call) =>
      call.args[1] === 'start'
        ? { stdout: launch }
        : {
            stdout: JSON.stringify({
              thread: { status: 'failed', latestRunId: 'r1', title: `Claim ${CLAIM}` },
              messages: [{ role: 'assistant', text: `I used ${CLAIM} to claim the tab` }],
              error: `Bad code ${CLAIM}`,
            }),
          };
    const started = await make().start({ via: 't3', message: 'Do it', claim: CLAIM, project: '/proj' });
    await waitFor(() => view(started.id).status === 'failed', 'failed');
    expect(JSON.stringify(view(started.id))).not.toContain(CLAIM);
    expect(view(started.id).messages[0]?.text).toContain('I used');
  });
});

describe('status probe', () => {
  it('shares one t3 probe between overlapping refreshes', async () => {
    await install('t3');
    let release: () => void = () => undefined;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    handler = () => ({ code: 1, stderr: "No T3 Code project matches '/'", hold });
    make();
    const first = make2(agents).status(true);
    const second = make2(agents).status(true);
    await waitFor(() => calls.length >= 1, 'the probe');
    await new Promise((resolve) => setTimeout(resolve, 30));
    release();
    const [one, two] = await Promise.all([first, second]);
    expect(calls).toHaveLength(1);
    expect(one.t3.state).toBe('running');
    expect(two.t3.state).toBe('running');
  });
});

describe('direct turn claims', () => {
  const FRESH = 'zyxwvutsrqponmlk9876';
  const claudeReply = (text: string): string =>
    [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-1' }),
      JSON.stringify({ type: 'assistant', session_id: 'sess-1', message: { content: [{ type: 'text', text }] } }),
      JSON.stringify({ type: 'result', subtype: 'success', session_id: 'sess-1', result: text }),
    ].join('\n') + '\n';

  function claimFileOf(args: string[]): string | undefined {
    const config = JSON.parse(args[args.indexOf('--mcp-config') + 1] as string) as { mcpServers: Record<string, { args: string[] }> };
    const serverArgs = config.mcpServers['t3-tab']?.args ?? [];
    const index = serverArgs.indexOf('--claim-file');
    return index === -1 ? undefined : serverArgs[index + 1];
  }

  it('hands each turn its own code in a private file, never on the command line, and removes the file', async () => {
    await install('claude');
    const seen: Array<{ path: string; code: string; mode: number }> = [];
    handler = async (call) => {
      expect(call.args.join(' ')).not.toContain(CLAIM);
      expect(call.args.join(' ')).not.toContain(FRESH);
      const path = claimFileOf(call.args) as string;
      seen.push({ path, code: await readFile(path, 'utf8'), mode: (await stat(path)).mode & 0o777 });
      return { stdout: claudeReply('ok') };
    };
    const started = await make().start({ via: 'claude', message: 'Hi', claim: CLAIM });
    await waitFor(() => view(started.id).status === 'idle', 'first turn');
    await make2(agents).send(started.id, 'More', FRESH);
    await waitFor(() => view(started.id).status === 'idle' && view(started.id).messages.length === 4, 'second turn');
    expect(seen.map((entry) => entry.code)).toEqual([CLAIM, FRESH]);
    expect(seen.map((entry) => entry.mode)).toEqual([0o600, 0o600]);
    expect(seen[0]?.path).not.toBe(seen[1]?.path);
    await waitFor(() => seen.every((entry) => !existsSync(entry.path)), 'the claim files to go');
  });

  it('starts a turn with no claim file when the owner has no tabs left to share', async () => {
    await install('claude');
    const files: Array<string | undefined> = [];
    handler = (call) => {
      files.push(claimFileOf(call.args));
      return { stdout: claudeReply('ok') };
    };
    const started = await make().start({ via: 'claude', message: 'Hi', claim: CLAIM });
    await waitFor(() => view(started.id).status === 'idle', 'first turn');
    await make2(agents).send(started.id, 'More');
    await waitFor(() => view(started.id).messages.length === 4, 'second turn');
    expect(files[0]).toBeDefined();
    expect(files[1]).toBeUndefined();
  });

  it('refuses an invalid code on a send', async () => {
    await install('claude');
    handler = () => ({ stdout: claudeReply('ok') });
    const started = await make().start({ via: 'claude', message: 'Hi', claim: CLAIM });
    await waitFor(() => view(started.id).status === 'idle', 'first turn');
    await expect(make2(agents).send(started.id, 'More', 'short')).rejects.toThrow('Invalid claim code');
  });

  it('hides the code if a direct run prints it', async () => {
    await install('claude');
    handler = () => ({ stdout: claudeReply(`Your code is ${CLAIM}`) });
    const started = await make().start({ via: 'claude', message: 'Hi', claim: CLAIM });
    await waitFor(() => view(started.id).status === 'idle', 'idle');
    expect(JSON.stringify(view(started.id))).not.toContain(CLAIM);
  });

  it('shows a warning in the conversation when its claim fails', async () => {
    await install('claude');
    let release: () => void = () => undefined;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    handler = () => ({ stdout: claudeReply('ok'), hold });
    const started = await make().start({ via: 'claude', message: 'Hi', claim: CLAIM });
    make2(agents).claimFailed(CLAIM, 'Unknown claim code');
    expect(view(started.id).messages.at(-1)?.role).toBe('error');
    expect(view(started.id).messages.at(-1)?.text).toContain('could not share');
    release();
    await waitFor(() => view(started.id).status === 'idle', 'idle');
  });
});

describe('stopping processes', () => {
  // Ignores SIGTERM, and so does a child it starts in the same process group.
  const STUBBORN = `
    import { spawn } from 'node:child_process';
    import { writeFileSync } from 'node:fs';
    process.on('SIGTERM', () => undefined);
    const child = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], { stdio: 'ignore' });
    writeFileSync(process.env.PIDS_FILE, JSON.stringify([process.pid, child.pid]));
    setInterval(() => undefined, 1000);
  `;

  async function stubborn(name: string): Promise<{ command: string; pidsFile: string }> {
    const script = join(root, 'stubborn.mjs');
    const pidsFile = join(root, 'pids.json');
    await writeFile(script, STUBBORN);
    const command = join(bin, name);
    await writeFile(command, `#!/bin/sh\nexec "${process.execPath}" "${script}"\n`);
    await chmod(command, 0o755);
    return { command, pidsFile };
  }

  const alive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  async function pidsFrom(file: string): Promise<number[]> {
    await waitFor(() => existsSync(file), 'the child to report its pids');
    await new Promise((resolve) => setTimeout(resolve, 30));
    return JSON.parse(await readFile(file, 'utf8')) as number[];
  }

  const spawnReal: Spawn = (command, args, options) => realSpawn(command, args, options);

  it('kills a direct run and its children that ignore SIGTERM, and marks it timed out', async () => {
    const { pidsFile } = await stubborn('claude');
    agents = new Agents({
      env: { PATH: bin, HOME: home, PIDS_FILE: pidsFile },
      server: { command: 'node', args: [] },
      spawn: spawnReal,
      directTimeoutMs: 400,
      graceMs: 150,
    });
    const started = await agents.start({ via: 'claude', message: 'Hi', claim: CLAIM });
    const pids = await pidsFrom(pidsFile);
    await waitFor(() => view(started.id).status === 'failed', 'the run to be stopped');
    expect(view(started.id).error).toContain('timed out');
    await waitFor(() => pids.every((pid) => !alive(pid)), 'both processes to die');
  });

  it('kills a running direct run on shutdown and waits for it', async () => {
    const { pidsFile } = await stubborn('claude');
    agents = new Agents({ env: { PATH: bin, HOME: home, PIDS_FILE: pidsFile }, server: { command: 'node', args: [] }, spawn: spawnReal, graceMs: 150 });
    const started = await agents.start({ via: 'claude', message: 'Hi', claim: CLAIM });
    const pids = await pidsFrom(pidsFile);
    await agents.close();
    // `close` waited for the run itself; its child, killed with the group, is reaped by init a moment later.
    expect(alive(pids[0] as number)).toBe(false);
    expect(view(started.id).status).toBe('failed');
    await waitFor(() => pids.every((pid) => !alive(pid)), 'the child to die with its group');
  });

  it('kills a short command that ignores SIGTERM when it times out', async () => {
    const { command, pidsFile } = await stubborn('t3');
    const pending = run(spawnReal, command, [], { env: { PATH: bin, HOME: home, PIDS_FILE: pidsFile }, timeoutMs: 300, graceMs: 100 });
    const pids = await pidsFrom(pidsFile);
    await expect(pending).rejects.toThrow('did not finish');
    await waitFor(() => pids.every((pid) => !alive(pid)), 'both processes to die');
  });
});
