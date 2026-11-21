import { EventEmitter } from 'node:events';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import type { ChildProcess } from 'node:child_process';

import type { AgentConversation } from '@t3-tab/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { claimNote, claudeArgs, t3SendArgs, t3ShowArgs, t3StartArgs } from '../src/agents/commands.js';
import { Agents, parseStartParams } from '../src/agents/conversations.js';
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
  agents?.close();
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
    expect(calls[0]?.args).toEqual(claudeArgs({ server: { command: 'node', args: ['/x/cli.js', 'mcp'] }, claim: CLAIM, env: { PATH: bin, HOME: home }, model: 'opus' }));
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
