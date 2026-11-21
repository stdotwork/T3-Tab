import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';

import {
  DEFAULT_DAEMON_PORT,
  PROTOCOL_VERSION,
  type BrowserMessage,
  type BrowserStatus,
  type ControlResponse,
} from '@t3-tab/protocol';
import { WebSocket, WebSocketServer, type RawData } from 'ws';

import { connectionRole, tokensMatch, isLoopbackHostHeader, type ConnectionRole } from './security.js';
import { clearDaemonState, writeDaemonState, type DaemonState } from './state.js';

export interface DaemonOptions {
  port?: number;
  stateDir?: string;
}

export interface DaemonHandle {
  readonly port: number;
  readonly token: string;
  readonly state: DaemonState;
  close(): Promise<void>;
}

const MAX_MESSAGE_BYTES = 1_024_000;

export async function startDaemon(options: DaemonOptions): Promise<DaemonHandle> {
  if (options.stateDir === undefined) throw new Error('A state directory is required');
  const stateDir = options.stateDir;
  const token = randomBytes(32).toString('base64url');
  const roles = new WeakMap<IncomingMessage, ConnectionRole>();
  const browsers = new Map<WebSocket, BrowserStatus>();
  const httpServer = createServer((request, response) => handleHttpRequest(request, response, token));
  const sockets = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });

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
    sockets.handleUpgrade(request, socket, head, (webSocket) => {
      sockets.emit('connection', webSocket, request);
    });
  });

  sockets.on('connection', (webSocket, request) => {
    const role = roles.get(request);
    if (role === 'extension') {
      browsers.set(webSocket, {
        id: `pending-${randomUUID()}`,
        name: 'Chromium',
        tabCount: 0,
      });
    }

    webSocket.on('message', (data) => {
      if (role === 'extension') handleBrowserMessage(webSocket, browsers, data);
      else if (role === 'control') handleControlMessage(webSocket, browsers, data);
    });
    webSocket.on('close', () => browsers.delete(webSocket));
    webSocket.on('error', () => browsers.delete(webSocket));
  });

  await listen(httpServer, options.port ?? DEFAULT_DAEMON_PORT);
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

function handleBrowserMessage(webSocket: WebSocket, browsers: Map<WebSocket, BrowserStatus>, data: RawData): void {
  const value = parseJson(data);
  if (!isBrowserMessage(value)) {
    webSocket.close(1008, 'Invalid protocol message');
    return;
  }

  const message = value;
  const browser = browsers.get(webSocket);
  if (browser === undefined) return;
  if (message.type === 'browser.hello') {
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

function handleControlMessage(webSocket: WebSocket, browsers: Map<WebSocket, BrowserStatus>, data: RawData): void {
  const value = parseJson(data);
  if (!isControlRequest(value)) {
    sendControlError(webSocket, null, 'Invalid control request');
    return;
  }

  const request = value;
  if (request.method !== 'status') {
    sendControlError(webSocket, request.requestId, `Unknown method: ${String(request.method)}`);
    return;
  }
  const response: ControlResponse = {
    type: 'control.response',
    protocolVersion: PROTOCOL_VERSION,
    requestId: request.requestId,
    ok: true,
    result: { browsers: [...browsers.values()] },
  };
  webSocket.send(JSON.stringify(response));
}

function isBrowserMessage(value: unknown): value is BrowserMessage {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return candidate.protocolVersion === PROTOCOL_VERSION && (candidate.type === 'browser.hello' || candidate.type === 'browser.tabCount');
}

function isControlRequest(value: unknown): value is {
  type: 'control.request';
  protocolVersion: typeof PROTOCOL_VERSION;
  requestId: string;
  method: string;
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

async function closeServer(server: ReturnType<typeof createServer>, sockets: WebSocketServer): Promise<void> {
  for (const socket of sockets.clients) socket.terminate();
  await new Promise<void>((resolve) => {
    sockets.close(() => resolve());
  });
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
