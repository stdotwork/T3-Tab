/** The panel's one way to connect to T3 Code, and whether it does so by itself or waits for the owner's Connect. */
import { useCallback, useEffect, useState } from 'react';

import { errorText } from './api';
import type { LiveState } from './store';
import { t3, type T3State } from './t3-client';

/**
 * Whether the panel connects to T3 Code by itself once the helper finds T3 running on this machine, with no Connect
 * click. The owner decided it is on. A panel connects once per panel page, so a failed pairing leaves the Connect row
 * with its note and a Disconnect holds until the panel is opened again.
 */
export const CONNECT_T3_BY_ITSELF = true;

/** Pairs this panel with the T3 Code the helper found. Every Connect, by click or by itself, goes through here. */
export const connectT3 = async (): Promise<void> => await t3.pair();

let triedByItself = false;

/** Whether the panel should connect by itself now: on, T3 running, no session held or being made, and not tried yet. */
export function shouldConnectByItself(input: { enabled: boolean; found: string | undefined; status: T3State['status']; tried: boolean }): boolean {
  return input.enabled && !input.tried && input.found === 'running' && input.status === 'off';
}

export interface T3Connect {
  /** T3 is running and this panel is not connected to it: the screen offers Connect. */
  offered: boolean;
  busy: boolean;
  error?: string;
  connect: () => void;
}

/** The new-thread screen's T3 Code connection: connects by itself when that is on, and offers Connect otherwise. */
export function useT3Connect(live: LiveState, state: T3State): T3Connect {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const found = live.helper.connected ? live.setup?.t3.state : undefined;
  const connect = useCallback((): void => {
    setBusy(true);
    setError(undefined);
    void connectT3()
      .catch((failure: unknown) => setError(errorText(failure)))
      .finally(() => setBusy(false));
  }, []);
  useEffect(() => {
    if (!shouldConnectByItself({ enabled: CONNECT_T3_BY_ITSELF, found, status: state.status, tried: triedByItself })) return;
    triedByItself = true;
    connect();
  }, [found, state.status, connect]);
  const offered = found === 'running' && state.status !== 'ready' && state.status !== 'lost';
  return { offered, busy: busy || state.status === 'connecting', connect, ...(error === undefined ? (state.error === undefined ? {} : { error: state.error }) : { error }) };
}
