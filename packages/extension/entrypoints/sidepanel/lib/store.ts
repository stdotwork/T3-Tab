/** The panel's live state from the extension: the helper link, setup, the current tab, prompts and direct runs. */
import type { AgentConversation, T3State as T3RunState } from '@t3-tab/protocol';
import { useEffect, useState, useSyncExternalStore } from 'react';

import type { PermissionPrompt, StoredSitePermission } from '../../../src/permissions';
import type { PanelTab } from '../../../src/panel';
import { panel, readStored, writeStored } from './api';
import type { SetupAgent } from './catalog';

export interface HelperState {
  connected: boolean;
  error?: string;
  protocolMismatch?: boolean;
}

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

export interface LiveState {
  loaded: boolean;
  helper: HelperState;
  setup?: SetupState;
  currentTab?: PanelTab;
  prompts: PermissionPrompt[];
  sites: StoredSitePermission[];
  autoAllowed: AutoAllowed[];
  conversations: AgentConversation[];
}

let live: LiveState = { loaded: false, helper: { connected: false }, prompts: [], sites: [], autoAllowed: [], conversations: [] };
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
    const state = await panel<{ currentTab?: PanelTab; pending: PermissionPrompt[]; sites: StoredSitePermission[]; autoAllowed?: AutoAllowed[] }>({
      type: 'panel.state',
      ...(fixedTabId === undefined ? {} : { tabId: fixedTabId }),
    });
    const next: Partial<LiveState> = { prompts: state.pending, sites: state.sites, autoAllowed: state.autoAllowed ?? [] };
    if (state.currentTab !== undefined) next.currentTab = state.currentTab;
    merge(next);
  } catch {
    // The worker can be restarting. The next poll tries again.
  }
}

export async function refreshSetup(refresh = false): Promise<void> {
  try {
    const helper = await panel<HelperState>({ type: 'panel.helper' });
    if (!helper.connected) {
      merge({ helper, loaded: true });
      return;
    }
    const setup = await panel<SetupState>({ type: 'panel.setup', refresh });
    merge({ helper, setup, loaded: true });
  } catch (error) {
    merge({ helper: { connected: false, error: error instanceof Error ? error.message : String(error) }, loaded: true });
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

let started = false;

export function startPolling(): void {
  if (started || headlessRender) return;
  started = true;
  void refreshPanelState();
  void refreshSetup(true).then(refreshConversations);
  setInterval(() => void refreshPanelState(), 1_000);
  setInterval(() => void refreshSetup(), 3_000);
  setInterval(() => void refreshConversations(), 1_000);
  chrome.tabs?.onActivated?.addListener(() => void refreshPanelState());
  chrome.tabs?.onUpdated?.addListener(() => void refreshPanelState());
}

export function applyHeadlessState(state: { currentTab?: PanelTab; pending: PermissionPrompt[]; sites: StoredSitePermission[]; autoAllowed?: AutoAllowed[] }): void {
  const next: Partial<LiveState> = { prompts: state.pending, sites: state.sites, autoAllowed: state.autoAllowed ?? [], loaded: true };
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
