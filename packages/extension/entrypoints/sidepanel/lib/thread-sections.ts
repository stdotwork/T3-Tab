/**
 * The thread list's groups and order, following T3 Code's own sidebar. The rules are T3's, read from its web client
 * (T3 Code nightly 0.1.12): the section a thread is in and its order come from the sidebar's grouping (`Sidebar.logic`
 * and the sidebar component), snoozing and the attention that wakes a snooze from `threadSettled`, the sort keys from
 * the client's thread entities, and the shell-to-thread mapping from its orchestration store. Only reading: the panel
 * never snoozes, settles or pins.
 */
import type { ThreadShell } from './t3-client';

/** T3's sections, in the order its sidebar shows them. Pinned and Active carry no heading there; the rest are shelves. */
export type Section = 'pinned' | 'active' | 'working' | 'snoozed' | 'settled';

/** The status T3 shows on a sidebar row, or none. */
export type RowStatus = 'approval' | 'input' | 'guest' | 'working' | 'connecting' | 'waiting' | 'failed' | 'plan' | 'completed';

export const STATUS_LABEL: Record<RowStatus, string> = {
  approval: 'Pending Approval',
  input: 'Awaiting Input',
  guest: 'Guest Request',
  working: 'Working',
  connecting: 'Connecting',
  waiting: 'Waiting',
  failed: 'Failed',
  plan: 'Plan Ready',
  completed: 'Completed',
};

export const SHELF_LABEL: Record<'working' | 'snoozed' | 'settled', string> = { working: 'Working', snoozed: 'Snoozed', settled: 'Settled' };

/** T3 shows the first ten settled threads when the shelf opens, then 25 more for each "Show more". */
export const SETTLED_FIRST = 10;
export const SETTLED_MORE = 25;

type RunLike = { runId: string; status: string; requestedAt: string | null; startedAt: string | null; completedAt: string | null };
type RuntimeLike = { status: string; activeRunId: string | null; updatedAt: string | null };
type SubagentRequest = 'approval' | 'user_input' | 'user_only_input';

/** A shell thread with the fields T3's client derives from it before its sidebar reads it. */
interface Derived {
  shell: ThreadShell;
  hasPendingApprovals: boolean;
  hasPendingUserInput: boolean;
  pendingUserInputAt: string | null;
  pendingSubagentRequest: SubagentRequest | null;
  runtime: RuntimeLike | null;
  latestRun: RunLike | null;
}

const ACTIVE_RUN = new Set(['preparing', 'queued', 'starting', 'running', 'waiting']);
const TERMINAL_RUN = new Set(['completed', 'interrupted', 'failed', 'cancelled', 'rolled_back']);

const parse = (value: string | null | undefined): number | null => {
  if (value === null || value === undefined || value === '') return null;
  const at = Date.parse(value);
  return Number.isFinite(at) ? at : null;
};

/** Background work that keeps a run from counting as finished: anything awaited, a subagent or a background task. */
const backgroundHolds = (shell: ThreadShell): boolean => (shell.pendingBackgroundTasks ?? []).some((task) => task.awaited === true || task.kind === 'subagent' || task.kind === 'background_task');

/** T3 lists a thread on its own unless it is a subagent, a side chat or a workflow step. */
const listedLineage = (shell: ThreadShell): boolean =>
  shell.lineage?.relationshipToParent !== 'subagent' && shell.lineage?.sideChat !== true && shell.lineage?.workflowStep !== true;

const shellActive = (shell: ThreadShell): boolean =>
  shell.activityRunStatus === undefined ? ['preparing', 'starting', 'running', 'waiting'].includes(shell.status ?? '') : shell.activityRunStatus !== null;

/** A request in a subagent or delegated child that T3 shows on its parent. */
function childRequest(shell: ThreadShell): SubagentRequest | null {
  const kind = shell.pendingRuntimeRequest?.kind;
  if (kind === undefined || kind === 'auth_refresh') return null;
  if (shell.lineage?.relationshipToParent !== 'subagent' && shell.delegatedFrom === undefined) return null;
  // A provider's own subagent answers through its parent's run.
  if (shell.lineage?.relationshipToParent === 'subagent' && shell.creationSource === 'provider') return null;
  if (!shellActive(shell)) return null;
  if (kind !== 'user_input') return 'approval';
  return shell.pendingRuntimeRequest?.userOnly === true ? 'user_only_input' : 'user_input';
}

/** Which parent threads carry a child's request, as T3's client works it out for one environment. */
function subagentRequests(threads: readonly ThreadShell[]): Map<string, SubagentRequest> {
  const requests = new Map<string, SubagentRequest>();
  const byId = new Map(threads.map((thread) => [thread.id, thread]));
  const bubble = (start: string | null | undefined, kind: SubagentRequest, seen: Set<string>): void => {
    // A plain question from a subagent stays with the subagent; only approvals and owner-only questions climb.
    if (kind === 'user_input') return;
    let at = start ?? null;
    while (at !== null && !seen.has(at)) {
      seen.add(at);
      if (requests.get(at) !== 'approval') requests.set(at, kind);
      const parent = byId.get(at);
      at = parent !== undefined && (parent.lineage?.relationshipToParent === 'subagent' || parent.lineage?.sideChat === true) ? (parent.lineage.parentThreadId ?? null) : null;
    }
  };
  for (const thread of threads) {
    const parent = thread.lineage?.parentThreadId ?? null;
    if (thread.lineage?.sideChat === true) {
      const kind = thread.pendingRuntimeRequest?.kind;
      const request: SubagentRequest | null = kind === undefined || kind === 'auth_refresh' ? null : kind === 'user_input' ? 'user_input' : 'approval';
      if (parent !== null && request !== null && requests.get(parent) !== 'approval') requests.set(parent, request);
      continue;
    }
    if (thread.lineage?.relationshipToParent !== 'subagent') continue;
    const request = childRequest(thread);
    if (request !== null) bubble(parent, request, new Set([thread.id]));
  }
  return requests;
}

function derive(shell: ThreadShell, subagent: SubagentRequest | null): Derived {
  const status = shell.status ?? 'idle';
  const request = shell.pendingRuntimeRequest ?? null;
  const latestRunId = shell.latestRunId ?? null;
  const holds = backgroundHolds(shell) && status !== 'failed';
  const runtime: RuntimeLike | null =
    latestRunId === null && !holds ? null : { status: holds ? 'idle' : (shell.activityRunStatus ?? status), activeRunId: shell.activeRunId ?? null, updatedAt: shell.updatedAt ?? null };
  const latestRun: RunLike | null =
    latestRunId === null
      ? null
      : {
          runId: latestRunId,
          status: status === 'idle' ? 'completed' : status,
          requestedAt: shell.latestRunRequestedAt ?? null,
          startedAt: shell.latestRunStartedAt ?? null,
          completedAt: shell.latestRunCompletedAt === undefined ? (status === 'idle' || TERMINAL_RUN.has(status) ? (shell.updatedAt ?? null) : null) : shell.latestRunCompletedAt,
        };
  return {
    shell,
    hasPendingApprovals: request !== null && request.kind !== 'user_input' && request.kind !== 'auth_refresh',
    hasPendingUserInput: request?.kind === 'user_input',
    pendingUserInputAt: request?.kind === 'user_input' ? (request.createdAt ?? null) : null,
    pendingSubagentRequest: subagent,
    runtime,
    latestRun,
  };
}

/** When a failed run asks for the owner's eye: undefined when the thread has not failed. */
function failedAt(thread: Derived): string | null | undefined {
  const runtime = thread.runtime;
  if (runtime?.status !== 'error' && runtime?.status !== 'failed') return undefined;
  return thread.latestRun?.status === 'failed' ? (thread.latestRun.completedAt ?? null) : runtime.updatedAt;
}

/** Something that wakes a snoozed thread: a request, a question asked after the snooze, a guest message or a failure. */
function needsAttention(thread: Derived): boolean {
  const { shell } = thread;
  const request = shell.pendingRuntimeRequest ?? null;
  if (thread.hasPendingApprovals || (request !== null && request.kind !== 'user_input')) return true;
  const askedAt = thread.pendingUserInputAt;
  const snoozedAt = shell.snoozedAt ?? null;
  if (thread.hasPendingUserInput && (snoozedAt === null || askedAt === null || !(Date.parse(askedAt) <= Date.parse(snoozedAt)))) return true;
  if (thread.pendingSubagentRequest !== null || (shell.pendingGuestMessageCount ?? 0) > 0) return true;
  const failed = failedAt(thread);
  return failed !== undefined && (snoozedAt === null || (failed !== null && Date.parse(failed) > Date.parse(snoozedAt)));
}

/** Snoozed until `snoozedUntil` passes, unless something needs the owner first. */
function isSnoozed(thread: Derived, now: number): boolean {
  const until = thread.shell.snoozedUntil;
  if (until === null || until === undefined) return false;
  const at = Date.parse(until);
  if (Number.isNaN(at) || at <= now) return false;
  return !needsAttention(thread);
}

/** T3's Working shelf: a run in progress, not waiting on the owner, and not a finished plan waiting to be read. */
function isWorking(thread: Derived): boolean {
  const { runtime, latestRun, shell } = thread;
  if (thread.hasPendingApprovals || thread.hasPendingUserInput || thread.pendingSubagentRequest !== null) return false;
  if (!(runtime !== null && ACTIVE_RUN.has(runtime.status)) && runtime?.status !== 'idle') return false;
  const runEnded = latestRun !== null && !ACTIVE_RUN.has(latestRun.status) && runtime?.activeRunId !== latestRun.runId;
  return !(shell.interactionMode === 'plan' && shell.hasActionableProposedPlan === true && runEnded);
}

function sectionOf(thread: Derived, now: number): Section {
  if (isSnoozed(thread, now)) return 'snoozed';
  if (thread.shell.settledOverride === 'settled') return 'settled';
  if (thread.shell.pinnedAt !== null && thread.shell.pinnedAt !== undefined) return 'pinned';
  return isWorking(thread) ? 'working' : 'active';
}

/** The row status T3 shows, in T3's order of precedence. */
function statusOf(thread: Derived): RowStatus | undefined {
  const { shell, runtime, latestRun } = thread;
  if (thread.hasPendingApprovals || thread.pendingSubagentRequest === 'approval') return 'approval';
  if (thread.hasPendingUserInput || thread.pendingSubagentRequest === 'user_input') return 'input';
  if ((shell.pendingGuestMessageCount ?? 0) > 0) return 'guest';
  if ((runtime?.status === 'running' && shell.blockedOnThreadWait !== true) || runtime?.status === 'waiting') return 'working';
  if (runtime?.status === 'preparing' || runtime?.status === 'starting' || runtime?.status === 'queued') return 'connecting';
  if (runtime?.status === 'running' && shell.blockedOnThreadWait === true) return 'waiting';
  if (failedUnseen(thread)) return 'failed';
  if (backgroundHolds(shell)) return 'waiting';
  const planReady = latestRun !== null && !ACTIVE_RUN.has(latestRun.status) && runtime?.activeRunId !== latestRun.runId;
  if (!thread.hasPendingUserInput && shell.interactionMode === 'plan' && planReady && shell.hasActionableProposedPlan === true) return 'plan';
  if (completedUnseen(thread)) return 'completed';
  return undefined;
}

/** A failed run the owner has not looked at since. */
function failedUnseen(thread: Derived): boolean {
  const run = thread.latestRun;
  if (run?.status !== 'failed') return false;
  const visited = thread.shell.lastVisitedAt;
  if (visited === null || visited === undefined || visited === '') return true;
  const at = Date.parse(run.completedAt ?? run.startedAt ?? run.requestedAt ?? '');
  const seen = Date.parse(visited);
  return Number.isNaN(at) || Number.isNaN(seen) ? true : at > seen;
}

/** A finished run the owner has not looked at since. */
function completedUnseen(thread: Derived): boolean {
  const run = thread.latestRun;
  if (run === null || run.completedAt === null || run.status === 'interrupted' || run.status === 'cancelled') return false;
  const at = Date.parse(run.completedAt);
  const visited = thread.shell.lastVisitedAt;
  if (Number.isNaN(at) || visited === null || visited === undefined || visited === '') return false;
  const seen = Date.parse(visited);
  return Number.isNaN(seen) ? true : at > seen;
}

const byIdThen = (a: { id: string }, b: { id: string }): number => a.id.localeCompare(b.id);

/** Pinned: the owner's pin order first, then the rest newest first. */
function orderPinned(threads: Derived[]): Derived[] {
  const keyed = threads.filter((thread) => thread.shell.pinOrderKey != null);
  const unkeyed = threads.filter((thread) => thread.shell.pinOrderKey == null);
  keyed.sort((a, b) => {
    const left = a.shell.pinOrderKey as string;
    const right = b.shell.pinOrderKey as string;
    return left < right ? -1 : left > right ? 1 : byIdThen(a.shell, b.shell);
  });
  unkeyed.sort((a, b) => (parse(b.shell.createdAt) ?? 0) - (parse(a.shell.createdAt) ?? 0) || byIdThen(a.shell, b.shell));
  return [...keyed, ...unkeyed];
}

/** Settled: newest settle first; a thread with no usable settle time goes by its latest activity. */
function settledAt(thread: Derived): number {
  if (parse(thread.shell.settledAt) !== null) return parse(thread.shell.settledAt) as number;
  let latest: number | null = null;
  for (const value of [thread.shell.latestUserMessageAt, thread.latestRun?.requestedAt, thread.latestRun?.startedAt, thread.latestRun?.completedAt]) {
    const at = parse(value);
    if (at !== null && (latest === null || at > latest)) latest = at;
  }
  return latest ?? parse(thread.shell.updatedAt) ?? 0;
}

/** A direct Claude Code or Codex run from the panel. T3 has no snooze or settle for these. */
export interface DirectRun {
  id: string;
  title: string;
  status: 'running' | 'waiting' | 'idle' | 'failed';
  startedAt?: number;
  finishedAt?: number;
  updatedAt: number;
}

export type ListRow =
  | { source: 't3'; id: string; section: Section; status: RowStatus | undefined; shell: ThreadShell; at: number; pinned: boolean; wakesAt?: string }
  | { source: 'direct'; id: string; section: Section; status: RowStatus | undefined; run: DirectRun; at: number; pinned: false };

export interface ThreadSections {
  pinned: ListRow[];
  active: ListRow[];
  working: ListRow[];
  snoozed: ListRow[];
  settled: ListRow[];
}

/**
 * Groups and orders the threads as T3's sidebar does with its default settings (the Working shelf on, no project
 * folders). Archived threads, subagents, side chats, workflow steps and threads delegated under a listed parent are
 * left out, as T3 leaves them out of its list.
 */
export function threadSections(shells: readonly ThreadShell[], directRuns: readonly DirectRun[], now: number): ThreadSections {
  const present = new Set(shells.filter((shell) => shell.archivedAt == null).map((shell) => shell.id));
  const requests = subagentRequests(shells);
  const visible = shells.filter(
    (shell) => shell.archivedAt == null && listedLineage(shell) && !(shell.delegatedFrom !== undefined && present.has(shell.delegatedFrom.threadId)),
  );
  const groups: Record<Section, Derived[]> = { pinned: [], active: [], working: [], snoozed: [], settled: [] };
  for (const shell of visible) {
    const thread = derive(shell, requests.get(shell.id) ?? null);
    groups[sectionOf(thread, now)].push(thread);
  }
  const t3Row = (thread: Derived, section: Section, at: number): ListRow => ({
    source: 't3',
    id: thread.shell.id,
    section,
    status: statusOf(thread),
    shell: thread.shell,
    at,
    pinned: thread.shell.pinnedAt != null,
    ...(section === 'snoozed' && thread.shell.snoozedUntil != null ? { wakesAt: thread.shell.snoozedUntil } : {}),
  });
  // Active with the Working shelf on: the latest of creation, unsettling, and the latest run's request and end.
  const activeAt = (thread: Derived): number =>
    Math.max(parse(thread.shell.createdAt) ?? 0, parse(thread.shell.unsettledAt) ?? 0, parse(thread.latestRun?.requestedAt) ?? 0, parse(thread.latestRun?.completedAt) ?? 0);
  // Working: the latest of creation and the owner's own last message (or, from an older T3, the run's request).
  const workingAt = (thread: Derived): number =>
    Math.max(parse(thread.shell.createdAt) ?? 0, parse(thread.shell.latestUserAuthoredMessageAt === undefined ? thread.latestRun?.requestedAt : thread.shell.latestUserAuthoredMessageAt) ?? 0);
  const newestFirst = (rows: ListRow[]): ListRow[] => rows.sort((a, b) => b.at - a.at || a.id.localeCompare(b.id));

  // A direct run is working while its turn runs, and otherwise sits with the active threads by its last turn.
  const directRows = directRuns.map((run): ListRow => {
    const working = run.status === 'running' || run.status === 'waiting';
    return {
      source: 'direct',
      id: run.id,
      section: working ? 'working' : 'active',
      status: working ? 'working' : run.status === 'failed' ? 'failed' : undefined,
      run,
      at: working ? (run.startedAt ?? run.updatedAt) : Math.max(run.startedAt ?? 0, run.finishedAt ?? 0) || run.updatedAt,
      pinned: false,
    };
  });

  return {
    pinned: orderPinned(groups.pinned).map((thread) => t3Row(thread, 'pinned', 0)),
    active: newestFirst([...groups.active.map((thread) => t3Row(thread, 'active', activeAt(thread))), ...directRows.filter((row) => row.section === 'active')]),
    working: newestFirst([...groups.working.map((thread) => t3Row(thread, 'working', workingAt(thread))), ...directRows.filter((row) => row.section === 'working')]),
    // Soonest to wake first; Array.prototype.sort is stable, as T3's toSorted is.
    snoozed: groups.snoozed
      .map((thread) => t3Row(thread, 'snoozed', parse(thread.shell.snoozedUntil) ?? 0))
      .sort((a, b) => a.at - b.at),
    settled: groups.settled
      .map((thread) => t3Row(thread, 'settled', settledAt(thread)))
      .sort((a, b) => b.at - a.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
  };
}

/** Threads waiting on the owner's approval or answer, outside a snooze. */
export function needsOwner(sections: ThreadSections): boolean {
  return [sections.pinned, sections.active, sections.working, sections.settled].some((rows) => rows.some((row) => row.status === 'approval' || row.status === 'input'));
}

/** The next moment a snoozed thread wakes, so the list can redraw then. */
export function nextWake(shells: readonly ThreadShell[], now: number): number | undefined {
  let next: number | undefined;
  for (const shell of shells) {
    const at = parse(shell.snoozedUntil);
    if (at !== null && at > now && (next === undefined || at < next)) next = at;
  }
  return next;
}

/** T3's wake label for a snoozed row: `now`, minutes, hours or days. */
export function wakeLabel(until: string, now: number): string {
  const at = Date.parse(until);
  if (Number.isNaN(at) || Number.isNaN(now) || at <= now) return 'now';
  const minutes = Math.max(1, Math.floor(at / 60_000) - Math.floor(now / 60_000));
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 1440) return `${Math.ceil(minutes / 60)}h`;
  return `${Math.ceil(minutes / 1440)}d`;
}
