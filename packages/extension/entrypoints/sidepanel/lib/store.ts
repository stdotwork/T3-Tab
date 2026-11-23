/** The panel's live state from the extension: the helper link, setup, the current tab, prompts and direct runs. */
import type { AgentConversation, T3State as T3RunState } from '@t3-tab/protocol';
import { useEffect, useState, useSyncExternalStore } from 'react';

import type { PermissionPrompt, StoredSitePermission } from '../../../src/permissions';
import type { PanelTab } from '../../../src/panel';
import type { StoredSession } from '../../../src/sessions';
import { BUILD_ID } from '../../../src/build-id';
import { errorText, panel, readStored, removeStored, writeStored } from './api';
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
  prompts: PermissionPrompt[];
  sites: StoredSitePermission[];
  sessions: StoredSession[];
  autoAllowed: AutoAllowed[];
  conversations: AgentConversation[];
}

let live: LiveState = { loaded: false, helper: { connected: false }, prompts: [], sites: [], sessions: [], autoAllowed: [], conversations: [] };
const listeners = new Set<() => void>();

const merge = (patch: Partial<LiveState>): void => {
  live = { ...live, ...patch };
  for (const listener of listeners) listener();
};

const params = new URL(location.href).searchParams;
const fixedTab = params.get('tabId');
export const fixedTabId = fixedTab === null || !Number.isInteger(Number(fixedTab)) ? undefined : Number(fixedTab);
/** The end-to-end run draws the panel from state it supplies, so no poll overwrites it. */
export const headlessRender = params.get('headless') === '1';

async function refreshPanelState(): Promise<void> {
  try {
    const state = await panel<{ currentTab?: PanelTab; pending: PermissionPrompt[]; sites: StoredSitePermission[]; sessions?: StoredSession[]; autoAllowed?: AutoAllowed[] }>({
      type: 'panel.state',
      ...(fixedTabId === undefined ? {} : { tabId: fixedTabId }),
    });
    const next: Partial<LiveState> = { prompts: state.pending, sites: state.sites, sessions: state.sessions ?? [], autoAllowed: state.autoAllowed ?? [] };
    if (state.currentTab !== undefined) next.currentTab = state.currentTab;
    merge(next);
  } catch {
    // The worker can be restarting. The next poll tries again.
  }
}

export const refreshPanel = refreshPanelState;

let latestSetup = 0;
let setupsRunning = 0;

/** A timed poll waits its turn; an explicit refresh supersedes it, and only the latest reply is applied. */
export async function refreshSetup(refresh = false): Promise<void> {
  if (!refresh && setupsRunning > 0) return;
  latestSetup += 1;
  const request = latestSetup;
  setupsRunning += 1;
  try {
    const helper = await panel<HelperState>({ type: 'panel.helper' });
    if (request !== latestSetup) return;
    if (!helper.connected) {
      merge({ helper, loaded: true });
      return;
    }
    const setup = await panel<SetupState>({ type: 'panel.setup', refresh });
    if (request === latestSetup) merge({ helper, setup, loaded: true });
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

export function startPolling(): void {
  if (started || headlessRender) return;
  started = true;
  void refreshPanelState();
  void checkWorkerBuild();
  void refreshSetup(true).then(refreshConversations);
  setInterval(() => void refreshPanelState(), 1_000);
  setInterval(() => void refreshSetup(), 3_000);
  // Only an answer that never came is asked again.
  setInterval(() => void (live.build === undefined ? checkWorkerBuild() : undefined), 3_000);
  setInterval(() => void refreshConversations(), 2_000);
  chrome.tabs?.onActivated?.addListener(() => void refreshPanelState());
  chrome.tabs?.onUpdated?.addListener(() => void refreshPanelState());
}

export function applyHeadlessState(state: { currentTab?: PanelTab; pending: PermissionPrompt[]; sites: StoredSitePermission[]; sessions?: StoredSession[]; autoAllowed?: AutoAllowed[] }): void {
  const next: Partial<LiveState> = { prompts: state.pending, sites: state.sites, sessions: state.sessions ?? [], autoAllowed: state.autoAllowed ?? [], loaded: true };
  if (state.currentTab !== undefined) next.currentTab = state.currentTab;
  merge(next);
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
