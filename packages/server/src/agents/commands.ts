import { claimNote, withoutClaimNote, type AgentMessage, type AgentStatus, type AgentVia, type T3State } from '@t3-tab/protocol';

import { TOOL_TIMEOUT_MS } from '../client.js';
import { tomlString } from '../toml.js';
import { tomlValue, type CodexProvider } from './codex-provider.js';

const MCP_SERVER_NAME = 't3-tab';

export interface McpServerCommand {
  command: string;
  args: string[];
}

// The claim note is shared with the panel, which adds it to the threads it starts itself.
export { claimNote, withoutClaimNote };

export function t3StartArgs(options: { project: string; provider?: string | undefined; model?: string | undefined }): string[] {
  const selection =
    options.provider !== undefined && options.model !== undefined ? ['--provider', options.provider, '--model', options.model] : [];
  // The message goes on stdin (`-`), so nothing in it can be read as a flag.
  return ['thread', 'start', '--json', ...selection, options.project, '-'];
}

export function t3SendArgs(threadId: string): string[] {
  return ['thread', 'send', '--json', threadId, '-'];
}

export function t3ShowArgs(threadId: string): string[] {
  return ['thread', 'show', '--json', '--messages', '20', threadId];
}

/**
 * `t3 thread list` for a folder that is not a project: a running server answers that no project matches, a
 * stopped one that it is not running. It is the cheapest `t3` call that reaches the server.
 */
export function t3ProbeArgs(): string[] {
  return ['thread', 'list', '--json', '--project', '/'];
}

/** What a failed `t3` command's stderr says about the server. */
export function t3FailureState(stderr: string): T3State {
  if (/No running T3 Code server|Could not reach the T3 Code server/.test(stderr)) return 'stopped';
  if (/No T3 Code project matches/.test(stderr)) return 'running';
  return 'error';
}

export function firstLine(text: string): string {
  return (
    text
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line !== '') ?? ''
  ).slice(0, 300);
}

export interface T3Launch {
  threadId: string;
  runId?: string;
}

export function parseT3Launch(stdout: string): T3Launch {
  const value = parseJsonObject(stdout);
  const threadId = value?.threadId;
  if (typeof threadId !== 'string' || threadId === '') throw new Error('t3 did not print a thread id');
  const runId = value?.runId;
  return typeof runId === 'string' ? { threadId, runId } : { threadId };
}

export interface T3Show {
  title?: string;
  status: AgentStatus;
  /** True until the run reaches a terminal status and nothing waits on an answer. */
  active: boolean;
  latestRunId?: string;
  messages: AgentMessage[];
  /** What happened to a run that ended without completing. `t3 thread show --json` prints no failure text. */
  error?: string;
}

// T3 Code's thread statuses (`OrchestratorMcpThreadStatus`). A status not listed here is not terminal, so it is followed.
const COMPLETED_RUN = new Set(['idle', 'completed']);
const FAILED_RUN = new Map([
  ['failed', 'The run failed.'],
  ['interrupted', 'The run was interrupted.'],
  ['cancelled', 'The run was cancelled.'],
  ['rolled_back', 'The run was rolled back.'],
]);

export function parseT3Show(stdout: string): T3Show {
  const value = parseJsonObject(stdout);
  const thread = value?.thread;
  if (typeof thread !== 'object' || thread === null) throw new Error('t3 thread show printed no thread');
  const detail = thread as Record<string, unknown>;
  const runStatus = typeof detail.status === 'string' ? detail.status : 'idle';
  const pending = typeof detail.pendingRequestCount === 'number' ? detail.pendingRequestCount : 0;
  const failure = FAILED_RUN.get(runStatus);
  const terminal = COMPLETED_RUN.has(runStatus) || failure !== undefined;
  const waiting = runStatus === 'waiting' || pending > 0;
  const active = !terminal || waiting;
  const status: AgentStatus = waiting ? 'waiting' : failure !== undefined ? 'failed' : terminal ? 'idle' : 'running';
  const messages: AgentMessage[] = [];
  for (const entry of Array.isArray(value?.messages) ? value.messages : []) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { role, text } = entry as Record<string, unknown>;
    if (typeof text !== 'string') continue;
    messages.push({ role: role === 'user' ? 'user' : 'assistant', text: role === 'user' ? withoutClaimNote(text) : text });
  }
  const show: T3Show = { status, active, messages };
  if (typeof detail.title === 'string') show.title = detail.title;
  if (typeof detail.latestRunId === 'string') show.latestRunId = detail.latestRunId;
  if (failure !== undefined && status === 'failed') show.error = failure;
  return show;
}

/** The state folder the MCP server's daemon uses. Codex starts MCP servers with a short list of variables. */
function serverEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return env.XDG_STATE_HOME === undefined || env.XDG_STATE_HOME === '' ? {} : { XDG_STATE_HOME: env.XDG_STATE_HOME };
}

function serverArgs(options: DirectRunOptions): string[] {
  return options.claimFile === undefined ? options.server.args : [...options.server.args, '--claim-file', options.claimFile];
}

export interface DirectRunOptions {
  server: McpServerCommand;
  /** A private file holding this turn's claim code; the code itself never goes on a command line. */
  claimFile?: string | undefined;
  env: NodeJS.ProcessEnv;
  model?: string | undefined;
  /** The CLI's session id to continue. */
  resume?: string | undefined;
  /** Claude Code: the message and its images go on stdin as one stream-json user message. */
  imageInput?: boolean | undefined;
  /** Codex: private files holding this turn's images. */
  imageFiles?: readonly string[] | undefined;
  /** Codex only: the owner's active custom provider, the one thing carried over from their config. */
  codexProvider?: CodexProvider | undefined;
}

/**
 * `claude -p` reading the message from stdin, limited to the T3-Tab server: no user, project or local settings or
 * hooks (`--restricted`, `--setting-sources ""`), no other MCP server (`--strict-mcp-config`), no built-in tools
 * (`--tools ""`), no custom commands, and anything not allowed is denied instead of prompting (`dontAsk`).
 */
export function claudeArgs(options: DirectRunOptions): string[] {
  const config = {
    mcpServers: {
      [MCP_SERVER_NAME]: {
        type: 'stdio',
        command: options.server.command,
        args: serverArgs(options),
        env: serverEnv(options.env),
      },
    },
  };
  return [
    '-p',
    ...(options.imageInput === true ? ['--input-format', 'stream-json'] : []),
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--restricted',
    '--setting-sources',
    '',
    '--strict-mcp-config',
    '--mcp-config',
    JSON.stringify(config),
    '--tools',
    '',
    '--allowedTools',
    `mcp__${MCP_SERVER_NAME}`,
    '--permission-mode',
    'dontAsk',
    '--disable-slash-commands',
    ...(options.model === undefined ? [] : ['--model', options.model]),
    ...(options.resume === undefined ? [] : ['--resume', options.resume]),
  ];
}

/**
 * Codex features that run commands, reach other services or load the owner's extensions. `--disable` refuses a
 * name Codex no longer knows, so a renamed feature stops the run instead of quietly staying on. Codex 0.166.0 keeps
 * `unified_exec` on whatever this says; `shell_tool` is what removes its shell tools.
 */
const CODEX_DISABLED_FEATURES = [
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
const T3_TAB_TOOLS = ['status', 'tabs', 'read', 'screenshot', 'act', 'run_js'];
// Longer than T3-Tab's own wait, so its error arrives first. Codex's default is 60 seconds.
const CODEX_TOOL_TIMEOUT_SEC = Math.ceil(TOOL_TIMEOUT_MS / 1_000) + 20;

/**
 * `codex exec --json` (or `exec resume`) reading the message from stdin, limited to the T3-Tab server.
 * `--ignore-user-config` drops `$CODEX_HOME/config.toml` but keeps the login there, and leaves a project's
 * `.codex/config.toml` untrusted, so it is not applied either. Every field of the server entry that could
 * change what it does is set here, so an entry in a system-level config cannot redirect or narrow it.
 * T3-Tab's tools are pre-approved: with approval `never`, Codex would otherwise refuse them. An owner's custom
 * model provider is added back on its own (`codex-provider.ts`), with its credentials kept off this command line.
 */
export function codexArgs(options: DirectRunOptions): string[] {
  const env = Object.entries(serverEnv(options.env))
    .map(([key, value]) => `${key} = ${tomlString(value)}`)
    .join(', ');
  const server = `mcp_servers.${MCP_SERVER_NAME}`;
  const config = [
    'approval_policy="never"',
    'sandbox_mode="read-only"',
    'web_search="disabled"',
    `${server}.command=${tomlString(options.server.command)}`,
    `${server}.args=[${serverArgs(options).map(tomlString).join(', ')}]`,
    `${server}.env={ ${env} }`,
    `${server}.env_vars=[]`,
    `${server}.enabled=true`,
    `${server}.enabled_tools=[${T3_TAB_TOOLS.map(tomlString).join(', ')}]`,
    `${server}.disabled_tools=[]`,
    `${server}.default_tools_approval_mode="approve"`,
    `${server}.tool_timeout_sec=${CODEX_TOOL_TIMEOUT_SEC}`,
    ...(options.codexProvider?.settings ?? []),
    ...(options.model === undefined && options.codexProvider?.model !== undefined ? [`model=${tomlValue(options.codexProvider.model) as string}`] : []),
  ].flatMap((setting) => ['-c', setting]);
  return [
    'exec',
    ...(options.resume === undefined ? [] : ['resume']),
    '--json',
    '--skip-git-repo-check',
    '--ignore-user-config',
    '--ignore-rules',
    ...CODEX_DISABLED_FEATURES.flatMap((feature) => ['--disable', feature]),
    ...config,
    // `--image` takes several values, so each is joined to its flag: a bare one would take the session id and `-` too.
    ...(options.imageFiles ?? []).map((path) => `--image=${path}`),
    ...(options.model === undefined ? [] : ['-m', options.model]),
    ...(options.resume === undefined ? [] : [options.resume]),
    '-',
  ];
}

/** What one line of a direct run's JSON output adds to the conversation. */
export interface DirectEvent {
  sessionId?: string;
  text?: string;
  /** Changes to the thread view's items, in the order they happened. */
  parts?: DirectPart[];
  /** Set on the line that ends the turn. */
  done?: { ok: boolean; error?: string; result?: string };
  error?: string;
}

/**
 * One change to the thread view. `key` names a streamed block; `text` with `final: false` is appended to it and with
 * `final: true` replaces it. A `tool` part updates the tool call with that id, creating it on its first mention.
 */
export type DirectPart =
  | { op: 'text'; key: string; kind: 'assistant' | 'reasoning'; text: string; final: boolean }
  | { op: 'end'; key: string }
  | { op: 'tool'; id: string; name?: string; summary?: string; output?: string; status?: 'running' | 'done' | 'failed' }
  | { op: 'error'; key: string; text: string };

const MAX_SUMMARY_CHARS = 200;

function short(text: string): string {
  return text.length <= MAX_SUMMARY_CHARS ? text : `${text.slice(0, MAX_SUMMARY_CHARS)}…`;
}

/** An agent's tool arguments in one short line; nothing for an empty object. */
function summarize(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'object' && Object.keys(value).length === 0) return undefined;
  try {
    return short(typeof value === 'string' ? value : JSON.stringify(value));
  } catch {
    return undefined;
  }
}

/** The text of a tool result's content: a string, or blocks whose text is joined and whose images are named. */
function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .flatMap((block) => {
      if (typeof block !== 'object' || block === null) return [];
      const { type, text } = block as { type?: unknown; text?: unknown };
      if (type === 'text' && typeof text === 'string') return [text];
      return type === 'image' ? ['[image]'] : [];
    })
    .join('\n');
}

/** `mcp__t3-tab__read` is shown as `read`. */
function toolName(name: string): string {
  return name.replace(/^mcp__.+?__/, '') || name;
}

/** What `claude -p --output-format stream-json --include-partial-messages` has said about the message being written. */
export interface ClaudeStreamState {
  messageId?: string | undefined;
  /** Blocks streamed in the current message and not yet completed by a full `assistant` line, in order. */
  open: Array<{ index: number; type: string }>;
}

export function newClaudeState(): ClaudeStreamState {
  return { open: [] };
}

/** One line of `claude -p --output-format stream-json`. */
export function parseClaudeLine(line: string, state: ClaudeStreamState = newClaudeState()): DirectEvent {
  const value = parseJsonObject(line);
  if (value === undefined) return {};
  const event: DirectEvent = {};
  if (typeof value.session_id === 'string') event.sessionId = value.session_id;
  if (value.type === 'stream_event') {
    const parts = claudeStreamParts(value.event, state);
    if (parts.length > 0) event.parts = parts;
  } else if (value.type === 'assistant') {
    const message = value.message as { id?: unknown; content?: unknown } | undefined;
    const content = Array.isArray(message?.content) ? (message.content as unknown[]) : [];
    const texts: string[] = [];
    const parts: DirectPart[] = [];
    const messageId = typeof message?.id === 'string' ? message.id : state.messageId ?? 'message';
    let unstreamed = 0;
    for (const block of content) {
      if (typeof block !== 'object' || block === null) continue;
      const { type, text, thinking, id, name, input } = block as Record<string, unknown>;
      if (type === 'text' && typeof text === 'string') texts.push(text);
      if (type === 'text' || type === 'thinking') {
        const body = type === 'text' ? text : thinking;
        if (typeof body !== 'string') continue;
        const at = state.open.findIndex((open) => open.type === type);
        const index = at === -1 ? undefined : state.open.splice(at, 1)[0]?.index;
        const key = `${messageId}:${index ?? `x${unstreamed++}`}`;
        parts.push({ op: 'text', key, kind: type === 'text' ? 'assistant' : 'reasoning', text: body, final: true }, { op: 'end', key });
      } else if (type === 'tool_use' && typeof id === 'string' && typeof name === 'string') {
        const at = state.open.findIndex((open) => open.type === 'tool_use');
        if (at !== -1) state.open.splice(at, 1);
        const summary = summarize(input);
        parts.push({ op: 'tool', id, name: toolName(name), ...(summary === undefined ? {} : { summary }), status: 'running' });
      }
    }
    if (texts.length > 0) event.text = texts.join('\n');
    if (parts.length > 0) event.parts = parts;
  } else if (value.type === 'user') {
    const content = (value.message as { content?: unknown } | undefined)?.content;
    const parts: DirectPart[] = [];
    for (const block of Array.isArray(content) ? (content as unknown[]) : []) {
      if (typeof block !== 'object' || block === null) continue;
      const { type, tool_use_id: id, content: result, is_error: failed } = block as Record<string, unknown>;
      if (type !== 'tool_result' || typeof id !== 'string') continue;
      parts.push({ op: 'tool', id, output: resultText(result), status: failed === true ? 'failed' : 'done' });
    }
    if (parts.length > 0) event.parts = parts;
  } else if (value.type === 'result') {
    const ok = value.is_error !== true && (value.subtype === undefined || value.subtype === 'success');
    const done: NonNullable<DirectEvent['done']> = { ok };
    if (typeof value.result === 'string') done.result = value.result;
    if (!ok) done.error = typeof value.result === 'string' && value.result !== '' ? value.result : String(value.subtype ?? 'error');
    event.done = done;
  }
  return event;
}

function claudeStreamParts(raw: unknown, state: ClaudeStreamState): DirectPart[] {
  if (typeof raw !== 'object' || raw === null) return [];
  const event = raw as Record<string, unknown>;
  if (event.type === 'message_start') {
    const id = (event.message as { id?: unknown } | undefined)?.id;
    state.messageId = typeof id === 'string' ? id : undefined;
    state.open = [];
    return [];
  }
  const index = typeof event.index === 'number' ? event.index : undefined;
  if (index === undefined) return [];
  const key = `${state.messageId ?? 'message'}:${index}`;
  if (event.type === 'content_block_start') {
    const block = event.content_block as Record<string, unknown> | undefined;
    const type = typeof block?.type === 'string' ? block.type : '';
    if (type === 'text' || type === 'thinking' || type === 'tool_use') state.open.push({ index, type });
    if (type === 'text' || type === 'thinking') {
      return [{ op: 'text', key, kind: type === 'text' ? 'assistant' : 'reasoning', text: '', final: false }];
    }
    if (type === 'tool_use' && typeof block?.id === 'string' && typeof block.name === 'string') {
      return [{ op: 'tool', id: block.id, name: toolName(block.name), status: 'running' }];
    }
    return [];
  }
  if (event.type === 'content_block_delta') {
    const delta = event.delta as Record<string, unknown> | undefined;
    if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
      return [{ op: 'text', key, kind: 'assistant', text: delta.text, final: false }];
    }
    if (delta?.type === 'thinking_delta' && typeof delta.thinking === 'string') {
      return [{ op: 'text', key, kind: 'reasoning', text: delta.thinking, final: false }];
    }
    return [];
  }
  if (event.type === 'content_block_stop') {
    state.open = state.open.filter((open) => open.index !== index);
    return [{ op: 'end', key }];
  }
  return [];
}

/** One line of `codex exec --json`. */
export function parseCodexLine(line: string): DirectEvent {
  const value = parseJsonObject(line);
  if (value === undefined) return {};
  if (value.type === 'thread.started' && typeof value.thread_id === 'string') return { sessionId: value.thread_id };
  if (value.type === 'item.started' || value.type === 'item.updated' || value.type === 'item.completed') {
    return codexItemEvent(value.item, value.type === 'item.completed');
  }
  if (value.type === 'turn.completed') return { done: { ok: true } };
  if (value.type === 'turn.failed') {
    const message = (value.error as { message?: unknown } | undefined)?.message;
    return { done: { ok: false, error: typeof message === 'string' ? message : 'The turn failed' } };
  }
  if (value.type === 'error' && typeof value.message === 'string') return { error: value.message };
  return {};
}

const CODEX_STATUS = new Map<string, 'running' | 'done' | 'failed'>([
  ['in_progress', 'running'],
  ['completed', 'done'],
  ['failed', 'failed'],
]);

function codexItemEvent(raw: unknown, completed: boolean): DirectEvent {
  if (typeof raw !== 'object' || raw === null) return {};
  const item = raw as Record<string, unknown>;
  const id = typeof item.id === 'string' ? item.id : undefined;
  const type = typeof item.type === 'string' ? item.type : '';
  const text = typeof item.text === 'string' ? item.text : undefined;
  if (type === 'agent_message' || type === 'reasoning') {
    if (text === undefined) return {};
    const key = id ?? type;
    const kind = type === 'agent_message' ? 'assistant' : 'reasoning';
    const parts: DirectPart[] = [{ op: 'text', key, kind, text, final: true }, ...(completed ? [{ op: 'end' as const, key }] : [])];
    return { ...(completed && type === 'agent_message' ? { text } : {}), parts };
  }
  if (type === 'error') {
    return typeof item.message === 'string' && completed ? { parts: [{ op: 'error', key: id ?? 'error', text: item.message }] } : {};
  }
  if (id === undefined || type === '') return {};
  const status = CODEX_STATUS.get(String(item.status)) ?? (completed ? 'done' : 'running');
  let part: Extract<DirectPart, { op: 'tool' }>;
  if (type === 'command_execution') {
    part = { op: 'tool', id, name: 'command', status };
    if (typeof item.command === 'string') part.summary = short(item.command);
    if (typeof item.aggregated_output === 'string') part.output = item.aggregated_output;
  } else if (type === 'mcp_tool_call') {
    part = { op: 'tool', id, name: typeof item.tool === 'string' ? item.tool : 'tool', status };
    const summary = summarize(item.arguments);
    if (summary !== undefined) part.summary = summary;
    const error = (item.error as { message?: unknown } | null | undefined)?.message;
    const output = typeof error === 'string' ? error : resultText((item.result as { content?: unknown } | null | undefined)?.content);
    if (output !== '') part.output = output;
  } else if (type === 'file_change') {
    part = { op: 'tool', id, name: 'file change', status };
    const paths = Array.isArray(item.changes)
      ? (item.changes as unknown[]).flatMap((change) => (typeof (change as { path?: unknown })?.path === 'string' ? [(change as { path: string }).path] : []))
      : [];
    if (paths.length > 0) part.summary = short(paths.join(', '));
  } else if (type === 'web_search') {
    part = { op: 'tool', id, name: 'web search', status };
    if (typeof item.query === 'string') part.summary = short(item.query);
  } else if (type === 'todo_list') {
    part = { op: 'tool', id, name: 'plan', status: completed ? 'done' : 'running' };
    const entries = Array.isArray(item.items) ? (item.items as unknown[]) : [];
    const lines = entries.flatMap((entry) => {
      const { text: step, completed: finished } = (entry ?? {}) as { text?: unknown; completed?: unknown };
      return typeof step === 'string' ? [`${finished === true ? '[x]' : '[ ]'} ${step}`] : [];
    });
    if (lines.length > 0) part.output = lines.join('\n');
  } else {
    part = { op: 'tool', id, name: type, status };
  }
  return { parts: [part] };
}

export function directParser(via: Exclude<AgentVia, 't3'>): (line: string) => DirectEvent {
  if (via === 'codex') return parseCodexLine;
  const state = newClaudeState();
  return (line) => parseClaudeLine(line, state);
}

function parseJsonObject(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text.trim());
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}
