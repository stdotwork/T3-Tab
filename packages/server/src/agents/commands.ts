import type { AgentMessage, AgentStatus, AgentVia, T3State } from '@t3-tab/protocol';

/** The variable a direct run's MCP server is started with, so its session claims the owner's tabs. */
export const CLAIM_ENV = 'T3_TAB_CLAIM';
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
  /** True while a run is preparing, queued, starting or running. */
  active: boolean;
  latestRunId?: string;
  messages: AgentMessage[];
}

const ACTIVE_RUN = new Set(['preparing', 'queued', 'starting', 'running']);
const FAILED_RUN = new Set(['failed']);

export function parseT3Show(stdout: string): T3Show {
  const value = parseJsonObject(stdout);
  const thread = value?.thread;
  if (typeof thread !== 'object' || thread === null) throw new Error('t3 thread show printed no thread');
  const detail = thread as Record<string, unknown>;
  const runStatus = typeof detail.status === 'string' ? detail.status : 'idle';
  const pending = typeof detail.pendingRequestCount === 'number' ? detail.pendingRequestCount : 0;
  const active = ACTIVE_RUN.has(runStatus);
  const status: AgentStatus =
    runStatus === 'waiting' || pending > 0 ? 'waiting' : active ? 'running' : FAILED_RUN.has(runStatus) ? 'failed' : 'idle';
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
  return show;
}

/** The MCP server a direct run starts, with the claim code and the state folder its daemon uses. */
function serverEnv(claim: string, env: NodeJS.ProcessEnv): Record<string, string> {
  const serverEnvironment: Record<string, string> = { [CLAIM_ENV]: claim };
  // Codex starts MCP servers with a short list of variables, so the daemon's state folder is passed on.
  if (env.XDG_STATE_HOME !== undefined && env.XDG_STATE_HOME !== '') serverEnvironment.XDG_STATE_HOME = env.XDG_STATE_HOME;
  return serverEnvironment;
}

export interface DirectRunOptions {
  server: McpServerCommand;
  claim: string;
  env: NodeJS.ProcessEnv;
  model?: string | undefined;
  /** The CLI's session id to continue. */
  resume?: string | undefined;
}

/**
 * `claude -p` reading the message from stdin, with only the T3-Tab server (`--strict-mcp-config`, so a user-level
 * `t3-tab` entry does not start a second session) and only its tools allowed beyond Claude Code's read-only ones.
 */
export function claudeArgs(options: DirectRunOptions): string[] {
  const config = {
    mcpServers: {
      [MCP_SERVER_NAME]: {
        type: 'stdio',
        command: options.server.command,
        args: options.server.args,
        env: serverEnv(options.claim, options.env),
      },
    },
  };
  return [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--strict-mcp-config',
    '--mcp-config',
    JSON.stringify(config),
    '--allowedTools',
    `mcp__${MCP_SERVER_NAME}`,
    ...(options.model === undefined ? [] : ['--model', options.model]),
    ...(options.resume === undefined ? [] : ['--resume', options.resume]),
  ];
}

/**
 * `codex exec --json` (or `exec resume`) reading the message from stdin, in a read-only sandbox, with the T3-Tab
 * server set through `-c` so it replaces a user-level `t3-tab` entry rather than adding a second one.
 */
export function codexArgs(options: DirectRunOptions): string[] {
  const env = Object.entries(serverEnv(options.claim, options.env))
    .map(([key, value]) => `${key} = ${tomlString(value)}`)
    .join(', ');
  const config = [
    'sandbox_mode="read-only"',
    `mcp_servers.${MCP_SERVER_NAME}.command=${tomlString(options.server.command)}`,
    `mcp_servers.${MCP_SERVER_NAME}.args=[${options.server.args.map(tomlString).join(', ')}]`,
    `mcp_servers.${MCP_SERVER_NAME}.env={ ${env} }`,
  ].flatMap((setting) => ['-c', setting]);
  return [
    'exec',
    ...(options.resume === undefined ? [] : ['resume']),
    '--json',
    '--skip-git-repo-check',
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
