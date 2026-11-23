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

/** Who a permission card names: the T3 thread's title when the session is known to run for one. */
export const askerName =
  (live: LiveState, state: T3State) =>
  (session: ToolSession): string => {
    const threadId = live.sessions.find((entry) => entry.id === session.id)?.t3ThreadId;
    return state.threads.find((thread) => thread.id === threadId)?.title ?? session.name;
  };

export function TopBar({ title, onThreads, onNew, onSettings }: { title: ReactNode; onThreads: () => void; onNew?: () => void; onSettings: () => void }): ReactNode {
  return (
    <header className="topbar" data-chat-header>
      <IconButton label="Threads" id="btn-threads" onClick={onThreads}>
        <History size={16} />
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
}

export function useCatalog(live: LiveState, state: T3State): Catalog {
  return useMemo(() => {
    if (state.status === 'ready') {
      const providers = t3Providers(state);
      if (providers.length > 0) return { source: 't3', providers };
    }
    return { source: 'direct', providers: directProviders(live.setup?.agents ?? []) };
  }, [state, live.setup]);
}
