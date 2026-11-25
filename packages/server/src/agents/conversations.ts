import { spawn as spawnProcess, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute } from 'node:path';
import { createInterface } from 'node:readline';

import type {
  AgentConversation,
  AgentItem,
  AgentMessage,
  AgentsStatus,
  AgentStartParams,
  AgentVia,
  ClaimFileProblem,
} from '@t3-tab/protocol';

import { stateDirectory } from '../state.js';
import { CLAIM_CODE, claimFileWarning, writeClaimFile, type ClaimFile } from './claim-file.js';
import { readCodexProvider } from './codex-provider.js';
import { claudeUserLine, parseImages, writeImageFiles, type DirectImage, type ImageFiles } from './images.js';
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
  type DirectPart,
  type McpServerCommand,
} from './commands.js';
import { findExecutable, findT3 } from './locate.js';
import { run, STOP_GRACE_MS, stopProcess, type RunResult, type Spawn } from './process.js';

const MAX_MESSAGE_CHARS = 100_000;
const MAX_SHOWN_CHARS = 20_000;
const MAX_MESSAGES = 50;
const MAX_ITEMS = 300;
const MAX_CONVERSATIONS = 30;
const T3_COMMAND_TIMEOUT_MS = 60_000;
// Every `t3` call signs in to T3 for a moment, so its state is checked at most once a minute unless asked.
const T3_STATUS_TTL_MS = 60_000;
const DIRECT_RUN_TIMEOUT_MS = 60 * 60_000;
const POLL_GIVE_UP_MS = 6 * 60 * 60_000;
const MAX_POLL_FAILURES = 5;
const MAX_WAITING_POLL_MS = 30_000;
const SHUTTING_DOWN = 'T3-Tab is shutting down.';
const CLAIM_HIDDEN = '[claim code hidden]';
const NAME = /^[^\s-][^\s]{0,199}$/;

export interface AgentsOptions {
  env: NodeJS.ProcessEnv;
  /** The `t3-tab mcp` command a direct run starts as its MCP server. */
  server: McpServerCommand;
  spawn?: Spawn;
  pollMs?: number;
  /** Where a direct turn's private claim file goes. Default: the daemon's state folder for `env`. */
  stateDir?: string;
  directTimeoutMs?: number;
  pollGiveUpMs?: number;
  graceMs?: number;
}

interface Conversation {
  view: AgentConversation;
  /** Every claim code issued for this conversation, kept out of everything the panel shows. */
  codes: Set<string>;
  /** The code the current direct turn's MCP server holds. */
  launchCode?: string;
  /** The private file holding that code, which names this conversation when its MCP server cannot read it. */
  claimFile?: string;
  cwd?: string;
  child?: ChildProcess;
  /** True while a direct turn is being set up, before it has a process. */
  starting?: boolean;
  /** True once the owner was told which Codex provider settings were left out. */
  providerWarned?: boolean;
  /** Why T3-Tab stopped the current direct turn. */
  stopReason?: string;
  /** True once the owner asked to stop the current direct turn. */
  userStopped?: boolean;
  /** Direct turns so far, which keeps item ids apart: Codex numbers its items again in every turn. */
  turns: number;
  poll?: ReturnType<typeof setTimeout>;
  /** The T3 run this conversation waits on; polling stops once the thread shows it finished. */
  expectedRun?: string;
  pollFailures: number;
  pollStarted: number;
  /** Polls in a row that found the run waiting on an answer; they back off. */
  waitingPolls: number;
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
  private readonly stateDir: string;
  private readonly directTimeoutMs: number;
  private readonly pollGiveUpMs: number;
  private readonly graceMs: number;
  /** The short `t3` commands running now, so shutdown can stop them. */
  private readonly commands = new Set<ChildProcess>();
  /** Direct turns being set up. Shutdown waits for them, so each has either refused to start or has a process to stop. */
  private readonly setups = new Set<Promise<void>>();
  private t3Cache: { at: number; value: AgentsStatus['t3'] } | undefined;
  private t3Probe: Promise<AgentsStatus['t3']> | undefined;
  private closed = false;

  constructor(private readonly options: AgentsOptions) {
    this.spawn = options.spawn ?? ((command, args, spawnOptions) => spawnProcess(command, args, spawnOptions));
    this.pollMs = options.pollMs ?? 3_000;
    this.stateDir = options.stateDir ?? stateDirectory(options.env);
    this.directTimeoutMs = options.directTimeoutMs ?? DIRECT_RUN_TIMEOUT_MS;
    this.pollGiveUpMs = options.pollGiveUpMs ?? POLL_GIVE_UP_MS;
    this.graceMs = options.graceMs ?? STOP_GRACE_MS;
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

  /** The conversations without their thread view, so a list stays small; `get` returns one with its items. */
  list(): AgentConversation[] {
    return [...this.conversations.values()]
      .map((conversation) => ({ ...conversation.view, items: [] }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  get(id: unknown): AgentConversation {
    return this.require(id).view;
  }

  /** Stops a direct run's current turn. The conversation goes back to idle and keeps what the agent had done. */
  async stop(id: unknown): Promise<AgentConversation> {
    const conversation = this.require(id);
    if (conversation.view.via === 't3') throw new Error('A T3 thread is stopped in T3 Code.');
    if (conversation.starting === true) throw new Error('The run is still starting. Try again in a moment.');
    const child = conversation.child;
    if (child === undefined) return conversation.view;
    conversation.userStopped = true;
    await stopProcess(child, this.graceMs);
    return conversation.view;
  }

  private require(id: unknown): Conversation {
    if (typeof id !== 'string') throw new Error('Invalid conversation id');
    const conversation = this.conversations.get(id);
    if (conversation === undefined) throw new Error('No such conversation. The background program may have restarted.');
    return conversation;
  }

  async start(value: unknown): Promise<AgentConversation> {
    const params = parseStartParams(value);
    if (params.via === 't3') return await this.startT3(params);
    return await this.startDirect(params);
  }

  /** `claim` is a fresh code the extension issued for this turn of a direct run. */
  async send(id: unknown, message: unknown, claim?: unknown, images?: unknown): Promise<AgentConversation> {
    const conversation = this.require(id);
    const text = parseMessage(message);
    const attached = parseImages(images);
    if (claim !== undefined && (typeof claim !== 'string' || !CLAIM_CODE.test(claim))) throw new Error('Invalid claim code');
    if (conversation.view.via === 't3') {
      if (attached.length > 0) throw new Error('Images go to a T3 thread through T3 Code, not here.');
      const threadId = conversation.view.threadId ?? '';
      const t3 = await this.requireT3();
      const result = await this.runT3(t3, t3SendArgs(threadId), text);
      if (this.closed) throw new Error(SHUTTING_DOWN);
      const sent = parseT3Launch(result.stdout);
      this.push(conversation, { role: 'user', text });
      conversation.view.status = 'running';
      delete conversation.view.error;
      this.watchT3(conversation, sent.runId);
      return conversation.view;
    }
    if (conversation.child !== undefined || conversation.starting === true) {
      throw new Error('The agent is still working on the last message.');
    }
    if (conversation.view.threadId === undefined) {
      throw new Error('This run printed no session id, so it cannot be continued. Start a new one.');
    }
    this.push(conversation, { role: 'user', text: withImageNames(text, attached) });
    this.pushItem(conversation, { kind: 'user', text: withImageNames(text, attached) });
    await this.runDirect(conversation, text, attached, conversation.view.threadId, claim);
    return conversation.view;
  }

  /** Stops every polling loop and process, and returns once the processes have closed. */
  async close(): Promise<void> {
    this.closed = true;
    await Promise.allSettled(this.setups);
    const stopping: Array<Promise<void>> = [...this.commands].map(async (child) => await stopProcess(child, this.graceMs));
    for (const conversation of this.conversations.values()) {
      if (conversation.poll !== undefined) {
        clearTimeout(conversation.poll);
        delete conversation.poll;
      }
      if (conversation.child === undefined) continue;
      conversation.stopReason = 'T3-Tab stopped while this run was working.';
      stopping.push(stopProcess(conversation.child, this.graceMs));
    }
    await Promise.all(stopping);
  }

  /** Tells the owner, in the conversation it was issued for, that its tabs could not be shared. */
  claimFailed(code: string, reason: string): void {
    for (const conversation of this.conversations.values()) {
      if (conversation.launchCode !== code) continue;
      this.push(conversation, {
        role: 'error',
        text: `T3-Tab could not share your tabs with this turn: ${reason} Share a tab from Threads in the side panel if the agent needs it.`,
      });
    }
  }

  /** Tells the owner, in the conversation whose turn it was, that its MCP server could not use the claim file. */
  claimFileFailed(path: string, problem: ClaimFileProblem): void {
    for (const conversation of this.conversations.values()) {
      if (conversation.claimFile !== path) continue;
      delete conversation.claimFile;
      this.push(conversation, { role: 'error', text: claimFileWarning(problem) });
    }
  }

  private async startT3(params: StartParams): Promise<AgentConversation> {
    if (params.project === undefined) throw new Error('Choose a T3 project: its id or a folder inside it.');
    if (params.images.length > 0) throw new Error('Images go to a T3 thread through T3 Code, not here.');
    if ((params.provider === undefined) !== (params.model === undefined)) {
      throw new Error('Give both a provider instance and a model, or neither for the project default.');
    }
    const t3 = await this.requireT3();
    const result = await this.runT3(
      t3,
      t3StartArgs({ project: params.project, provider: params.provider, model: params.model }),
      `${params.message}${claimNote(params.claim)}`,
    );
    if (this.closed) throw new Error(SHUTTING_DOWN);
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
    this.push(conversation, { role: 'user', text: withImageNames(params.message, params.images) });
    this.pushItem(conversation, { kind: 'user', text: withImageNames(params.message, params.images) });
    try {
      await this.runDirect(conversation, params.message, params.images, undefined, params.claim);
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
      title: firstLine(params.message.replaceAll(params.claim, CLAIM_HIDDEN)).slice(0, 80) || 'Untitled',
      status: 'running',
      messages: [],
      items: [],
      updatedAt: Date.now(),
    };
    if (extra.threadId !== undefined) view.threadId = extra.threadId;
    if (params.project !== undefined) view.project = params.project;
    if (params.provider !== undefined) view.provider = params.provider;
    if (params.model !== undefined) view.model = params.model;
    const conversation: Conversation = { view, codes: new Set([params.claim]), turns: 0, pollFailures: 0, pollStarted: Date.now(), waitingPolls: 0 };
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
    conversation.view.messages.push({ role: message.role, text: cap(hideCodes(message.text, conversation.codes)) });
    if (conversation.view.messages.length > MAX_MESSAGES) conversation.view.messages.splice(0, conversation.view.messages.length - MAX_MESSAGES);
    // A direct run's thread view shows the owner's messages and errors where they happened; the agent's own arrive as parts.
    if (message.role === 'error' && conversation.view.via !== 't3') this.pushItem(conversation, { kind: 'error', text: message.text });
    conversation.view.updatedAt = Date.now();
  }

  /** Adds an item to a direct run's thread view and returns it. */
  private pushItem(conversation: Conversation, item: ItemDraft, id?: string): TextItem {
    const text = cap(hideCodes(item.text, conversation.codes));
    const added: TextItem = { id: id ?? `${conversation.turns}:${randomUUID()}`, kind: item.kind, text, at: Date.now() };
    conversation.view.items.push(added);
    if (conversation.view.items.length > MAX_ITEMS) conversation.view.items.splice(0, conversation.view.items.length - MAX_ITEMS);
    conversation.view.updatedAt = Date.now();
    return added;
  }

  /** Applies what the agent's output line changed in the thread view. */
  private applyParts(conversation: Conversation, turn: Turn, parts: DirectPart[]): void {
    const { view, codes } = conversation;
    for (const part of parts) {
      if (part.op === 'text') {
        let item = turn.blocks.get(part.key);
        if (item === undefined) {
          item = this.pushItem(conversation, { kind: part.kind, text: '' }, `${conversation.turns}:${part.key}`);
          item.streaming = true;
          turn.blocks.set(part.key, item);
        }
        item.text = cap(hideCodes(part.final ? part.text : `${item.text}${part.text}`, codes));
        if (part.kind === 'assistant' && part.text.trim() !== '') turn.answered = true;
      } else if (part.op === 'end') {
        const item = turn.blocks.get(part.key);
        if (item === undefined) continue;
        delete item.streaming;
        turn.blocks.delete(part.key);
        // A reasoning block the CLI sent without its text, or an empty reply, leaves nothing to show.
        const at = view.items.indexOf(item);
        if (item.text.trim() === '' && at !== -1) view.items.splice(at, 1);
      } else if (part.op === 'tool') {
        let item = turn.tools.get(part.id);
        if (item === undefined) {
          item = { id: `${conversation.turns}:${part.id}`, kind: 'tool', name: part.name ?? 'tool', status: part.status ?? 'running' };
          view.items.push(item);
          if (view.items.length > MAX_ITEMS) view.items.splice(0, view.items.length - MAX_ITEMS);
          turn.tools.set(part.id, item);
        }
        if (part.name !== undefined) item.name = part.name;
        if (part.summary !== undefined) item.summary = cap(hideCodes(part.summary, codes));
        if (part.output !== undefined && part.output !== '') item.output = cap(hideCodes(part.output, codes));
        if (part.status !== undefined) item.status = part.status;
      } else {
        this.pushItem(conversation, { kind: 'error', text: part.text });
      }
    }
    view.updatedAt = Date.now();
  }

  /** The turn is over: whatever was still being written or run is not any more. */
  private settleItems(conversation: Conversation, turn: Turn, ok: boolean): void {
    for (const item of turn.blocks.values()) delete item.streaming;
    turn.blocks.clear();
    for (const item of turn.tools.values()) {
      if (item.status === 'running') item.status = ok ? 'done' : 'failed';
    }
    conversation.view.items = conversation.view.items.filter((item) => item.kind === 'tool' || item.text.trim() !== '');
  }

  private async t3Status(refresh: boolean): Promise<AgentsStatus['t3']> {
    if (!refresh && this.t3Cache !== undefined && Date.now() - this.t3Cache.at < T3_STATUS_TTL_MS) return this.t3Cache.value;
    // Each probe signs in to T3 for a moment, so overlapping panel refreshes share one.
    this.t3Probe ??= this.probeT3().finally(() => {
      this.t3Probe = undefined;
    });
    return await this.t3Probe;
  }

  private async probeT3(): Promise<AgentsStatus['t3']> {
    const path = await findT3(this.options.env);
    let value: AgentsStatus['t3'];
    if (path === undefined) value = { state: 'missing', detail: 'T3 Code was not found.' };
    else {
      try {
        const result = await this.runCommand(path, t3ProbeArgs(), undefined, 15_000);
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
    const result = await this.runCommand(path, args, input, T3_COMMAND_TIMEOUT_MS);
    if (result.code !== 0) {
      const state = t3FailureState(result.stderr);
      if (state === 'stopped') this.t3Cache = { at: Date.now(), value: { state, path, detail: firstLine(result.stderr) } };
      throw new Error(firstLine(result.stderr) || `t3 exited with code ${String(result.code)}`);
    }
    return result;
  }

  private async runCommand(path: string, args: string[], input: string | undefined, timeoutMs: number): Promise<RunResult> {
    // Checked right before the spawn, which registers the child in the same tick, so `close` cannot miss it.
    if (this.closed) throw new Error(SHUTTING_DOWN);
    let started: ChildProcess | undefined;
    try {
      return await run(this.spawn, path, args, {
        env: this.options.env,
        input,
        timeoutMs,
        graceMs: this.graceMs,
        onSpawn: (child) => {
          started = child;
          this.commands.add(child);
        },
      });
    } finally {
      if (started !== undefined) this.commands.delete(started);
    }
  }

  private watchT3(conversation: Conversation, runId: string | undefined): void {
    if (conversation.poll !== undefined) {
      clearTimeout(conversation.poll);
      delete conversation.poll;
    }
    if (this.closed) return;
    if (runId === undefined) delete conversation.expectedRun;
    else conversation.expectedRun = runId;
    conversation.pollFailures = 0;
    conversation.waitingPolls = 0;
    conversation.pollStarted = Date.now();
    conversation.poll = setTimeout(() => void this.pollT3(conversation), this.pollMs);
  }

  private async pollT3(conversation: Conversation): Promise<void> {
    delete conversation.poll;
    if (this.closed || !this.conversations.has(conversation.view.id)) return;
    let keepGoing = true;
    let delay = this.pollMs;
    try {
      const t3 = await this.requireT3();
      const result = await this.runT3(t3, t3ShowArgs(conversation.view.threadId ?? ''));
      const show = parseT3Show(result.stdout);
      conversation.pollFailures = 0;
      const { view, codes } = conversation;
      if (show.title !== undefined && show.title !== '') view.title = hideCodes(show.title, codes).slice(0, 80);
      if (show.messages.length > 0) {
        view.messages = show.messages.slice(-MAX_MESSAGES).map((message) => ({ ...message, text: cap(hideCodes(message.text, codes)) }));
      }
      const runSeen = conversation.expectedRun === undefined || show.latestRunId === undefined || show.latestRunId === conversation.expectedRun;
      // Right after a send the thread can still show its last run finished; it is running until the new run shows.
      view.status = !runSeen && show.status !== 'waiting' ? 'running' : show.status;
      view.updatedAt = Date.now();
      if (view.status === 'failed') {
        view.error = hideCodes(show.error ?? 'The run failed.', codes);
        this.push(conversation, { role: 'error', text: view.error });
      } else delete view.error;
      keepGoing = show.active || !runSeen;
      if (show.status === 'waiting') {
        // A run waiting on the owner can wait for hours; it is checked less often the longer it waits.
        delay = Math.min(this.pollMs * 2 ** conversation.waitingPolls, Math.max(this.pollMs, MAX_WAITING_POLL_MS));
        conversation.waitingPolls += 1;
      } else conversation.waitingPolls = 0;
    } catch (error) {
      if (this.closed) return;
      conversation.pollFailures += 1;
      if (conversation.pollFailures >= MAX_POLL_FAILURES) {
        this.failConversation(conversation, error instanceof Error ? error.message : String(error));
        keepGoing = false;
      }
    }
    if (!keepGoing || this.closed) return;
    if (Date.now() - conversation.pollStarted >= this.pollGiveUpMs) {
      const hours = Math.round(this.pollGiveUpMs / 3_600_000);
      this.failConversation(conversation, `T3-Tab stopped following this thread after ${hours} hours. It may still be running in T3 Code.`);
      return;
    }
    conversation.poll = setTimeout(() => void this.pollT3(conversation), delay);
  }

  private failConversation(conversation: Conversation, reason: string): void {
    const text = hideCodes(reason, conversation.codes);
    conversation.view.status = 'failed';
    conversation.view.error = text;
    conversation.view.updatedAt = Date.now();
    this.push(conversation, { role: 'error', text });
  }

  /** Starts one turn of a direct run and returns once the process is running; replies arrive as it prints them. */
  private async runDirect(conversation: Conversation, message: string, images: readonly DirectImage[], resume: string | undefined, claim: string | undefined): Promise<void> {
    const setup = this.startTurn(conversation, message, images, resume, claim);
    this.setups.add(setup);
    try {
      await setup;
    } finally {
      this.setups.delete(setup);
    }
  }

  private async startTurn(conversation: Conversation, message: string, images: readonly DirectImage[], resume: string | undefined, claim: string | undefined): Promise<void> {
    conversation.starting = true;
    let claimFile: ClaimFile | undefined;
    let imageFiles: ImageFiles | undefined;
    let child: ChildProcess;
    const via = conversation.view.via as Exclude<AgentVia, 't3'>;
    try {
      const executable = await findExecutable(via, this.options.env);
      if (executable === undefined) throw new Error(`${via === 'claude' ? 'Claude Code' : 'Codex'} was not found on this machine.`);
      const codexProvider = via === 'codex' ? await readCodexProvider(this.options.env) : undefined;
      if (codexProvider !== undefined && codexProvider.ignored.length > 0 && conversation.providerWarned !== true) {
        conversation.providerWarned = true;
        this.push(conversation, { role: 'error', text: `T3-Tab left out Codex provider settings it does not know: ${codexProvider.ignored.join(', ')}.` });
      }
      delete conversation.launchCode;
      delete conversation.claimFile;
      if (claim !== undefined) {
        conversation.codes.add(claim);
        conversation.launchCode = claim;
        claimFile = await writeClaimFile(this.stateDir, claim);
        conversation.claimFile = claimFile.path;
      }
      if (via === 'codex' && images.length > 0) imageFiles = await writeImageFiles(this.stateDir, images);
      const runOptions = {
        imageInput: via === 'claude' && images.length > 0,
        imageFiles: imageFiles?.paths,
        server: this.options.server,
        claimFile: claimFile?.path,
        env: this.options.env,
        model: conversation.view.model,
        resume,
        codexProvider,
      };
      const args = via === 'claude' ? claudeArgs(runOptions) : codexArgs(runOptions);
      if (this.closed) throw new Error(SHUTTING_DOWN);
      // Its own process group, so stopping it also stops whatever it started.
      child = this.spawn(executable, args, {
        cwd: conversation.cwd ?? homedir(),
        // A provider's credentials go to this process only; Codex starts MCP servers with a short list of variables.
        env: codexProvider === undefined ? this.options.env : { ...this.options.env, ...codexProvider.env },
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: true,
      });
    } catch (error) {
      await claimFile?.remove().catch(() => undefined);
      await imageFiles?.remove().catch(() => undefined);
      throw error;
    } finally {
      delete conversation.starting;
    }
    conversation.child = child;
    delete conversation.stopReason;
    delete conversation.userStopped;
    conversation.view.status = 'running';
    delete conversation.view.error;
    conversation.view.startedAt = Date.now();
    delete conversation.view.finishedAt;
    conversation.view.updatedAt = Date.now();
    conversation.turns += 1;
    const turn: Turn = { blocks: new Map(), tools: new Map(), answered: false };
    const parse = directParser(via);
    let reply: AgentMessage | undefined;
    let finished: { ok: boolean; error?: string; result?: string } | undefined;
    let lastError: string | undefined;
    let stderr = '';
    const timer = setTimeout(() => {
      conversation.stopReason = `The run timed out after ${Math.round(this.directTimeoutMs / 60_000)} minutes and was stopped.`;
      void stopProcess(child, this.graceMs);
    }, this.directTimeoutMs);
    if (child.stdout !== null) {
      createInterface({ input: child.stdout }).on('line', (line) => {
        const event = parse(line);
        if (event.sessionId !== undefined) conversation.view.threadId = event.sessionId;
        if (event.parts !== undefined) this.applyParts(conversation, turn, event.parts);
        if (event.text !== undefined && event.text.trim() !== '') {
          if (reply === undefined) {
            this.push(conversation, { role: 'assistant', text: event.text });
            reply = conversation.view.messages.at(-1);
          } else {
            reply.text = cap(`${reply.text}\n\n${hideCodes(event.text, conversation.codes)}`);
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
      void claimFile?.remove().catch(() => undefined);
      void imageFiles?.remove().catch(() => undefined);
      conversation.view.finishedAt = Date.now();
      if (conversation.userStopped === true && conversation.stopReason === undefined) {
        delete conversation.userStopped;
        this.settleItems(conversation, turn, false);
        this.push(conversation, { role: 'error', text: 'Stopped.' });
        conversation.view.status = 'idle';
        delete conversation.view.error;
        conversation.view.updatedAt = Date.now();
        return;
      }
      delete conversation.userStopped;
      if (conversation.stopReason !== undefined) {
        this.settleItems(conversation, turn, false);
        this.failConversation(conversation, conversation.stopReason);
        delete conversation.stopReason;
        return;
      }
      if (reply === undefined && finished?.ok === true && finished.result !== undefined && finished.result.trim() !== '') {
        this.push(conversation, { role: 'assistant', text: finished.result });
        if (!turn.answered) this.pushItem(conversation, { kind: 'assistant', text: finished.result });
      }
      const ok = finished?.ok ?? code === 0;
      this.settleItems(conversation, turn, ok && code === 0);
      if (ok && code === 0) {
        conversation.view.status = 'idle';
        conversation.view.updatedAt = Date.now();
      } else this.failConversation(conversation, finished?.error ?? lastError ?? (firstLine(stderr) || `${via} exited with code ${String(code)}`));
    });
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', () => resolve());
      child.once('error', (error) => {
        clearTimeout(timer);
        delete conversation.child;
        void claimFile?.remove().catch(() => undefined);
        void imageFiles?.remove().catch(() => undefined);
        conversation.view.status = 'failed';
        conversation.view.error = hideCodes(error.message, conversation.codes);
        conversation.view.finishedAt = Date.now();
        reject(error);
      });
    });
    child.stdin?.on('error', () => undefined);
    // With images, Claude Code reads one stream-json user message; otherwise the message is plain text.
    child.stdin?.end(via === 'claude' && images.length > 0 ? claudeUserLine(message, images) : message);
  }
}

type TextItem = Extract<AgentItem, { text: string }>;
type ToolItem = Extract<AgentItem, { kind: 'tool' }>;
type ItemDraft = { kind: TextItem['kind']; text: string };

/** What one direct turn has put in the thread view so far, by the agent's own names for the blocks and tool calls. */
interface Turn {
  blocks: Map<string, TextItem>;
  tools: Map<string, ToolItem>;
  /** True once the agent has written any reply text this turn. */
  answered: boolean;
}

interface StartParams {
  via: AgentVia;
  message: string;
  images: DirectImage[];
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
  if (typeof candidate.claim !== 'string' || !CLAIM_CODE.test(candidate.claim)) throw new Error('Invalid claim code');
  const params: StartParams = { via: candidate.via, message: parseMessage(candidate.message), images: parseImages(candidate.images), claim: candidate.claim };
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

/** The owner's message as the conversation shows it, naming the images that went with it. */
function withImageNames(text: string, images: readonly DirectImage[]): string {
  return images.length === 0 ? text : `${text}\n\n${images.map((image) => `[image: ${image.name}]`).join(' ')}`;
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

function hideCodes(text: string, codes: ReadonlySet<string>): string {
  let hidden = text;
  for (const code of codes) hidden = hidden.replaceAll(code, CLAIM_HIDDEN);
  return hidden;
}

function cap(text: string): string {
  return text.length <= MAX_SHOWN_CHARS ? text : `${text.slice(0, MAX_SHOWN_CHARS)}\n… (cut)`;
}
