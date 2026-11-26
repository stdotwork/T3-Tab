import {
  NATIVE_HOST_NAME,
  PROTOCOL_VERSION,
  type BrowserHelloMessage,
  type BrowserPingMessage,
  type BrowserRequestMessage,
  type BrowserResponseMessage,
  type BrowserTabClosedMessage,
  type BrowserTabCountMessage,
  type NativeDaemonRequest,
  type NativeResponse,
} from '@t3-tab/protocol';
import { defineBackground } from 'wxt/utils/define-background';

import { initCdp } from '../src/cdp';
import { handleDaemonReply, noteDaemonClose, noteDaemonProblem, noteSocketClosed, setDaemonConnector, setDaemonSocket } from '../src/daemon-link';
import { handlePanelRequest } from '../src/panel';
import { isSidePanelSender } from '../src/panel-security';
import { forgetPanelTab, keepPanelOnItsTab, openPanelOn } from '../src/panel-tab';
import { originOf } from '../src/permissions';
import { handleRequest } from '../src/requests';
import { sessionStore } from '../src/runtime';
import { forgetSecrets } from '../src/secret-text';
import { adoptPopupTab } from '../src/tabs';

const browserId = crypto.randomUUID();
const browserName = navigator.userAgent.includes('Brave') ? 'Brave' : 'Chromium';

export default defineBackground(() => {
  let socket: WebSocket | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let keepaliveTimer: ReturnType<typeof setInterval> | undefined;
  let reconnectAttempt = 0;
  let connecting = false;

  const reportTabCount = (): void => {
    if (socket?.readyState !== WebSocket.OPEN) return;
    chrome.tabs.query({}, (tabs: unknown[]) => {
      if (chrome.runtime.lastError !== undefined || socket?.readyState !== WebSocket.OPEN) return;
      const message: BrowserTabCountMessage = {
        type: 'browser.tabCount',
        protocolVersion: PROTOCOL_VERSION,
        tabCount: tabs.length,
      };
      socket.send(JSON.stringify(message));
    });
  };

  const reportTabClosed = (tabId: number): void => {
    if (socket?.readyState !== WebSocket.OPEN) return;
    const message: BrowserTabClosedMessage = { type: 'browser.tabClosed', protocolVersion: PROTOCOL_VERSION, tabId };
    socket.send(JSON.stringify(message));
  };

  const answer = async (current: WebSocket, request: BrowserRequestMessage): Promise<void> => {
    let response: BrowserResponseMessage;
    try {
      const result = await handleRequest(request);
      response = { type: 'browser.response', protocolVersion: PROTOCOL_VERSION, requestId: request.requestId, ok: true, result };
    } catch (error) {
      response = {
        type: 'browser.response',
        protocolVersion: PROTOCOL_VERSION,
        requestId: request.requestId,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    if (current.readyState === WebSocket.OPEN) current.send(JSON.stringify(response));
  };

  const clearKeepalive = (): void => {
    if (keepaliveTimer !== undefined) clearInterval(keepaliveTimer);
    keepaliveTimer = undefined;
  };

  const scheduleReconnect = (): void => {
    clearKeepalive();
    socket = undefined;
    if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
    const delay = Math.min(30_000, 500 * 2 ** Math.min(reconnectAttempt, 6)) + Math.random() * 250;
    reconnectAttempt += 1;
    reconnectTimer = setTimeout(() => void connect(), delay);
  };

  const connect = async (): Promise<void> => {
    if (connecting || (socket !== undefined && socket.readyState <= WebSocket.OPEN)) return;
    connecting = true;
    try {
      const configuration = await nativeConfiguration();
      const url = new URL(`ws://127.0.0.1:${configuration.port}/`);
      url.searchParams.set('token', configuration.token);
      const current = new WebSocket(url);
      socket = current;
      let wasOpen = false;
      current.addEventListener('open', () => {
        wasOpen = true;
        reconnectAttempt = 0;
        setDaemonSocket(current);
        const hello: BrowserHelloMessage = {
          type: 'browser.hello',
          protocolVersion: PROTOCOL_VERSION,
          browserId,
          browserName,
        };
        current.send(JSON.stringify(hello));
        reportTabCount();
        clearKeepalive();
        keepaliveTimer = setInterval(() => {
          if (socket !== current || current.readyState !== WebSocket.OPEN) return;
          const ping: BrowserPingMessage = { type: 'browser.ping', protocolVersion: PROTOCOL_VERSION };
          current.send(JSON.stringify(ping));
        }, 20_000);
      });
      current.addEventListener('message', (event) => {
        const value = parseMessage(event.data);
        if (handleDaemonReply(value)) return;
        const request = parseRequest(value);
        if (request !== undefined) void answer(current, request);
      });
      current.addEventListener('close', (event) => {
        if (socket === current) {
          noteDaemonClose(event.code, event.reason);
          noteSocketClosed(event.code, event.reason, wasOpen);
        }
        if (socket === current) setDaemonSocket(undefined);
        if (socket === current) scheduleReconnect();
        else clearKeepalive();
      });
      current.addEventListener('error', () => {
        if (socket === current) current.close();
      });
    } catch (error) {
      noteDaemonProblem(error);
      scheduleReconnect();
    } finally {
      connecting = false;
    }
  };

  setDaemonConnector(() => void connect());
  initCdp();
  // The headless harness cannot open a real side panel; it calls the same panel function from the worker.
  (globalThis as typeof globalThis & { __t3tabHandlePanelRequest?: typeof handlePanelRequest }).__t3tabHandlePanelRequest =
    handlePanelRequest;
  void keepPanelOnItsTab().catch(() => undefined);
  chrome.action.onClicked.addListener((tab) => {
    if (tab.id !== undefined) void openPanelOn(tab.id).catch(() => undefined);
  });
  chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
    if (!isSidePanelSender(sender, chrome.runtime.id)) {
      sendResponse({ ok: false, error: 'Forbidden' });
      return false;
    }
    void handlePanelRequest(message)
      .then((result) => sendResponse(result))
      .catch((error: unknown) =>
        sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }),
      );
    return true;
  });
  chrome.tabs.onCreated.addListener(() => reportTabCount());
  // The browser names the tab a new tab was opened from; only that tab's session may adopt it.
  chrome.webNavigation.onCreatedNavigationTarget.addListener((details) => {
    void adoptPopupTab(details.tabId, details.sourceTabId, sessionStore);
  });
  chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
    if (change.url === undefined) return;
    void sessionStore.observeTabOrigin(tabId, originOf(tab.url ?? change.url ?? ''));
  });
  chrome.tabs.onRemoved.addListener(reportTabCount);
  chrome.tabs.onRemoved.addListener(reportTabClosed);
  chrome.tabs.onRemoved.addListener((tabId) => void sessionStore.forgetTab(tabId));
  chrome.tabs.onRemoved.addListener((tabId) => forgetSecrets(tabId));
  chrome.tabs.onRemoved.addListener((tabId) => void forgetPanelTab(tabId).catch(() => undefined));
  chrome.tabs.onReplaced.addListener(reportTabCount);
  chrome.tabs.onAttached.addListener(reportTabCount);
  chrome.tabs.onDetached.addListener(reportTabCount);
  chrome.runtime.onStartup.addListener(() => void connect());
  chrome.runtime.onInstalled.addListener((details) => {
    void connect();
    // Once, on a fresh install: a tab of the extension's own whose one button opens the panel there, since a side panel
    // can only be opened from a click and a new extension's toolbar icon is hidden under the puzzle piece.
    if (details.reason === 'install') void chrome.tabs.create({ url: chrome.runtime.getURL('/welcome.html') }).catch(() => undefined);
  });
  void connect();
});

async function nativeConfiguration(): Promise<{ port: number; token: string }> {
  const request: NativeDaemonRequest = {
    type: 'native.daemon',
    protocolVersion: PROTOCOL_VERSION,
  };
  const response = await new Promise<NativeResponse>((resolve, reject) => {
    chrome.runtime.sendNativeMessage(NATIVE_HOST_NAME, request, (message: NativeResponse) => {
      const error = chrome.runtime.lastError;
      if (error !== undefined) reject(new Error(error.message));
      else resolve(message);
    });
  });
  if (response.type === 'native.error') throw new Error(response.error);
  if (response.protocolVersion !== PROTOCOL_VERSION) throw new Error('Native host protocol mismatch');
  return { port: response.port, token: response.token };
}

function parseMessage(data: unknown): unknown {
  if (typeof data !== 'string') return undefined;
  try {
    return JSON.parse(data);
  } catch {
    return undefined;
  }
}

function parseRequest(value: unknown): BrowserRequestMessage | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const candidate = value as Record<string, unknown>;
  if (candidate.type !== 'browser.request' || candidate.protocolVersion !== PROTOCOL_VERSION) return undefined;
  if (typeof candidate.requestId !== 'string' || typeof candidate.method !== 'string') return undefined;
  return value as BrowserRequestMessage;
}
