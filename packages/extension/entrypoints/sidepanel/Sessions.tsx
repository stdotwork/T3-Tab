/**
 * The agents using the browser right now, named by their thread, each with a toggle that shares the current tab with it.
 * T3's sidebar has no such section, so it sits at the foot of the thread list, where T3 keeps its own status, one slim
 * row per session, and leaves T3's list to start right under the search.
 */
import { Globe } from 'lucide-react';
import { useState, type ReactNode } from 'react';

import { askerName, clientName, type Screen } from './Frame';
import { errorText, panel } from './lib/api';
import { refreshPanel, type LiveState } from './lib/store';
import type { T3State } from './lib/t3-client';
import { ICON, IconButton } from './ui';

export function ActiveSessions({ live, state, onOpen }: { live: LiveState; state: T3State; onOpen: (screen: Screen) => void }): ReactNode {
  const [error, setError] = useState<string>();
  const tab = live.currentTab;
  const shareable = tab !== undefined && /^https?:/.test(tab.url);
  const nameOf = askerName(live, state);
  const toggle = async (sessionId: string, shared: boolean): Promise<void> => {
    if (tab === undefined) return;
    setError(undefined);
    try {
      await panel({ type: shared ? 'panel.unshareTab' : 'panel.shareTab', sessionId, tabId: tab.id });
      await refreshPanel();
    } catch (failure) {
      setError(errorText(failure));
    }
  };
  if (live.sessions.length === 0) return null;
  return (
    <section className="sessions" aria-label="Using the browser">
      <h2>Using the browser</h2>
      {error === undefined ? null : <p className="error-line">{error}</p>}
      <ul id="connected-sessions">
        {live.sessions.map((session) => {
          const shared = tab !== undefined && session.sharedTabIds.includes(tab.id);
          const count = session.sharedTabIds.length;
          const thread = state.threads.find((entry) => entry.id === session.t3ThreadId);
          const name = nameOf(session);
          const tabs = count === 0 ? 'no tabs' : count === 1 ? '1 tab' : `${count} tabs`;
          const who = clientName(session.name);
          const meta = thread === undefined ? tabs : `${who} · ${tabs}`;
          return (
            <li key={session.id}>
              <span className="session-live" aria-hidden="true" />
              {thread === undefined ? (
                <span className="session-text" title={`${name} · ${meta}`}>
                  <strong>{name}</strong>
                  <small>{meta}</small>
                </span>
              ) : (
                <button type="button" className="session-text" title={`${name} · ${meta}`} onClick={() => onOpen({ name: 'thread', id: thread.id, source: 't3' })}>
                  <strong>{name}</strong>
                  <small>{meta}</small>
                </button>
              )}
              {shared || shareable ? (
                <IconButton label={shared ? `Stop sharing this tab with ${name}` : `Share this tab with ${name}`} aria-pressed={shared} className="icon-btn session-share" onClick={() => void toggle(session.id, shared)}>
                  <Globe size={ICON.sm} />
                </IconButton>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
