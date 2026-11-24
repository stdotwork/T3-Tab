/** The agents using the browser right now, named by their thread, with the current tab's share control. */
import { useState, type ReactNode } from 'react';

import { askerName, clientName, type Screen } from './Frame';
import { errorText, panel } from './lib/api';
import { refreshPanel, type LiveState } from './lib/store';
import type { T3State } from './lib/t3-client';

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
          const tabs = count === 0 ? 'No shared tabs' : count === 1 ? '1 shared tab' : `${count} shared tabs`;
          const who = clientName(session.name);
          return (
            <li key={session.id}>
              <span className="session-live" aria-hidden="true" />
              {thread === undefined ? (
                <span className="session-text">
                  <strong>{name}</strong>
                  <small>{tabs}</small>
                </span>
              ) : (
                <button type="button" className="session-text" onClick={() => onOpen({ name: 'thread', id: thread.id, source: 't3' })}>
                  <strong>{name}</strong>
                  <small>
                    {who} · {tabs}
                  </small>
                </button>
              )}
              {shared || shareable ? (
                <button type="button" className="row-btn" onClick={() => void toggle(session.id, shared)}>
                  {shared ? 'Stop sharing this tab' : 'Share this tab'}
                </button>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
