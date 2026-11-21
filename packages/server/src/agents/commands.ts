import type { AgentMessage, AgentStatus, AgentVia, T3State } from '@t3-tab/protocol';

import { TOOL_TIMEOUT_MS } from '../client.js';

export const MCP_SERVER_NAME = 't3-tab';
const CLAIM_NOTE_MARK = '\n\n[T3-Tab] ';

export interface McpServerCommand {
  command: string;
  args: string[];
}

/**
 * The line added to a T3 thread's first message. A T3 thread's agent starts its MCP servers from its own
 * config, so nothing but the message can tell its session which tabs the owner picked.
 */
export function claimNote(code: string): string {
  return `${CLAIM_NOTE_MARK}The owner shared browser tabs with this thread. Before other browser tools, call the t3-tab \`tabs\` tool with {"claim": "${code}"}.`;
}

/** The message as the owner wrote it, without the claim note. */
export function withoutClaimNote(text: string): string {
  const index = text.indexOf(`${CLAIM_NOTE_MARK}The owner shared browser tabs`);
  return index === -1 ? text : text.slice(0, index);
}

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
  /** Why a run ended without completing. */
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
  if (status === 'failed') show.error = typeof value?.error === 'string' && value.error !== '' ? value.error : (failure as string);
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
    '--output-format',
    'stream-json',
    '--verbose',
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
 * name Codex no longer knows, so a renamed feature stops the run instead of quietly staying on.
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
 * T3-Tab's tools are pre-approved: with approval `never`, Codex would otherwise refuse them.
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
    `${server}.enabled=true`,
    `${server}.enabled_tools=[${T3_TAB_TOOLS.map(tomlString).join(', ')}]`,
    `${server}.disabled_tools=[]`,
    `${server}.default_tools_approval_mode="approve"`,
    `${server}.tool_timeout_sec=${CODEX_TOOL_TIMEOUT_SEC}`,
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
    ...(options.model === undefined ? [] : ['-m', options.model]),
    ...(options.resume === undefined ? [] : [options.resume]),
    '-',
  ];
}

/** What one line of a direct run's JSON output adds to the conversation. */
export interface DirectEvent {
  sessionId?: string;
  text?: string;
  /** Set on the line that ends the turn. */
  done?: { ok: boolean; error?: string; result?: string };
  error?: string;
}

/** One line of `claude -p --output-format stream-json`. */
export function parseClaudeLine(line: string): DirectEvent {
  const value = parseJsonObject(line);
  if (value === undefined) return {};
  const event: DirectEvent = {};
  if (typeof value.session_id === 'string') event.sessionId = value.session_id;
  if (value.type === 'assistant') {
    const content = (value.message as { content?: unknown } | undefined)?.content;
    const texts = Array.isArray(content)
      ? content.flatMap((block) =>
          typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'text' &&
          typeof (block as { text?: unknown }).text === 'string'
            ? [(block as { text: string }).text]
            : [],
        )
      : [];
    if (texts.length > 0) event.text = texts.join('\n');
  } else if (value.type === 'result') {
    const ok = value.is_error !== true && (value.subtype === undefined || value.subtype === 'success');
    const done: NonNullable<DirectEvent['done']> = { ok };
    if (typeof value.result === 'string') done.result = value.result;
    if (!ok) done.error = typeof value.result === 'string' && value.result !== '' ? value.result : String(value.subtype ?? 'error');
    event.done = done;
  }
  return event;
}

/** One line of `codex exec --json`. */
export function parseCodexLine(line: string): DirectEvent {
  const value = parseJsonObject(line);
  if (value === undefined) return {};
  if (value.type === 'thread.started' && typeof value.thread_id === 'string') return { sessionId: value.thread_id };
  if (value.type === 'item.completed') {
    const item = value.item as { type?: unknown; text?: unknown } | undefined;
    if (item?.type === 'agent_message' && typeof item.text === 'string') return { text: item.text };
    return {};
  }
  if (value.type === 'turn.completed') return { done: { ok: true } };
  if (value.type === 'turn.failed') {
    const message = (value.error as { message?: unknown } | undefined)?.message;
    return { done: { ok: false, error: typeof message === 'string' ? message : 'The turn failed' } };
  }
  if (value.type === 'error' && typeof value.message === 'string') return { error: value.message };
  return {};
}

export function directParser(via: Exclude<AgentVia, 't3'>): (line: string) => DirectEvent {
  return via === 'claude' ? parseClaudeLine : parseCodexLine;
}

function parseJsonObject(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text.trim());
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}
