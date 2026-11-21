import { randomUUID } from 'node:crypto';

import {
  PROTOCOL_VERSION,
  type BrowserMethod,
  type BrowserMethods,
  type BrowserRequestMessage,
  type BrowserResponseMessage,
  type BrowserStatus,
  type ToolSession,
} from '@t3-tab/protocol';
import type { WebSocket } from 'ws';

import { TabState } from './reader/page.js';

const REQUEST_TIMEOUT_MS = 30_000;
const ACT_REQUEST_TIMEOUT_MS = 300_000;
const MAX_TABS_HELD = 200;

/** What the tool code needs from a browser: ask it something, and look up what is held for a tab. */
export interface BrowserLink {
  request<M extends BrowserMethod>(
    session: ToolSession,
    method: M,
    params: BrowserMethods[M]['params'],
  ): Promise<BrowserMethods[M]['result']>;
  tabState(tabId: number): TabState;
  forgetTab(tabId: number): void;
}

interface Pending {
  resolve(result: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

/** One connected browser: its socket, what it reported about itself, and the requests waiting on it. */
export class BrowserConnection implements BrowserLink {
  readonly status: BrowserStatus;
  private readonly pending = new Map<string, Pending>();
  private readonly tabs = new Map<number, TabState>();

  constructor(private readonly socket: WebSocket) {
    this.status = { id: `pending-${randomUUID()}`, name: 'Chromium', tabCount: 0 };
  }

  request<M extends BrowserMethod>(
    session: ToolSession,
    method: M,
    params: BrowserMethods[M]['params'],
  ): Promise<BrowserMethods[M]['result']> {
    if (this.socket.readyState !== this.socket.OPEN) return Promise.reject(new Error('The browser is not connected'));
    const requestId = randomUUID();
    const message = {
      type: 'browser.request',
      protocolVersion: PROTOCOL_VERSION,
      requestId,
      method,
      session,
      params,
    } as BrowserRequestMessage;
    return new Promise((resolve, reject) => {
      const timeoutMs = method === 'page.act' ? ACT_REQUEST_TIMEOUT_MS : REQUEST_TIMEOUT_MS;
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`The browser did not answer ${method} within ${timeoutMs / 1_000} seconds`));
      }, timeoutMs);
      this.pending.set(requestId, { resolve: resolve as (result: unknown) => void, reject, timer });
      this.socket.send(JSON.stringify(message), (error?: Error | null) => {
        if (error === undefined || error === null) return;
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(error);
      });
    });
  }

  handleResponse(message: BrowserResponseMessage): void {
    const waiting = this.pending.get(message.requestId);
    if (waiting === undefined) return;
    this.pending.delete(message.requestId);
    clearTimeout(waiting.timer);
    if (message.ok) waiting.resolve(message.result);
    else waiting.reject(new Error(message.error));
  }

  /** Fails everything still waiting; called when the browser goes away. */
  close(): void {
    for (const waiting of this.pending.values()) {
      clearTimeout(waiting.timer);
      waiting.reject(new Error('The browser disconnected'));
    }
    this.pending.clear();
    this.tabs.clear();
  }

  tabState(tabId: number): TabState {
    let state = this.tabs.get(tabId);
    if (state === undefined) {
      if (this.tabs.size >= MAX_TABS_HELD) {
        const oldest = this.tabs.keys().next().value;
        if (oldest !== undefined) this.tabs.delete(oldest);
      }
      state = new TabState();
      this.tabs.set(tabId, state);
    }
    return state;
  }

  forgetTab(tabId: number): void {
    this.tabs.delete(tabId);
  }
}
