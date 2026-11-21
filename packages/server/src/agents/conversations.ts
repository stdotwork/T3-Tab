import { spawn as spawnProcess, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute } from 'node:path';
import { createInterface } from 'node:readline';

import type {
  AgentConversation,
  AgentMessage,
  AgentsStatus,
  AgentStartParams,
  AgentVia,
} from '@t3-tab/protocol';

import {
  claimNote,
  claudeArgs,
  codexArgs,
  directParser,
  firstLine,
  parseT3Launch,
  parseT3Show,
  t3FailureState,
  t3ProbeArgs,
  t3SendArgs,
  t3ShowArgs,
  t3StartArgs,
  type McpServerCommand,
} from './commands.js';
import { findExecutable, findT3 } from './locate.js';

const MAX_MESSAGE_CHARS = 100_000;
const MAX_SHOWN_CHARS = 20_000;
const MAX_MESSAGES = 50;
const MAX_CONVERSATIONS = 30;
const T3_COMMAND_TIMEOUT_MS = 60_000;
// Every `t3` call signs in to T3 for a moment, so its state is checked at most once a minute unless asked.
const T3_STATUS_TTL_MS = 60_000;
const DIRECT_RUN_TIMEOUT_MS = 60 * 60_000;
const POLL_GIVE_UP_MS = 6 * 60 * 60_000;
const MAX_POLL_FAILURES = 5;
const NAME = /^[^\s-][^\s]{0,199}$/;
const CLAIM = /^[A-Za-z0-9_-]{16,64}$/;

export type Spawn = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

export interface AgentsOptions {
  env: NodeJS.ProcessEnv;
  /** The `t3-tab mcp` command a direct run starts as its MCP server. */
  server: McpServerCommand;
  spawn?: Spawn;
  pollMs?: number;
}

interface Conversation {
  view: AgentConversation;
  claim: string;
  cwd?: string;
  child?: ChildProcess;
  poll?: ReturnType<typeof setTimeout>;
  /** The T3 run this conversation waits on; polling stops once the thread shows it finished. */
  expectedRun?: string;
  pollFailures: number;
  pollStarted: number;
}

/**
 * The conversations the side panel starts. A T3 thread runs in T3 Code through `t3 thread start|send|show
 * --json`, polled for replies; a direct run is one `claude -p` or `codex exec` process per turn, continued by
 * the session id the CLI printed. T3-Tab never runs a model itself.
 */
export class Agents {
  private readonly conversations = new Map<string, Conversation>();
  private readonly spawn: Spawn;
  private readonly pollMs: number;
  private t3Cache: { at: number; value: AgentsStatus['t3'] } | undefined;
  private closed = false;

  constructor(private readonly options: AgentsOptions) {
    this.spawn = options.spawn ?? ((command, args, spawnOptions) => spawnProcess(command, args, spawnOptions));
    this.pollMs = options.pollMs ?? 3_000;
  }

  async status(refresh = false): Promise<AgentsStatus> {
    const [t3, claude, codex] = await Promise.all([
      this.t3Status(refresh),
      findExecutable('claude', this.options.env),
      findExecutable('codex', this.options.env),
    ]);
    const status: AgentsStatus = { t3 };
    if (claude !== undefined) status.claude = claude;
    if (codex !== undefined) status.codex = codex;
    return status;
  }

  list(): AgentConversation[] {
    return [...this.conversations.values()].map((conversation) => conversation.view).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async start(value: unknown): Promise<AgentConversation> {
    const params = parseStartParams(value);
    if (params.via === 't3') return await this.startT3(params);
    return await this.startDirect(params);
  }

  async send(id: unknown, message: unknown): Promise<AgentConversation> {
    if (typeof id !== 'string') throw new Error('Invalid conversation id');
    const conversation = this.conversations.get(id);
    if (conversation === undefined) throw new Error('No such conversation. The background program may have restarted.');
    const text = parseMessage(message);
    if (conversation.view.via === 't3') {
      const threadId = conversation.view.threadId ?? '';
      const t3 = await this.requireT3();
      const result = await this.runT3(t3, t3SendArgs(threadId), text);
      const sent = parseT3Launch(result.stdout);
      this.push(conversation, { role: 'user', text });
      conversation.view.status = 'running';
      delete conversation.view.error;
      this.watchT3(conversation, sent.runId);
      return conversation.view;
    }
    if (conversation.child !== undefined) throw new Error('The agent is still working on the last message.');
    if (conversation.view.threadId === undefined) {
      throw new Error('This run printed no session id, so it cannot be continued. Start a new one.');
    }
    this.push(conversation, { role: 'user', text });
    await this.runDirect(conversation, text, conversation.view.threadId);
    return conversation.view;
  }

  close(): void {
    this.closed = true;
    for (const conversation of this.conversations.values()) {
      if (conversation.poll !== undefined) clearTimeout(conversation.poll);
      conversation.child?.kill('SIGTERM');
    }
  }

  private async startT3(params: StartParams): Promise<AgentConversation> {
    if (params.project === undefined) throw new Error('Choose a T3 project: its id or a folder inside it.');
    if ((params.provider === undefined) !== (params.model === undefined)) {
      throw new Error('Give both a provider instance and a model, or neither for the project default.');
    }
    const t3 = await this.requireT3();
    const result = await this.runT3(
      t3,
      t3StartArgs({ project: params.project, provider: params.provider, model: params.model }),
      `${params.message}${claimNote(params.claim)}`,
    );
    const launch = parseT3Launch(result.stdout);
    const conversation = this.add(params, { threadId: launch.threadId });
    this.push(conversation, { role: 'user', text: params.message });
    this.watchT3(conversation, launch.runId);
    return conversation.view;
  }

  private async startDirect(params: StartParams): Promise<AgentConversation> {
    const cwd = await workingFolder(params.project);
    const conversation = this.add(params, {});
    conversation.cwd = cwd;
    conversation.view.project = cwd;
    this.push(conversation, { role: 'user', text: params.message });
    try {
      await this.runDirect(conversation, params.message, undefined);
    } catch (error) {
      this.conversations.delete(conversation.view.id);
      throw error;
    }
    return conversation.view;
  }

  private add(params: StartParams, extra: { threadId?: string }): Conversation {
    const view: AgentConversation = {
      id: randomUUID(),
      via: params.via,
      title: firstLine(params.message).slice(0, 80) || 'Untitled',
      status: 'running',
      messages: [],
      updatedAt: Date.now(),
    };
    if (extra.threadId !== undefined) view.threadId = extra.threadId;
    if (params.project !== undefined) view.project = params.project;
    if (params.provider !== undefined) view.provider = params.provider;
    if (params.model !== undefined) view.model = params.model;
    const conversation: Conversation = { view, claim: params.claim, pollFailures: 0, pollStarted: Date.now() };
    this.conversations.set(view.id, conversation);
    this.prune();
    return conversation;
  }

  private prune(): void {
    if (this.conversations.size <= MAX_CONVERSATIONS) return;
    const idle = [...this.conversations.values()]
      .filter((conversation) => conversation.child === undefined && conversation.poll === undefined)
      .sort((a, b) => a.view.updatedAt - b.view.updatedAt);
    for (const conversation of idle) {
      if (this.conversations.size <= MAX_CONVERSATIONS) break;
      this.conversations.delete(conversation.view.id);
    }
  }

  private push(conversation: Conversation, message: AgentMessage): void {
    conversation.view.messages.push({ role: message.role, text: cap(message.text) });
    if (conversation.view.messages.length > MAX_MESSAGES) conversation.view.messages.splice(0, conversation.view.messages.length - MAX_MESSAGES);
    conversation.view.updatedAt = Date.now();
  }

  private async t3Status(refresh: boolean): Promise<AgentsStatus['t3']> {
    if (!refresh && this.t3Cache !== undefined && Date.now() - this.t3Cache.at < T3_STATUS_TTL_MS) return this.t3Cache.value;
    const path = await findT3(this.options.env);
    let value: AgentsStatus['t3'];
    if (path === undefined) value = { state: 'missing', detail: 'T3 Code was not found.' };
    else {
      try {
        const result = await run(this.spawn, path, t3ProbeArgs(), { env: this.options.env, timeoutMs: 15_000 });
        const state = result.code === 0 ? 'running' : t3FailureState(result.stderr);
        value = { state, path };
        if (state !== 'running') value.detail = firstLine(result.stderr) || `t3 exited with code ${String(result.code)}`;
      } catch (error) {
        value = { state: 'error', path, detail: error instanceof Error ? error.message : String(error) };
      }
    }
    this.t3Cache = { at: Date.now(), value };
    return value;
  }

  private async requireT3(): Promise<string> {
    const path = await findT3(this.options.env);
    if (path === undefined) throw new Error('T3 Code was not found. Run Claude Code or Codex directly instead.');
    return path;
  }

  /** Runs one `t3` command and throws its own one-line error when it fails. */
  private async runT3(path: string, args: string[], input?: string): Promise<RunResult> {
    const result = await run(this.spawn, path, args, { env: this.options.env, input, timeoutMs: T3_COMMAND_TIMEOUT_MS });
    if (result.code !== 0) {
      const state = t3FailureState(result.stderr);
      if (state === 'stopped') this.t3Cache = { at: Date.now(), value: { state, path, detail: firstLine(result.stderr) } };
      throw new Error(firstLine(result.stderr) || `t3 exited with code ${String(result.code)}`);
    }
    return result;
  }

  private watchT3(conversation: Conversation, runId: string | undefined): void {
    if (conversation.poll !== undefined) clearTimeout(conversation.poll);
    if (runId === undefined) delete conversation.expectedRun;
    else conversation.expectedRun = runId;
    conversation.pollFailures = 0;
    conversation.pollStarted = Date.now();
    conversation.poll = setTimeout(() => void this.pollT3(conversation), this.pollMs);
  }

  private async pollT3(conversation: Conversation): Promise<void> {
    delete conversation.poll;
    if (this.closed || !this.conversations.has(conversation.view.id)) return;
    let keepGoing = true;
    try {
      const t3 = await this.requireT3();
      const result = await this.runT3(t3, t3ShowArgs(conversation.view.threadId ?? ''));
      const show = parseT3Show(result.stdout);
      conversation.pollFailures = 0;
      if (show.title !== undefined && show.title !== '') conversation.view.title = show.title.slice(0, 80);
      if (show.messages.length > 0) {
        conversation.view.messages = show.messages.slice(-MAX_MESSAGES).map((message) => ({ ...message, text: cap(message.text) }));
      }
      const runSeen = conversation.expectedRun === undefined || show.latestRunId === undefined || show.latestRunId === conversation.expectedRun;
      // Right after a send the thread can still show its last run finished; it is running until the new run shows.
      conversation.view.status = !runSeen && show.status !== 'waiting' ? 'running' : show.status;
      conversation.view.updatedAt = Date.now();
      keepGoing = show.active || !runSeen;
    } catch (error) {
      conversation.pollFailures += 1;
      if (conversation.pollFailures >= MAX_POLL_FAILURES) {
        conversation.view.status = 'failed';
        conversation.view.error = error instanceof Error ? error.message : String(error);
        conversation.view.updatedAt = Date.now();
        keepGoing = false;
      }
    }
    if (keepGoing && Date.now() - conversation.pollStarted < POLL_GIVE_UP_MS && !this.closed) {
      conversation.poll = setTimeout(() => void this.pollT3(conversation), this.pollMs);
    }
  }

  /** Starts one turn of a direct run and returns once the process is running; replies arrive as it prints them. */
  private async runDirect(conversation: Conversation, message: string, resume: string | undefined): Promise<void> {
    const via = conversation.view.via as Exclude<AgentVia, 't3'>;
    const executable = await findExecutable(via, this.options.env);
    if (executable === undefined) throw new Error(`${via === 'claude' ? 'Claude Code' : 'Codex'} was not found on this machine.`);
    const runOptions = {
      server: this.options.server,
      claim: conversation.claim,
      env: this.options.env,
      model: conversation.view.model,
      resume,
    };
    const args = via === 'claude' ? claudeArgs(runOptions) : codexArgs(runOptions);
    const child = this.spawn(executable, args, {
      cwd: conversation.cwd ?? homedir(),
      env: this.options.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    conversation.child = child;
    conversation.view.status = 'running';
    delete conversation.view.error;
    conversation.view.updatedAt = Date.now();
    const parse = directParser(via);
    let reply: AgentMessage | undefined;
    let finished: { ok: boolean; error?: string; result?: string } | undefined;
    let lastError: string | undefined;
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), DIRECT_RUN_TIMEOUT_MS);
    if (child.stdout !== null) {
      createInterface({ input: child.stdout }).on('line', (line) => {
        const event = parse(line);
        if (event.sessionId !== undefined) conversation.view.threadId = event.sessionId;
        if (event.text !== undefined && event.text.trim() !== '') {
          if (reply === undefined) {
            this.push(conversation, { role: 'assistant', text: event.text });
            reply = conversation.view.messages.at(-1);
          } else {
            reply.text = cap(`${reply.text}\n\n${event.text}`);
            conversation.view.updatedAt = Date.now();
          }
        }
        if (event.error !== undefined) lastError = event.error;
        if (event.done !== undefined) finished = event.done;
      });
    }
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-4_000);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      delete conversation.child;
      if (reply === undefined && finished?.ok === true && finished.result !== undefined && finished.result.trim() !== '') {
        this.push(conversation, { role: 'assistant', text: finished.result });
      }
      const ok = finished?.ok ?? code === 0;
      if (ok && code === 0) conversation.view.status = 'idle';
      else {
        conversation.view.status = 'failed';
        conversation.view.error =
          finished?.error ?? lastError ?? (firstLine(stderr) || `${via} exited with code ${String(code)}`);
        this.push(conversation, { role: 'error', text: conversation.view.error });
      }
      conversation.view.updatedAt = Date.now();
    });
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', () => resolve());
      child.once('error', (error) => {
        clearTimeout(timer);
        delete conversation.child;
        conversation.view.status = 'failed';
        conversation.view.error = error.message;
        reject(error);
      });
    });
    child.stdin?.end(message);
  }
}

interface StartParams {
  via: AgentVia;
  message: string;
  claim: string;
  project?: string;
  provider?: string;
  model?: string;
}

/** Checks what the extension sent; the values end up as `t3`, `claude` and `codex` arguments. */
export function parseStartParams(value: unknown): StartParams {
  if (typeof value !== 'object' || value === null) throw new Error('Invalid start request');
  const candidate = value as Partial<Record<keyof AgentStartParams, unknown>>;
  if (candidate.via !== 't3' && candidate.via !== 'claude' && candidate.via !== 'codex') throw new Error('Invalid agent');
  if (typeof candidate.claim !== 'string' || !CLAIM.test(candidate.claim)) throw new Error('Invalid claim code');
  const params: StartParams = { via: candidate.via, message: parseMessage(candidate.message), claim: candidate.claim };
  const project = optionalText(candidate.project);
  if (project !== undefined) {
    if (project.length > 4_096 || project.startsWith('-') || project.includes('\0')) throw new Error('Invalid project');
    params.project = project;
  }
  for (const key of ['provider', 'model'] as const) {
    const text = optionalText(candidate[key]);
    if (text === undefined) continue;
    if (!NAME.test(text)) throw new Error(`Invalid ${key}: no spaces, and it may not start with "-"`);
    params[key] = text;
  }
  if (params.via !== 't3' && params.provider !== undefined) throw new Error('A provider instance applies only to T3 threads');
  return params;
}

function parseMessage(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error('The message is empty');
  if (value.length > MAX_MESSAGE_CHARS) throw new Error(`The message is longer than ${MAX_MESSAGE_CHARS} characters`);
  return value;
}

function optionalText(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new Error('Invalid field');
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

async function workingFolder(folder: string | undefined): Promise<string> {
  if (folder === undefined) return homedir();
  if (!isAbsolute(folder)) throw new Error('The folder must be an absolute path');
  const info = await stat(folder).catch(() => undefined);
  if (info?.isDirectory() !== true) throw new Error(`No such folder: ${folder}`);
  return folder;
}

function cap(text: string): string {
  return text.length <= MAX_SHOWN_CHARS ? text : `${text.slice(0, MAX_SHOWN_CHARS)}\n… (cut)`;
}

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

const MAX_OUTPUT_BYTES = 4 * 1_024 * 1_024;

/** Runs a short command with its input on stdin and collects what it prints. */
export async function run(
  spawn: Spawn,
  command: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; input?: string | undefined; timeoutMs: number },
): Promise<RunResult> {
  return await new Promise<RunResult>((resolve, reject) => {
    const child = spawn(command, args, { env: options.env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      finish(new Error(`${command} did not finish within ${options.timeoutMs / 1_000} seconds`));
    }, options.timeoutMs);
    const finish = (error: Error | undefined, code?: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error !== undefined) reject(error);
      else resolve({ code: code ?? null, stdout, stderr });
    };
    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < MAX_OUTPUT_BYTES) stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < MAX_OUTPUT_BYTES) stderr += chunk.toString();
    });
    child.once('error', (error) => finish(error));
    child.once('close', (code) => finish(undefined, code));
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(options.input ?? '');
  });
}
