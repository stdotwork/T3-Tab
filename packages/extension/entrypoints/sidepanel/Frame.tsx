/** What the panel's screens share: where they can go, the top bar, the connection banner and the model catalog. */
import type { ToolSession } from '@t3-tab/protocol';
import { AlertCircle, History, Settings as SettingsIcon, SquarePen } from 'lucide-react';
import { useMemo, useSyncExternalStore, type ReactNode } from 'react';

import type { SettingsTab } from './Settings';
import { helperNote } from './Setup';
import { panel } from './lib/api';
import { directProviders, t3Providers, type PickerProvider } from './lib/catalog';
import type { LiveState } from './lib/store';
import { t3, type T3State } from './lib/t3-client';
import { IconButton } from './ui';

export type Screen =
  | { name: 'home' }
  | { name: 'thread'; id: string; source: 't3' | 'direct' }
  | { name: 'threads' }
  | { name: 'settings'; tab: SettingsTab; connections?: boolean };

export const useT3 = (): T3State => useSyncExternalStore(t3.subscribe, t3.snapshot);

const RUNNING_STATUSES = new Set(['preparing', 'queued', 'starting', 'running']);
export const isRunningStatus = (status: string | undefined): boolean => status !== undefined && RUNNING_STATUSES.has(status);

export const withdrawClaim = async (code: string): Promise<void> => {
  await panel({ type: 'panel.t3ClaimRevoke', code }).catch(() => undefined);
};

/** Ties a claim to the thread that carries it. If that fails the thread still runs, without the tabs. */
export const bindClaim = async (code: string, threadId: string): Promise<void> => {
  await panel({ type: 'panel.t3ClaimBind', code, threadId }).catch(async () => await withdrawClaim(code));
};

const CLIENT_NAMES: Record<string, string> = { 'claude-code': 'Claude Code', 'codex-mcp-client': 'Codex', codex: 'Codex', t3code: 'T3 Code' };

/** An MCP client's name for people: `claude-code · 1e2fb543` is Claude Code. */
export function clientName(sessionName: string): string {
  const client = sessionName.split(' · ')[0]?.trim() ?? sessionName;
  return CLIENT_NAMES[client] ?? client;
}

/** Who a card or row names: the T3 thread's title when the session is known to run for one, else the agent. */
export const askerName =
  (live: LiveState, state: T3State) =>
  (session: ToolSession): string => {
    const threadId = live.sessions.find((entry) => entry.id === session.id)?.t3ThreadId;
    return state.threads.find((thread) => thread.id === threadId)?.title ?? clientName(session.name);
  };

export function TopBar({ title, onThreads, onNew, onSettings, sessions = 0 }: { title: ReactNode; onThreads: () => void; onNew?: () => void; onSettings: () => void; sessions?: number }): ReactNode {
  return (
    <header className="topbar" data-chat-header>
      <IconButton label={sessions === 0 ? 'Threads' : `Threads, ${sessions} using the browser`} id="btn-threads" onClick={onThreads}>
        <History size={16} />
        {sessions === 0 ? null : <span className="session-dot" aria-hidden="true" />}
      </IconButton>
      <span className="crumbs">{title}</span>
      <span className="topbar-spacer" />
      <IconButton label="New thread" id="btn-new" disabled={onNew === undefined} onClick={onNew}>
        <SquarePen size={16} />
      </IconButton>
      <IconButton label="Settings" id="btn-settings" onClick={onSettings}>
        <SettingsIcon size={16} />
      </IconButton>
    </header>
  );
}

export function Banner({ live, state, onConnections }: { live: LiveState; state: T3State; onConnections: () => void }): ReactNode {
  let text: string | undefined;
  if (live.build === 'stuck') text = 'This extension is still an old build. Reload it on the extensions page.';
  else if (!live.helper.connected) text = `The T3-Tab helper is not connected: ${helperNote(live).short}.`;
  else if (state.status === 'lost') text = 'Reconnecting to T3 Code…';
  if (text === undefined) return null;
  return (
    <button type="button" className="banner" onClick={onConnections}>
      <AlertCircle size={13} aria-hidden="true" />
      {text}
    </button>
  );
}

export interface Catalog {
  source: 't3' | 'direct';
  providers: PickerProvider[];
  /** Why threads are not going through T3 Code although it is connected. */
  note?: string;
}

export function useCatalog(live: LiveState, state: T3State): Catalog {
  return useMemo(() => {
    if (state.status === 'ready') {
      const providers = t3Providers(state);
      if (providers.length > 0) return { source: 't3', providers };
    }
    const providers = directProviders(live.setup?.agents ?? []);
    if (state.status !== 'ready') return { source: 'direct', providers };
    const names = providers.map((provider) => provider.name).join(' or ');
    return { source: 'direct', providers, note: names === '' ? 'T3 Code has no usable provider, and no agent was found on this machine.' : `T3 Code has no usable provider, so threads run with ${names} directly.` };
  }, [state, live.setup]);
}
