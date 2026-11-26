/**
 * The one thread view the panel draws. A T3 thread and a direct Claude Code or Codex run both become this, so they
 * look and behave the same; only who started the thread differs.
 */
import type { AgentConversation, AgentItem } from '@t3-tab/protocol';
import { withoutClaimNote } from '@t3-tab/protocol';

export type WorkIcon = 'thinking' | 'read' | 'edit' | 'command' | 'search' | 'web' | 'tool' | 'browser' | 'ask' | 'approval' | 'agent' | 'plan' | 'note';

export interface WorkEntry {
  id: string;
  icon: WorkIcon;
  label: string;
  detail?: string;
  status: 'running' | 'done' | 'failed' | 'waiting';
}

export type Row =
  | { kind: 'user'; id: string; text: string; at?: number }
  | { kind: 'work'; id: string; running: boolean; startedAt?: number; endedAt?: number; entries: WorkEntry[] }
  | { kind: 'assistant'; id: string; text: string; streaming: boolean; at?: number }
  | { kind: 'notice'; id: string; text: string; tone: 'error' | 'info' };

export interface ApprovalOption {
  decision: string;
  label: string;
  /** T3's caution for an answer, shown on it as T3 shows it. */
  warning?: string;
}

/** What T3's own client offers when an approval names no options (`DEFAULT_APPROVAL_OPTIONS` in T3's web app). */
export const T3_DEFAULT_APPROVAL_OPTIONS: readonly ApprovalOption[] = [
  { decision: 'cancel', label: 'Cancel' },
  { decision: 'decline', label: 'Decline' },
  { decision: 'acceptForSession', label: 'Always allow this session' },
  { decision: 'accept', label: 'Approve' },
];

export interface PendingApproval {
  requestId: string;
  /** The work-log entry that stands for this request while it waits, where the card is drawn in T3's place for it. */
  entryId?: string;
  kind: string;
  title: string;
  detail?: string;
  options: ApprovalOption[];
}

export interface QuestionOption {
  label: string;
  description: string;
  value?: string;
}

export interface Question {
  id: string;
  header: string;
  question: string;
  options: QuestionOption[];
  multiSelect?: boolean;
  allowCustomAnswer?: boolean;
}

export interface PendingQuestion {
  requestId: string;
  questions: Question[];
}

/** A follow-up T3 holds until the current run ends. `held`: T3 will not start it by itself (the run was stopped). */
export interface QueuedMessage {
  runId: string;
  text: string;
  held: boolean;
}

export interface ThreadView {
  id: string;
  source: 't3' | 'direct';
  title: string;
  running: boolean;
  failed: boolean;
  rows: Row[];
  queued: QueuedMessage[];
  approval?: PendingApproval;
  question?: PendingQuestion;
  activeRunId?: string;
  runtimeMode?: string;
  provider?: string;
  model?: string;
  modelOptions?: Record<string, string | boolean>;
  projectId?: string;
}

const BROWSER_TOOL_NAMES = new Set(['status', 'tabs', 'read', 'screenshot', 'act', 'run_js']);

/** `mcp__t3-tab__read` and `t3-tab.read` both name T3-Tab's own browser tools. A direct run's parser leaves the bare name. */
export function browserToolName(name: string): string | undefined {
  const tool = /^(?:mcp__t3-tab__|t3-tab[.:/])([a-z_]+)$/.exec(name)?.[1] ?? name;
  return BROWSER_TOOL_NAMES.has(tool) ? tool : undefined;
}

const hostOf = (url: unknown): string | undefined => {
  if (typeof url !== 'string') return undefined;
  try {
    return new URL(url).host || undefined;
  } catch {
    return undefined;
  }
};

/** The site a tool reply is about: every reply about a tab has `<title> — <address>` on its first line. */
const hostInReply = (output: string | undefined): string | undefined => hostOf(output?.split('\n', 1)[0]?.split(' — ').at(-1)?.trim());

const ACT_WORDS: Record<string, string> = { click: 'Clicked', type: 'Typed', fill: 'Filled a field', select: 'Chose an option', scroll: 'Scrolled', hover: 'Hovered', wait: 'Waited' };

function actWords(steps: unknown): string {
  if (!Array.isArray(steps) || steps.length === 0) return 'Acted';
  const words: string[] = [];
  for (const step of steps as Array<{ action?: unknown; key?: unknown }>) {
    // What was typed stays out of the label: it can be a password.
    const word = step.action === 'press' ? (typeof step.key === 'string' ? `Pressed ${step.key.slice(0, 20)}` : 'Pressed a key') : ACT_WORDS[String(step.action)];
    if (word !== undefined && !words.includes(word)) words.push(word);
  }
  if (words.length === 0) return 'Acted';
  const shown = words.slice(0, 3).map((word, index) => (index === 0 ? word : word[0]?.toLowerCase() + word.slice(1)));
  return words.length > 3 ? `${shown.join(', ')} and more` : shown.join(', ');
}

/** One browser step in words, naming the site and what was done, from the tool's arguments and its reply. */
export function browserStepLabel(tool: string, input: unknown, output?: string): string {
  const args = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>;
  const site = hostInReply(output);
  const page = site ?? 'the page';
  switch (tool) {
    case 'status':
      return 'Checked the browser';
    case 'tabs': {
      if (args.claim !== undefined) return 'Took the shared tabs';
      if (args.action === 'open') return `Opened ${hostOf(args.url) ?? site ?? 'a tab'}`;
      if (args.action === 'switch') return `Switched to ${site ?? (args.tab === undefined ? 'a tab' : `tab ${String(args.tab)}`)}`;
      if (args.action === 'close') return args.tab === undefined ? 'Closed a tab' : `Closed tab ${String(args.tab)}`;
      return 'Listed tabs';
    }
    case 'read':
      if (typeof args.find === 'string') return `Searched ${page} for "${oneLine(args.find, 60)}"`;
      return args.ref === undefined ? `Read ${page}` : `Read part of ${page}`;
    case 'screenshot':
      return `Took a screenshot of ${page}`;
    case 'act':
      return `${actWords(args.steps)} on ${page}`;
    default:
      return `Ran JavaScript on ${page}`;
  }
}

/** A direct run carries a tool's arguments as one short line of JSON, cut off when long. */
const parseSummary = (summary: string | undefined): unknown => {
  if (summary === undefined) return undefined;
  try {
    return JSON.parse(summary);
  } catch {
    return undefined;
  }
};

const oneLine = (text: string, max = 140): string => {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

const CLAIM_HIDDEN = '[claim code hidden]';

/** A claim code never reaches the screen, wherever a provider echoes it: tool input, approvals, reasoning or a reply. */
export function hideClaimCodes(text: string): string {
  return text
    .replace(/("?claim"?\s*[:=]\s*\\?")[^"\\\s]+/gi, `$1${CLAIM_HIDDEN}`)
    .replace(/(call the t3-tab `tabs` tool with )\{[^}]*\}/g, `$1{…}`);
}

/** The codes this thread's own messages carry, so a provider repeating one bare is caught too. */
function claimCodesIn(texts: Iterable<string>): Set<string> {
  const codes = new Set<string>();
  for (const text of texts) for (const match of text.matchAll(/"claim":\s*"([A-Za-z0-9_-]{16,64})"/g)) if (match[1] !== undefined) codes.add(match[1]);
  return codes;
}

function withoutCodes(view: ThreadView, known: ReadonlySet<string> = new Set()): ThreadView {
  const clean = (text: string): string => {
    let hidden = hideClaimCodes(text);
    for (const code of known) hidden = hidden.replaceAll(code, CLAIM_HIDDEN);
    return hidden;
  };
  view.title = clean(view.title);
  for (const row of view.rows) {
    if (row.kind === 'work') {
      for (const entry of row.entries) {
        entry.label = clean(entry.label);
        if (entry.detail !== undefined) entry.detail = clean(entry.detail);
      }
    } else row.text = clean(row.text);
  }
  if (view.approval !== undefined) {
    view.approval.title = clean(view.approval.title);
    if (view.approval.detail !== undefined) view.approval.detail = clean(view.approval.detail);
  }
  for (const entry of view.queued) entry.text = clean(entry.text);
  return view;
}

/** T3 titles a tool approval with the tool's raw name and arguments; a browser tool reads better by what it does. */
function approvalLabel(prompt: string): string {
  const match = /^mcp__t3-tab__([a-z_]+)\b/.exec(prompt);
  if (match?.[1] === undefined) return prompt;
  const names: Record<string, string> = { status: 'check the browser', tabs: 'use browser tabs', read: 'read a page', screenshot: 'take a screenshot', act: 'act on a page', run_js: 'run JavaScript on a page' };
  return `Let the agent ${names[match[1]] ?? match[1]}`;
}

const asTime = (value: unknown): number | undefined => {
  if (typeof value !== 'string') return undefined;
  const time = Date.parse(value);
  return Number.isNaN(time) ? undefined : time;
};

const TERMINAL_RUN = new Set(['completed', 'interrupted', 'failed', 'cancelled', 'rolled_back']);
const ACTIVE_RUN = new Set(['preparing', 'starting', 'running', 'waiting']);

interface T3Item {
  id: string;
  type: string;
  runId?: string | null;
  status?: string;
  title?: string | null;
  text?: string;
  streaming?: boolean;
  input?: unknown;
  output?: unknown;
  toolName?: string;
  fileName?: string;
  additions?: number;
  deletions?: number;
  pattern?: string;
  patterns?: string[];
  requestId?: string;
  requestKind?: string;
  prompt?: string;
  reason?: string;
  appName?: string;
  options?: ApprovalOption[];
  questions?: Question[];
  phase?: string;
  startedAt?: string | null;
  completedAt?: string | null;
  updatedAt?: string;
  message?: string;
  failure?: { class?: string; message?: string; resetAt?: string | null };
  retry?: { attempt?: number; maxAttempts?: number };
  diffStr?: string;
  changes?: Array<{ path?: string }>;
}

export interface T3Projection {
  thread: { id: string; title: string; runtimeMode?: string; projectId?: string; providerInstanceId?: string; modelSelection?: { instanceId?: string; model?: string; options?: Array<{ id: string; value: string | boolean }> } };
  runs: Array<{ id: string; status: string; ordinal?: number; startedAt?: string | null; workStartedAt?: string; requestedAt?: string; completedAt?: string | null; userMessageId?: string; queuePosition?: number; queueHeld?: boolean }>;
  runtimeRequests: Array<{ id: string; status: string; kind: string }>;
  /** The conversation's messages, where a queued follow-up's text is before it has a place in the timeline. */
  messages?: Array<{ id: string; text?: string; context?: { guest?: { text?: string } } | null }>;
  visibleTurnItems: Array<{ item: T3Item }>;
}

/** What a failed T3 step says, as T3's own timeline words it. */
function t3FailureText(item: T3Item): string {
  const { failure } = item;
  if (failure?.class === 'usage_limit') {
    const reset = asTime(failure.resetAt);
    return reset === undefined ? 'Usage limit reached.' : `Usage limit reached. Resets at ${new Date(reset).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.`;
  }
  return failure?.message ?? item.message ?? item.text ?? item.title ?? 'The run failed.';
}

/** Adds the reason a turn failed when nothing after the last message says so already. */
function noteFailure(rows: Row[], fallback: string): void {
  const lastUser = rows.findLastIndex((row) => row.kind === 'user');
  if (rows.slice(lastUser + 1).some((row) => row.kind === 'notice' && row.tone === 'error')) return;
  rows.push({ kind: 'notice', id: 'notice:failed', tone: 'error', text: fallback });
}

function t3WorkEntry(item: T3Item): WorkEntry | undefined {
  const status: WorkEntry['status'] =
    item.status === 'failed' ? 'failed' : item.status === 'waiting' ? 'waiting' : item.status === 'running' || item.status === 'pending' ? 'running' : 'done';
  const base = { id: item.id, status };
  switch (item.type) {
    case 'reasoning':
      return (item.text ?? '').trim() === '' ? undefined : { ...base, icon: 'thinking', label: oneLine(item.text ?? '', 220), detail: item.text ?? '' };
    case 'command_execution': {
      const input = typeof item.input === 'string' ? item.input : (item.title ?? 'Command');
      // T3's own setup step, which T3's timeline leaves out too.
      if (input === 'Preparing workspace') return undefined;
      const output = typeof item.output === 'string' ? item.output : undefined;
      return { ...base, icon: 'command', label: oneLine(input), ...(output === undefined ? {} : { detail: output }) };
    }
    case 'dynamic_tool': {
      const name = item.toolName ?? 'Tool';
      // Loading a deferred tool's schema is the agent's bookkeeping, not a step the owner needs to follow.
      if (name === 'ToolSearch') return undefined;
      const browser = browserToolName(name);
      const output = typeof item.output === 'string' ? item.output : undefined;
      const label = browser === undefined ? (item.title ?? name) : browserStepLabel(browser, item.input, output);
      return { ...base, icon: browser === undefined ? 'tool' : 'browser', label: oneLine(label), ...(output === undefined ? {} : { detail: output }) };
    }
    case 'file_change': {
      const counts = item.additions === undefined && item.deletions === undefined ? '' : ` +${item.additions ?? 0} −${item.deletions ?? 0}`;
      const paths = (item.changes ?? []).flatMap((change) => (change.path === undefined ? [] : [change.path]));
      const name = paths.length > 1 ? `${paths.length} files` : (item.fileName ?? item.title ?? 'a file');
      const detail = [paths.length > 1 ? paths.join('\n') : (paths[0] ?? item.fileName), item.diffStr].filter((part) => part !== undefined && part !== '').join('\n\n');
      return { ...base, icon: 'edit', label: `Changed ${name}${counts}`, ...(detail === '' ? {} : { detail: detail.slice(0, 20_000) }) };
    }
    case 'file_search':
      return { ...base, icon: 'search', label: oneLine(item.pattern ?? item.patterns?.join(', ') ?? item.title ?? 'Searched files') };
    case 'web_search':
      return { ...base, icon: 'web', label: oneLine(item.pattern ?? item.title ?? 'Searched the web') };
    case 'todo_list':
      return { ...base, icon: 'plan', label: item.title ?? 'Updated the plan' };
    case 'subagent':
      return { ...base, icon: 'agent', label: oneLine(item.title ?? 'Worker') };
    case 'approval_request':
      // Once answered, the tool's own row carries the step. While waiting, the card above the composer shows what is asked.
      if (status === 'done') return undefined;
      return { ...base, icon: 'approval', label: 'Waiting for approval' };
    case 'user_input_request':
      return { ...base, icon: 'ask', label: 'Input requested' };
    default:
      return undefined;
  }
}

/** Builds the rows of a T3 thread: each run's steps fold into one work row above the reply that ended it. */
export function t3ThreadView(projection: T3Projection): ThreadView {
  const rows: Row[] = [];
  const runs = new Map(projection.runs.map((run) => [run.id, run]));
  let work: Extract<Row, { kind: 'work' }> | undefined;
  /** Replies seen since the last step. Text followed by another step was commentary and moves into the steps. */
  let trailing: Array<Extract<Row, { kind: 'assistant' }>> = [];
  const settle = (): void => {
    trailing = [];
    work = undefined;
  };
  const workFor = (item: T3Item): Extract<Row, { kind: 'work' }> => {
    if (work !== undefined) return work;
    const run = item.runId == null ? undefined : runs.get(item.runId);
    const startedAt = asTime(run?.workStartedAt) ?? asTime(run?.startedAt) ?? asTime(run?.requestedAt);
    const endedAt = asTime(run?.completedAt);
    const created: Extract<Row, { kind: 'work' }> = {
      kind: 'work',
      id: `work:${item.id}`,
      running: run === undefined ? false : !TERMINAL_RUN.has(run.status),
      entries: [],
      ...(startedAt === undefined ? {} : { startedAt }),
      ...(endedAt === undefined ? {} : { endedAt }),
    };
    work = created;
    rows.push(created);
    return created;
  };

  const queuedRuns = projection.runs
    .filter((run) => run.status === 'queued')
    .sort((a, b) => (a.queuePosition ?? a.ordinal ?? 0) - (b.queuePosition ?? b.ordinal ?? 0) || (a.ordinal ?? 0) - (b.ordinal ?? 0));
  const queuedIds = new Set(queuedRuns.map((run) => run.id));

  for (const { item } of projection.visibleTurnItems) {
    if (item.type === 'user_message') {
      // A queued follow-up shows above the composer until its run starts.
      if (item.runId != null && queuedIds.has(item.runId)) continue;
      settle();
      const at = asTime(item.startedAt) ?? asTime(item.updatedAt);
      rows.push({ kind: 'user', id: item.id, text: withoutClaimNote(item.text ?? '').trim(), ...(at === undefined ? {} : { at }) });
      continue;
    }
    if (item.type === 'assistant_message') {
      if ((item.text ?? '').trim() === '') continue;
      const at = asTime(item.completedAt) ?? asTime(item.updatedAt);
      const row: Extract<Row, { kind: 'assistant' }> = {
        kind: 'assistant',
        id: item.id,
        text: withoutClaimNote(item.text ?? ''),
        streaming: item.streaming === true,
        ...(at === undefined ? {} : { at }),
      };
      rows.push(row);
      trailing.push(row);
      continue;
    }
    if (item.type === 'error') {
      const text = t3FailureText(item);
      if (item.retry === undefined) rows.push({ kind: 'notice', id: item.id, tone: 'error', text });
      else rows.push({ kind: 'notice', id: item.id, tone: 'info', text: `Retrying${item.retry.attempt === undefined ? '' : ` (attempt ${item.retry.attempt}${item.retry.maxAttempts === undefined ? '' : ` of ${item.retry.maxAttempts}`})`}: ${text}` });
      continue;
    }
    const entry = t3WorkEntry(item);
    if (entry === undefined) continue;
    const group = workFor(item);
    for (const earlier of trailing) {
      rows.splice(rows.indexOf(earlier), 1);
      group.entries.push({ id: earlier.id, icon: 'note', label: oneLine(earlier.text, 220), detail: earlier.text, status: 'done' });
    }
    trailing = [];
    group.entries.push(entry);
  }

  const pending = projection.runtimeRequests.filter((request) => request.status === 'pending');
  const itemsByRequest = new Map(projection.visibleTurnItems.flatMap(({ item }) => (item.requestId === undefined ? [] : [[item.requestId, item] as const])));
  const view: ThreadView = {
    id: projection.thread.id,
    source: 't3',
    title: projection.thread.title,
    running: false,
    failed: false,
    rows,
    queued: queuedRuns.map((run) => {
      const message = projection.messages?.find((entry) => entry.id === run.userMessageId);
      return { runId: run.id, text: withoutClaimNote(message?.context?.guest?.text ?? message?.text ?? 'Queued message').trim(), held: run.queueHeld === true };
    }),
  };
  for (const request of pending) {
    const item = itemsByRequest.get(request.id);
    if (item?.type === 'user_input_request' && item.questions !== undefined && view.question === undefined) {
      view.question = { requestId: request.id, questions: item.questions };
    } else if (item?.type === 'approval_request' && view.approval === undefined) {
      view.approval = {
        requestId: request.id,
        entryId: item.id,
        kind: item.requestKind ?? request.kind,
        title: approvalLabel(item.prompt ?? item.title ?? 'The agent asks for approval'),
        ...(item.reason == null ? {} : { detail: item.reason }),
        options: item.options ?? [...T3_DEFAULT_APPROVAL_OPTIONS],
      };
    }
  }
  const latest = [...projection.runs].sort((a, b) => (a.ordinal ?? 0) - (b.ordinal ?? 0)).at(-1);
  const active = [...projection.runs].reverse().find((run) => ACTIVE_RUN.has(run.status));
  if (active !== undefined) {
    view.running = true;
    view.activeRunId = active.id;
  }
  view.failed = latest?.status === 'failed';
  if (view.failed) noteFailure(rows, 'This turn failed. T3 Code gave no reason.');
  // A run that started but has shown no step yet still gets its "Working" line.
  if (active !== undefined && !rows.some((row) => row.kind === 'work' && row.running)) {
    const startedAt = asTime(active.workStartedAt) ?? asTime(active.startedAt) ?? asTime(active.requestedAt);
    rows.push({ kind: 'work', id: `work:run:${active.id}`, running: true, entries: [], ...(startedAt === undefined ? {} : { startedAt }) });
  }
  const { runtimeMode, projectId, modelSelection, providerInstanceId } = projection.thread;
  if (runtimeMode !== undefined) view.runtimeMode = runtimeMode;
  if (projectId !== undefined) view.projectId = projectId;
  const provider = modelSelection?.instanceId ?? providerInstanceId;
  if (provider !== undefined) view.provider = provider;
  if (modelSelection?.model !== undefined) view.model = modelSelection.model;
  if (modelSelection?.options !== undefined) view.modelOptions = Object.fromEntries(modelSelection.options.map((option) => [option.id, option.value]));
  const sources = projection.visibleTurnItems.flatMap(({ item }) => [item.text, item.prompt, typeof item.input === 'string' ? item.input : undefined].filter((text) => text !== undefined));
  return withoutCodes(view, claimCodesIn(sources));
}

function directEntry(item: Extract<AgentItem, { kind: 'tool' }>): WorkEntry {
  // A direct run has T3-Tab's tools and no others.
  const browser = browserToolName(item.name);
  return {
    id: item.id,
    icon: browser === undefined ? 'tool' : 'browser',
    label: browser !== undefined ? oneLine(browserStepLabel(browser, parseSummary(item.summary), item.output)) : item.summary === undefined ? item.name : `${item.name} ${oneLine(item.summary, 100)}`,
    status: item.status === 'running' ? 'running' : item.status === 'failed' ? 'failed' : 'done',
    ...(item.output === undefined ? {} : { detail: item.output }),
  };
}

/** A direct run, from the items the helper parsed out of the agent's own event stream. */
export function directThreadView(conversation: AgentConversation): ThreadView {
  const rows: Row[] = [];
  const running = conversation.status === 'running' || conversation.status === 'waiting';
  let work: Extract<Row, { kind: 'work' }> | undefined;
  let trailing: Array<Extract<Row, { kind: 'assistant' }>> = [];
  const items = conversation.items ?? [];
  const lastUser = items.findLastIndex((item) => item.kind === 'user');
  items.forEach((item, index) => {
    const live = index > lastUser;
    const workRow = (): Extract<Row, { kind: 'work' }> => {
      if (work !== undefined) return work;
      const created: Extract<Row, { kind: 'work' }> = {
        kind: 'work',
        id: `work:${item.id}`,
        running: live && running,
        entries: [],
        ...(live && conversation.startedAt !== undefined ? { startedAt: conversation.startedAt } : {}),
        ...(live && conversation.finishedAt !== undefined ? { endedAt: conversation.finishedAt } : {}),
      };
      work = created;
      rows.push(created);
      return created;
    };
    if (item.kind === 'user') {
      work = undefined;
      trailing = [];
      rows.push({ kind: 'user', id: item.id, text: item.text, ...(item.at === undefined ? {} : { at: item.at }) });
    } else if (item.kind === 'assistant') {
      if (item.text.trim() === '') return;
      const row: Extract<Row, { kind: 'assistant' }> = { kind: 'assistant', id: item.id, text: item.text, streaming: item.streaming === true, ...(item.at === undefined ? {} : { at: item.at }) };
      rows.push(row);
      trailing.push(row);
    } else if (item.kind === 'error') {
      rows.push({ kind: 'notice', id: item.id, tone: 'error', text: item.text });
    } else {
      const group = workRow();
      for (const earlier of trailing) {
        rows.splice(rows.indexOf(earlier), 1);
        group.entries.push({ id: earlier.id, icon: 'note', label: oneLine(earlier.text, 220), detail: earlier.text, status: 'done' });
      }
      trailing = [];
      if (item.kind === 'tool') group.entries.push(directEntry(item));
      else if (item.text.trim() !== '') {
        group.entries.push({ id: item.id, icon: 'thinking', label: oneLine(item.text, 220), detail: item.text, status: item.streaming === true ? 'running' : 'done' });
      }
    }
  });
  if (running && !rows.some((row) => row.kind === 'work' && row.running)) {
    rows.push({
      kind: 'work',
      id: 'work:starting',
      running: true,
      entries: [],
      ...(conversation.startedAt === undefined ? {} : { startedAt: conversation.startedAt }),
    });
  }
  const failed = conversation.status === 'failed';
  if (failed) noteFailure(rows, conversation.error ?? 'This run failed.');
  const view: ThreadView = { id: conversation.id, source: 'direct', title: conversation.title, running, failed, rows, queued: [] };
  view.provider = conversation.via;
  if (conversation.model !== undefined) view.model = conversation.model;
  return withoutCodes(view);
}
