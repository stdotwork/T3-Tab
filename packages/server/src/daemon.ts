import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';

import {
  DEFAULT_DAEMON_PORT,
  PROTOCOL_VERSION,
  type BrowserMessage,
  type BrowserPongMessage,
  type ControlResponse,
  type ToolMethod,
  type ToolSession,
} from '@t3-tab/protocol';
import { WebSocket, WebSocketServer, type RawData } from 'ws';

import { BrowserConnection } from './browser-link.js';
import { connectionRole, tokensMatch, isLoopbackHostHeader, type ConnectionRole } from './security.js';
import { clearDaemonState, writeDaemonState, type DaemonState } from './state.js';
import { runTool } from './tools.js';

export interface DaemonOptions {
  /** A port the caller asked for. When omitted, the default port is tried first, then any free loopback port. */
  port?: number | undefined;
  stateDir?: string;
}

export interface DaemonHandle {
  readonly port: number;
  readonly token: string;
  readonly state: DaemonState;
  close(): Promise<void>;
}

const MAX_CONTROL_MESSAGE_BYTES = 1_024_000;
// A page's accessibility tree and a screenshot come back from the browser in one message.
const MAX_BROWSER_MESSAGE_BYTES = 16 * 1_024 * 1_024;
const TOOL_METHODS: ReadonlySet<string> = new Set<ToolMethod>(['tabs', 'read', 'screenshot', 'act', 'run_js']);

export async function startDaemon(options: DaemonOptions): Promise<DaemonHandle> {
  if (options.stateDir === undefined) throw new Error('A state directory is required');
  const stateDir = options.stateDir;
  const token = randomBytes(32).toString('base64url');
  const roles = new WeakMap<IncomingMessage, ConnectionRole>();
  const browsers = new Map<WebSocket, BrowserConnection>();
  const sessions = new Map<WebSocket, ToolSession>();
  const httpServer = createServer((request, response) => handleHttpRequest(request, response, token));
  const sockets = {
    extension: new WebSocketServer({ noServer: true, maxPayload: MAX_BROWSER_MESSAGE_BYTES }),
    control: new WebSocketServer({ noServer: true, maxPayload: MAX_CONTROL_MESSAGE_BYTES }),
  };

  httpServer.on('upgrade', (request, socket, head) => {
    const host = singleHeader(request.headers.host);
    if (!isLoopbackHostHeader(host)) {
      rejectUpgrade(socket, 403, 'Forbidden');
      return;
    }

    const url = requestUrl(request);
    if (!tokensMatch(token, requestToken(request, url))) {
      rejectUpgrade(socket, 401, 'Unauthorized');
      return;
    }

    const role = connectionRole(singleHeader(request.headers.origin));
    if (role === undefined) {
      rejectUpgrade(socket, 403, 'Forbidden');
      return;
    }

    roles.set(request, role);
    const server = sockets[role];
    server.handleUpgrade(request, socket, head, (webSocket) => {
      server.emit('connection', webSocket, request);
    });
  });

  const onConnection = (webSocket: WebSocket, request: IncomingMessage): void => {
    const role = roles.get(request);
    let connection: BrowserConnection | undefined;
    if (role === 'extension') {
      connection = new BrowserConnection(webSocket);
      browsers.set(webSocket, connection);
    }

    webSocket.on('message', (data) => {
      if (role === 'extension') handleBrowserMessage(webSocket, browsers, data);
      else if (role === 'control') handleControlMessage(webSocket, browsers, sessions, data);
    });
    const forget = (): void => {
      browsers.delete(webSocket);
      connection?.close();
      const session = sessions.get(webSocket);
      sessions.delete(webSocket);
      if (session !== undefined) {
        const live = [...browsers.values()].at(-1);
        if (live !== undefined) void live.request(session, 'session.unregister', {}).catch(() => undefined);
      }
    };
    webSocket.on('close', forget);
    webSocket.on('error', forget);
  };
  sockets.extension.on('connection', onConnection);
  sockets.control.on('connection', onConnection);

  await listenOnLoopback(httpServer, options.port);
  const address = httpServer.address();
  if (address === null || typeof address === 'string') {
    await closeHttpServer(httpServer);
    throw new Error('Daemon did not bind to a TCP address');
  }

  const state: DaemonState = {
    protocolVersion: PROTOCOL_VERSION,
    pid: process.pid,
    port: address.port,
    token,
  };
  try {
    await writeDaemonState(stateDir, state);
  } catch (error) {
    await closeServer(httpServer, sockets);
    throw error;
  }

  let closed = false;
  return {
    port: address.port,
    token,
    state,
    close: async () => {
      if (closed) return;
      closed = true;
      await clearDaemonState(stateDir, token);
      await closeServer(httpServer, sockets);
    },
  };
}

function handleHttpRequest(request: IncomingMessage, response: ServerResponse, token: string): void {
  if (!isLoopbackHostHeader(singleHeader(request.headers.host))) {
    sendJson(response, 403, { error: 'Forbidden host' });
    return;
  }
  const url = requestUrl(request);
  if (!tokensMatch(token, requestToken(request, url))) {
    sendJson(response, 401, { error: 'Unauthorized' });
    return;
  }
  if (request.method === 'GET' && url.pathname === '/health') {
    sendJson(response, 200, { ok: true });
    return;
  }
  sendJson(response, 404, { error: 'Not found' });
}

function handleBrowserMessage(
  webSocket: WebSocket,
  browsers: Map<WebSocket, BrowserConnection>,
  data: RawData,
): void {
  const value = parseJson(data);
  if (!isBrowserMessage(value)) {
    webSocket.close(1008, 'Invalid protocol message');
    return;
  }

  const message = value;
  const connection = browsers.get(webSocket);
  if (connection === undefined) return;
  const browser = connection.status;
  if (message.type === 'browser.response') {
    connection.handleResponse(message);
  } else if (message.type === 'browser.ping') {
    const pong: BrowserPongMessage = { type: 'browser.pong', protocolVersion: PROTOCOL_VERSION };
    webSocket.send(JSON.stringify(pong));
  } else if (message.type === 'browser.pong') {
    // The activity itself keeps the extension's service worker alive.
  } else if (message.type === 'browser.tabClosed') {
    if (Number.isInteger(message.tabId)) connection.forgetTab(message.tabId);
  } else if (message.type === 'browser.hello') {
    if (typeof message.browserId !== 'string' || typeof message.browserName !== 'string') {
      webSocket.close(1008, 'Invalid browser hello');
      return;
    }
    browser.id = message.browserId;
    browser.name = message.browserName;
  } else if (message.type === 'browser.tabCount') {
    if (!Number.isInteger(message.tabCount) || message.tabCount < 0) {
      webSocket.close(1008, 'Invalid tab count');
      return;
    }
    browser.tabCount = message.tabCount;
  }
}

function handleControlMessage(
  webSocket: WebSocket,
  browsers: Map<WebSocket, BrowserConnection>,
  sessions: Map<WebSocket, ToolSession>,
  data: RawData,
): void {
  const value = parseJson(data);
  if (!isControlRequest(value)) {
    sendControlError(webSocket, null, 'Invalid control request');
    return;
  }

  const request = value;
  if (request.method === 'session.register') {
    if (sessions.has(webSocket)) {
      sendControlError(webSocket, request.requestId, 'Control connection is already registered');
      return;
    }
    if (typeof request.clientName !== 'string' || request.clientName.length > 160) {
      sendControlError(webSocket, request.requestId, 'Invalid client name');
      return;
    }
    const id = randomUUID();
    const session: ToolSession = { id, name: makeSessionName(request.clientName, id) };
    sessions.set(webSocket, session);
    const connection = [...browsers.values()].at(-1);
    if (connection !== undefined) void connection.request(session, 'session.register', {}).catch(() => undefined);
    webSocket.send(
      JSON.stringify({
        type: 'control.response',
        protocolVersion: PROTOCOL_VERSION,
        requestId: request.requestId,
        ok: true,
        result: { session },
      } satisfies ControlResponse),
    );
    return;
  }
  if (request.method === 'status') {
    const response: ControlResponse = {
      type: 'control.response',
      protocolVersion: PROTOCOL_VERSION,
      requestId: request.requestId,
      ok: true,
      result: { browsers: [...browsers.values()].map((connection) => connection.status) },
    };
    webSocket.send(JSON.stringify(response));
    return;
  }
  if (!TOOL_METHODS.has(request.method)) {
    sendControlError(webSocket, request.requestId, `Unknown method: ${String(request.method)}`);
    return;
  }
  void answerTool(webSocket, browsers, sessions, request);
}

async function answerTool(
  webSocket: WebSocket,
  browsers: Map<WebSocket, BrowserConnection>,
  sessions: Map<WebSocket, ToolSession>,
  request: { requestId: string; method: string; session?: unknown; params?: unknown },
): Promise<void> {
  try {
    const registered = sessions.get(webSocket);
    if (registered === undefined) throw new Error('Session is not registered on this control connection');
    const claimed = validSession(request.session);
    if (claimed === undefined || claimed.id !== registered.id) {
      throw new Error('Session does not match this control connection');
    }
    if (typeof request.params !== 'object' || request.params === null || Array.isArray(request.params)) {
      throw new Error('Invalid params');
    }
    // The browser that connected last is the live one: an older socket may not have been cleaned up yet.
    const connection = [...browsers.values()].at(-1);
    if (connection === undefined) throw new Error('No browser is connected. Open the browser with the T3-Tab extension.');
    // Register only the session making this request. A new extension connection never learns other sessions.
    await connection.request(registered, 'session.register', {});
    const content = await runTool(connection, registered, request.method as ToolMethod, request.params as Record<string, unknown>);
    if (webSocket.readyState !== WebSocket.OPEN) return;
    const response: ControlResponse = {
      type: 'control.response',
      protocolVersion: PROTOCOL_VERSION,
      requestId: request.requestId,
      ok: true,
      result: { content },
    };
    webSocket.send(JSON.stringify(response));
  } catch (error) {
    if (webSocket.readyState === WebSocket.OPEN) {
      sendControlError(webSocket, request.requestId, error instanceof Error ? error.message : String(error));
    }
  }
}

function isBrowserMessage(value: unknown): value is BrowserMessage {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.protocolVersion === PROTOCOL_VERSION &&
    (candidate.type === 'browser.hello' ||
      candidate.type === 'browser.ping' ||
      candidate.type === 'browser.pong' ||
      candidate.type === 'browser.tabCount' ||
      candidate.type === 'browser.tabClosed' ||
      (candidate.type === 'browser.response' && typeof candidate.requestId === 'string' && typeof candidate.ok === 'boolean'))
  );
}

function isControlRequest(value: unknown): value is {
  type: 'control.request';
  protocolVersion: typeof PROTOCOL_VERSION;
  requestId: string;
  method: string;
  clientName?: unknown;
  session?: unknown;
  params?: unknown;
} {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.type === 'control.request' &&
    candidate.protocolVersion === PROTOCOL_VERSION &&
    typeof candidate.requestId === 'string' &&
    typeof candidate.method === 'string'
  );
}

export function makeSessionName(clientName: string, id: string): string {
  const visible = [...clientName]
    .map((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 32 || code === 127 ? ' ' : character;
    })
    .join('');
  const base = visible.replace(/\s+/g, ' ').trim().slice(0, 80) || 'MCP client';
  return `${base} · ${id.replace(/[^a-z0-9]/gi, '').slice(0, 8) || 'session'}`;
}

function validSession(value: unknown): ToolSession | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.id !== 'string' || candidate.id === '' || candidate.id.length > 128) return undefined;
  if (typeof candidate.name !== 'string' || candidate.name === '' || candidate.name.length > 160) return undefined;
  return { id: candidate.id, name: candidate.name };
}

function sendControlError(webSocket: WebSocket, requestId: string | null, error: string): void {
  const response: ControlResponse = {
    type: 'control.response',
    protocolVersion: PROTOCOL_VERSION,
    requestId,
    ok: false,
    error,
  };
  webSocket.send(JSON.stringify(response));
}

function parseJson(data: RawData): unknown {
  try {
    return JSON.parse(data.toString());
  } catch {
    return null;
  }
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function requestUrl(request: IncomingMessage): URL {
  return new URL(request.url ?? '/', 'http://127.0.0.1');
}

function requestToken(request: IncomingMessage, url: URL): string | undefined {
  const authorization = singleHeader(request.headers.authorization);
  if (authorization?.startsWith('Bearer ')) return authorization.slice('Bearer '.length);
  return url.searchParams.get('token') ?? undefined;
}

function rejectUpgrade(socket: Duplex, status: number, text: string): void {
  socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

/**
 * Binds the daemon to 127.0.0.1. A requested port must be free. Without a requested port, the default port is
 * tried first and port 0 (any free port) is used when the default is taken; clients read the real port from daemon.json.
 */
async function listenOnLoopback(server: ReturnType<typeof createServer>, requestedPort: number | undefined): Promise<void> {
  if (requestedPort !== undefined) {
    try {
      await listen(server, requestedPort);
    } catch (error) {
      if (isAddressInUse(error)) {
        throw new Error(`Port ${requestedPort} on 127.0.0.1 is already in use. Choose another port with --port or T3_TAB_PORT.`);
      }
      throw error;
    }
    return;
  }

  try {
    await listen(server, DEFAULT_DAEMON_PORT);
  } catch (error) {
    if (!isAddressInUse(error)) throw error;
    await listen(server, 0);
  }
}

function isAddressInUse(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === 'EADDRINUSE';
}

async function listen(server: ReturnType<typeof createServer>, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once('error', onError);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', onError);
      resolve();
    });
  });
}

async function closeServer(
  server: ReturnType<typeof createServer>,
  sockets: { extension: WebSocketServer; control: WebSocketServer },
): Promise<void> {
  for (const group of [sockets.extension, sockets.control]) {
    for (const socket of group.clients) socket.terminate();
    await new Promise<void>((resolve) => {
      group.close(() => resolve());
    });
  }
  await closeHttpServer(server);
}

async function closeHttpServer(server: ReturnType<typeof createServer>): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}
