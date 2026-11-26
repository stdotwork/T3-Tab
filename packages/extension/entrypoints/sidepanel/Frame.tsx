/** What the panel's screens share: where they can go, the top bar, the connection banner and the model catalog. */
import type { ToolSession } from '@t3-tab/protocol';
import { AlertCircle, PanelLeft, Settings as SettingsIcon, SquarePen, X } from 'lucide-react';
import { Fragment, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';

import type { SettingsTab } from './Settings';
import { helperNote } from './Setup';
import { panel } from './lib/api';
import { directProviders, t3Providers, type PickerProvider } from './lib/catalog';
import type { LiveState } from './lib/store';
import { t3, type T3State } from './lib/t3-client';
import { needsOwner, nextWake, threadSections, type DirectRun } from './lib/thread-sections';
import { ICON, IconButton, useInkAlign } from './ui';

export type Screen =
  | { name: 'home' }
  | { name: 'thread'; id: string; source: 't3' | 'direct' }
  | { name: 'threads' }
  | { name: 'settings'; tab: SettingsTab; connections?: boolean };

export const useT3 = (): T3State => useSyncExternalStore(t3.subscribe, t3.snapshot);

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

/** The direct Claude Code and Codex runs; a run through T3 is listed as its T3 thread. */
export const directRuns = (live: LiveState): DirectRun[] =>
  live.conversations
    .filter((conversation) => conversation.via !== 't3')
    .map((conversation) => ({
      id: conversation.id,
      title: conversation.title,
      status: conversation.status,
      updatedAt: conversation.updatedAt,
      ...(conversation.startedAt === undefined ? {} : { startedAt: conversation.startedAt }),
      ...(conversation.finishedAt === undefined ? {} : { finishedAt: conversation.finishedAt }),
    }));

/** The time the threads are grouped at. It draws again when a snoozed thread is due to wake, as T3's sidebar does. */
export function useWakeClock(state: T3State): number {
  const [, setTick] = useState(0);
  const now = Date.now();
  const wake = nextWake(state.threads, now);
  useEffect(() => {
    if (wake === undefined) return;
    const timer = setTimeout(() => setTick((tick) => tick + 1), Math.max(0, wake - Date.now()) + 50);
    return () => clearTimeout(timer);
  }, [wake]);
  return now;
}

/** Whether any thread waits on the owner's approval or answer: the one thread signal outside the list. */
export function useNeedsOwner(live: LiveState, state: T3State): boolean {
  const now = useWakeClock(state);
  return needsOwner(threadSections(state.threads, directRuns(live), now));
}

/** The button that opens the thread list, T3's sidebar toggle, with the dot that says a session or a thread needs a look. */
export interface ThreadsToggle {
  onClick: () => void;
  /** The thread list is the screen showing, so the button closes it. */
  open?: boolean;
  sessions?: number;
  /** A thread waits on the owner's approval or answer. */
  needsYou?: boolean;
}

/**
 * Every screen's top bar, in T3 Code's anatomy: on the screens T3 draws beside its sidebar, the sidebar toggle at the
 * left (here it opens the thread list); then the breadcrumb, its parents muted and the current page last; then the
 * screen's icon buttons at the right. Settings and the theme sheets have no toggle, as T3's settings and dialogs have
 * none, and end in Close. One height, one inset and one icon size for all of them.
 */
export function Bar({ crumbs, threads, actions, chat = false }: { crumbs: readonly ReactNode[]; threads?: ThreadsToggle; actions: ReactNode; chat?: boolean }): ReactNode {
  const bar = useInkAlign<HTMLElement>({ edges: true });
  const parents = crumbs.slice(0, -1);
  return (
    <header className="topbar" data-bar data-chat-header={chat ? '' : undefined} ref={bar}>
      {threads === undefined ? null : <ThreadsButton {...threads} />}
      <nav className="crumbs" aria-label="Breadcrumb">
        <ol>
          {parents.map((crumb, index) => (
            <Fragment key={index}>
              <li className="crumb-muted">{crumb}</li>
              <li className="sep" aria-hidden="true">
                /
              </li>
            </Fragment>
          ))}
          <li className="crumb-current" aria-current="page">
            {crumbs.at(-1)}
          </li>
        </ol>
      </nav>
      <span className="topbar-spacer" />
      {actions}
    </header>
  );
}

function ThreadsButton({ onClick, open = false, sessions = 0, needsYou = false }: ThreadsToggle): ReactNode {
  const label = [needsYou ? 'a thread needs you' : undefined, sessions === 0 ? undefined : `${sessions} using the browser`].filter((part) => part !== undefined).join(', ');
  const name = open ? 'Close threads' : 'Threads';
  return (
    <IconButton label={label === '' ? name : `${name}, ${label}`} id="btn-threads" aria-pressed={open} onClick={onClick}>
      <PanelLeft size={ICON.md} />
      {needsYou ? <span className="needs-you-dot" aria-hidden="true" /> : sessions === 0 ? null : <span className="session-dot" aria-hidden="true" />}
    </IconButton>
  );
}

/** The bar of the screens that hold a composer: the thread list, the breadcrumb, then New thread and Settings. */
export function TopBar({
  crumbs,
  onThreads,
  onNew,
  onSettings,
  sessions = 0,
  needsYou = false,
}: {
  crumbs: readonly ReactNode[];
  onThreads: () => void;
  onNew?: () => void;
  onSettings: () => void;
  sessions?: number;
  needsYou?: boolean;
}): ReactNode {
  return <Bar chat crumbs={crumbs} threads={{ onClick: onThreads, sessions, needsYou }} actions={<BarActions onNew={onNew} onSettings={onSettings} />} />;
}

/** New thread and Settings, at the right of every bar that carries the thread toggle. */
export function BarActions({ onNew, onSettings }: { onNew?: (() => void) | undefined; onSettings: () => void }): ReactNode {
  return (
    <>
      <IconButton label="New thread" id="btn-new" disabled={onNew === undefined} onClick={onNew}>
        <SquarePen size={ICON.md} />
      </IconButton>
      <IconButton label="Settings" id="btn-settings" onClick={onSettings}>
        <SettingsIcon size={ICON.md} />
      </IconButton>
    </>
  );
}

/** Close, the last control of the Settings bar and of a sheet's. */
export function CloseButton({ label, id, onClick }: { label: string; id?: string; onClick: () => void }): ReactNode {
  return (
    <IconButton label={label} id={id} onClick={onClick}>
      <X size={ICON.md} />
    </IconButton>
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
      <AlertCircle size={ICON.sm} aria-hidden="true" />
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
