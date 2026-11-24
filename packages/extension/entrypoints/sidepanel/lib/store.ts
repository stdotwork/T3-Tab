/** The panel's live state from the extension: the helper link, setup, the current tab, prompts and direct runs. */
import type { AgentConversation, T3State as T3RunState } from '@t3-tab/protocol';
import { useEffect, useState, useSyncExternalStore } from 'react';

import type { PermissionPrompt, StoredSitePermission } from '../../../src/permissions';
import type { PanelTab, TabThread } from '../../../src/panel';
import type { StoredSession } from '../../../src/sessions';
import { BUILD_ID } from '../../../src/build-id';
import { panelTabKey } from '../../../src/panel-tab';
import { errorText, panel, readStored, readTabStored, removeStored, writeStored, writeTabStored } from './api';
import type { SetupAgent } from './catalog';

export type { HelperProblem, HelperState } from '../../../src/daemon-link';
import type { HelperState } from '../../../src/daemon-link';

export interface SetupState {
  agents: SetupAgent[];
  t3: { state: T3RunState; origin?: string };
}

export interface AutoAllowed {
  tool: string;
  origin: string;
  tabId: number;
  tabTitle: string;
  at: number;
}

/** Whether the extension's service worker is the same build as this panel. `reloading`: it is not, and the extension is being reloaded. `stuck`: it is not, and a reload did not fix it. */
export type WorkerBuild = 'current' | 'reloading' | 'stuck';

export interface LiveState {
  build?: WorkerBuild;
  loaded: boolean;
  helper: HelperState;
  setup?: SetupState;
  currentTab?: PanelTab;
  /** The thread that holds this panel's tab, if any, so opening the panel there shows it. */
  tabThread?: TabThread;
  /** The first answer about this tab has arrived. */
  tabLoaded?: boolean;
  prompts: PermissionPrompt[];
  sites: StoredSitePermission[];
  sessions: StoredSession[];
  autoAllowed: AutoAllowed[];
  conversations: AgentConversation[];
  /** Goes up whenever the worker or its stored state says something changed, for views that fetch on change. */
  changes: number;
}

let live: LiveState = { loaded: false, helper: { connected: false }, prompts: [], sites: [], sessions: [], autoAllowed: [], conversations: [], changes: 0 };
const listeners = new Set<() => void>();

const same = (left: unknown, right: unknown): boolean => left === right || JSON.stringify(left) === JSON.stringify(right);

/** Applies a patch. A poll that found nothing new changes nothing, so nothing redraws. */
const merge = (patch: Partial<LiveState>): void => {
  const fresh = Object.entries(patch).filter(([key, value]) => !same(live[key as keyof LiveState], value));
  if (fresh.length === 0) return;
  live = { ...live, ...Object.fromEntries(fresh) };
  for (const listener of listeners) listener();
};

const params = new URL(location.href).searchParams;
const fixedTab = params.get('tabId');
export const fixedTabId = fixedTab === null || !Number.isInteger(Number(fixedTab)) ? undefined : Number(fixedTab);
/** The end-to-end run draws the panel from state it supplies, so no poll overwrites it. */
export const headlessRender = params.get('headless') === '1';

async function refreshPanelState(): Promise<void> {
  try {
    const state = await panel<{ currentTab?: PanelTab; tabThread?: TabThread; pending: PermissionPrompt[]; sites: StoredSitePermission[]; sessions?: StoredSession[]; autoAllowed?: AutoAllowed[] }>({
      type: 'panel.state',
      ...(fixedTabId === undefined ? {} : { tabId: fixedTabId }),
    });
    const next: Partial<LiveState> = { prompts: state.pending, sites: state.sites, sessions: state.sessions ?? [], autoAllowed: state.autoAllowed ?? [], tabLoaded: true };
    if (state.currentTab !== undefined) next.currentTab = state.currentTab;
    if (state.tabThread !== undefined) next.tabThread = state.tabThread;
    merge(next);
  } catch {
    // The worker can be restarting. The next poll tries again.
  }
}

export const refreshPanel = refreshPanelState;

let latestSetup = 0;
let setupsRunning = 0;
/** Screens showing setup details. Without one the helper's agent and T3 checks are asked for once a minute. */
let setupViewers = 0;
let setupFetchedAt = 0;
const SETUP_IDLE_MS = 60_000;

/** A timed poll waits its turn; an explicit refresh supersedes it, and only the latest reply is applied. */
export async function refreshSetup(refresh = false): Promise<void> {
  if (!refresh && setupsRunning > 0) return;
  latestSetup += 1;
  const request = latestSetup;
  setupsRunning += 1;
  try {
    const helper = await panel<HelperState>({ type: 'panel.helper' });
    if (request !== latestSetup) return;
    const wasConnected = live.helper.connected;
    if (!helper.connected) {
      merge({ helper, loaded: true });
      return;
    }
    if (!refresh && wasConnected && setupViewers === 0 && live.setup !== undefined && Date.now() - setupFetchedAt < SETUP_IDLE_MS) {
      merge({ helper, loaded: true });
      return;
    }
    const setup = await panel<SetupState>({ type: 'panel.setup', refresh });
    if (request !== latestSetup) return;
    setupFetchedAt = Date.now();
    merge({ helper, setup, loaded: true });
    if (!wasConnected) void refreshConversations();
  } catch (error) {
    if (request === latestSetup) merge({ helper: { connected: false, error: error instanceof Error ? error.message : String(error) }, loaded: true });
  } finally {
    setupsRunning -= 1;
  }
}

export async function refreshConversations(): Promise<void> {
  if (!live.helper.connected) return;
  try {
    const { conversations } = await panel<{ conversations: AgentConversation[] }>({ type: 'panel.agents' });
    merge({ conversations });
  } catch {
    // Shown as a lost helper by the setup poll.
  }
}

const RELOAD_KEY = 't3tab.workerReload';
/** A reload that did not change the worker is not tried again for this long, so a panel can never reload in a loop. */
const RELOAD_RETRY_MS = 5 * 60_000;
/** What a worker that predates the build check says to `panel.build`. */
const UNKNOWN_REQUEST = 'Invalid panel request';

/**
 * Compares the service worker's build with this panel's. A different build, or a worker too old to know the question,
 * means the extension was rebuilt on disk and not reloaded: the panel reloads the extension (which closes the panel;
 * opening it again finds the new worker). The attempt is written down first and is not repeated within five minutes.
 * An answer that did not come at all (the worker is restarting) is tried again at the next poll.
 */
export async function checkWorkerBuild(): Promise<void> {
  if (BUILD_ID === 'dev') {
    merge({ build: 'current' });
    return;
  }
  let stale: boolean;
  try {
    stale = (await panel<{ buildId?: string }>({ type: 'panel.build' })).buildId !== BUILD_ID;
  } catch (error) {
    if (errorText(error) !== UNKNOWN_REQUEST) return;
    stale = true;
  }
  if (!stale) {
    await removeStored(RELOAD_KEY);
    merge({ build: 'current' });
    return;
  }
  const tried = await readStored<{ buildId: string; at: number }>(RELOAD_KEY);
  if (tried?.buildId === BUILD_ID && Date.now() - tried.at < RELOAD_RETRY_MS) {
    merge({ build: 'stuck' });
    return;
  }
  await writeStored(RELOAD_KEY, { buildId: BUILD_ID, at: Date.now() });
  merge({ build: 'reloading' });
  chrome.runtime.reload();
}

let started = false;

interface PollTask {
  run: () => Promise<void> | void;
  every: () => number;
  due: number;
}

const anyRunning = (): boolean => live.conversations.some((conversation) => conversation.status === 'running' || conversation.status === 'waiting');

/**
 * What the panel still asks on a timer. Changes arrive by themselves (the worker's `panel.changed`, stored state, tab
 * events), so these are the safety net. While the panel is hidden they slow down rather than stop, in case a browser
 * never reports it visible again, and they run at once when it shows.
 */
const polls = {
  state: { run: refreshPanelState, every: () => 5_000, due: 0 } as PollTask,
  helper: { run: () => refreshSetup(), every: () => (live.helper.connected && setupViewers === 0 ? 10_000 : 3_000), due: 0 } as PollTask,
  // Only an answer that never came is asked again.
  build: { run: () => (live.build === undefined ? checkWorkerBuild() : undefined), every: () => 3_000, due: 0 } as PollTask,
  conversations: { run: refreshConversations, every: () => (anyRunning() ? 1_500 : 15_000), due: 0 } as PollTask,
};

let pollTimer: ReturnType<typeof setTimeout> | undefined;

const pollInterval = (task: PollTask): number => {
  if (!document.hidden) return task.every();
  return Math.max(task.every(), task === polls.helper && !live.helper.connected ? 5_000 : 15_000);
};

function schedulePolls(): void {
  if (pollTimer !== undefined) clearTimeout(pollTimer);
  const next = Math.min(...Object.values(polls).map((task) => task.due));
  pollTimer = setTimeout(runDuePolls, Math.max(0, next - Date.now()));
}

function runDuePolls(): void {
  const now = Date.now();
  for (const task of Object.values(polls)) {
    if (task.due > now) continue;
    task.due = now + pollInterval(task);
    void task.run();
  }
  schedulePolls();
}

let changeTimer: ReturnType<typeof setTimeout> | undefined;

/** Something changed: one refresh for a burst of events. */
function refreshSoon(): void {
  if (changeTimer !== undefined) return;
  changeTimer = setTimeout(() => {
    changeTimer = undefined;
    merge({ changes: live.changes + 1 });
    void refreshPanelState();
  }, 50);
}

/** Keys the panel writes for itself. A change to one says nothing about the browser's state. */
const OWN_KEY = /^(panel\.tab\.|composer\.|appearance\.|setup\.)/;

export function startPolling(): void {
  if (started || headlessRender) return;
  started = true;
  void refreshPanelState();
  void checkWorkerBuild();
  void refreshSetup(true).then(refreshConversations);
  const now = Date.now();
  for (const task of Object.values(polls)) task.due = now + pollInterval(task);
  schedulePolls();
  chrome.runtime?.onMessage?.addListener((message: unknown, sender: chrome.runtime.MessageSender) => {
    if (sender.id === chrome.runtime.id && (message as { type?: unknown } | null)?.type === 'panel.changed') refreshSoon();
  });
  chrome.storage?.onChanged?.addListener((changes) => {
    if (Object.keys(changes).some((key) => !OWN_KEY.test(key))) refreshSoon();
  });
  chrome.tabs?.onActivated?.addListener(refreshSoon);
  chrome.tabs?.onUpdated?.addListener((tabId, info) => {
    if (fixedTabId !== undefined && tabId !== fixedTabId) return;
    if (info.title !== undefined || info.url !== undefined || info.groupId !== undefined || info.status === 'complete') refreshSoon();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    for (const task of Object.values(polls)) task.due = 0;
    runDuePolls();
  });
}

/** While a screen shows setup details, they are kept fresh. */
export function useFreshSetup(): void {
  useEffect(() => {
    setupViewers += 1;
    polls.helper.due = 0;
    if (started) schedulePolls();
    return () => {
      setupViewers -= 1;
    };
  }, []);
}

/** Asks for the list of direct runs again now, so a run just started is followed at the fast pace. */
export async function refreshRunsNow(): Promise<void> {
  await refreshConversations();
  polls.conversations.due = Date.now() + pollInterval(polls.conversations);
  if (started) schedulePolls();
}

export function applyHeadlessState(state: { currentTab?: PanelTab; pending: PermissionPrompt[]; sites: StoredSitePermission[]; sessions?: StoredSession[]; autoAllowed?: AutoAllowed[] }): void {
  const next: Partial<LiveState> = { prompts: state.pending, sites: state.sites, sessions: state.sessions ?? [], autoAllowed: state.autoAllowed ?? [], loaded: true, tabLoaded: true };
  if (state.currentTab !== undefined) next.currentTab = state.currentTab;
  merge(next);
}

/** The tabs a thread started now would share, and the group they come from when it is the owner's own. */
export interface ShareTargets {
  tabs: PanelTab[];
  groupTitle?: string;
}

/** Follows what sending now would share. Empty on a page that cannot be shared. */
export function useShareTargets(tab: PanelTab | undefined, changes: number): ShareTargets {
  const [targets, setTargets] = useState<ShareTargets>({ tabs: [] });
  const shareable = tab !== undefined && /^https?:/.test(tab.url);
  const id = tab?.id;
  useEffect(() => {
    if (!shareable || id === undefined) {
      setTargets({ tabs: [] });
      return;
    }
    let current = true;
    void panel<ShareTargets>({ type: 'panel.shareTargets', tabId: id })
      .then((next) => {
        if (current) setTargets(next);
      })
      .catch(() => {
        if (current) setTargets({ tabs: tab === undefined ? [] : [tab] });
      });
    return () => {
      current = false;
    };
  }, [id, shareable, tab?.url, changes]);
  return targets;
}

export function useLive(): LiveState {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => live,
  );
}

/** A value this tab's panel keeps for itself, so the panel comes back as it was when the owner returns to the tab. */
export function useTabStored<T>(name: string, fallback: T): [T, (value: T) => void, boolean] {
  const key = panelTabKey(fixedTabId, name);
  const [value, setValue] = useState<T>(fallback);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let current = true;
    void readTabStored<T>(key)
      .then((stored) => {
        if (current && stored !== undefined) setValue(stored);
      })
      .finally(() => {
        if (current) setReady(true);
      });
    return () => {
      current = false;
    };
  }, [key]);
  return [
    value,
    (next) => {
      setValue(next);
      void writeTabStored(key, next).catch(() => undefined);
    },
    ready,
  ];
}

/** A value kept in the extension's local storage. `undefined` until it has loaded. */
export function useStored<T>(key: string, fallback: T): [T, (value: T) => void, boolean] {
  const [value, setValue] = useState<T>(fallback);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let live = true;
    void readStored<T>(key).then((stored) => {
      if (!live) return;
      if (stored !== undefined) setValue(stored);
      setReady(true);
    });
    return () => {
      live = false;
    };
  }, [key]);
  return [
    value,
    (next) => {
      setValue(next);
      void writeStored(key, next);
    },
    ready,
  ];
}
