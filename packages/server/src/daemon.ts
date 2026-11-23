import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_DAEMON_PORT,
  PROTOCOL_MISMATCH,
  PROTOCOL_VERSION,
  type BrowserDaemonRequestMessage,
  type BrowserPongMessage,
  type DaemonReplyMessage,
  type ToolSession,
} from '@t3-tab/protocol';
import { WebSocket, WebSocketServer, type RawData } from 'ws';

import { Agents } from './agents/conversations.js';
import { T3Access } from './agents/t3-access.js';
import { T3PanelPairing } from './agents/t3-pairing.js';
import { removeTemporaryCredentials } from './agents/t3-credential.js';
import { BrowserConnection } from './browser-link.js';
import { handleControlMessage, type ControlState } from './daemon-control.js';
import { isBrowserMessage, isOtherProtocolVersion, parseJson } from './daemon-messages.js';
import { browserPromptsGone, promptClosed, promptOpened } from './daemon-prompts.js';
import { connectionRole, tokensMatch, isLoopbackHostHeader, type ConnectionCredential, type ConnectionRole } from './security.js';
import { Setup } from './setup.js';
import { clearDaemonState, clearExtensionState, writeDaemonState, writeExtensionState, type DaemonState } from './state.js';

export interface DaemonOptions {
  /** A port the caller asked for. When omitted, the default port is tried first, then any free loopback port. */
  port?: number | undefined;
  stateDir?: string;
  /** The side panel's agent runs; tests pass their own. */
  agents?: Agents;
  /** The side panel's read-only T3 sign-in; tests pass their own. */
  t3Access?: T3Access;
  /** The panel's first-run steps; tests pass their own. */
  setup?: Setup;
  /** The panel's own T3 pairing; tests pass their own. */
  pairing?: T3PanelPairing;
}

export interface DaemonHandle {
  readonly port: number;
  /** The control token in `daemon.json`, which every MCP server reads. */
  readonly token: string;
  /** The extension's own token, in `extension.json`, which the native host passes to the extension. */
  readonly extensionToken: string;
  readonly state: DaemonState;
  close(): Promise<void>;
}

const MAX_CONTROL_MESSAGE_BYTES = 1_024_000;
// A page's accessibility tree and a screenshot come back from the browser in one message.
const MAX_BROWSER_MESSAGE_BYTES = 16 * 1_024 * 1_024;

export async function startDaemon(options: DaemonOptions): Promise<DaemonHandle> {
  if (options.stateDir === undefined) throw new Error('A state directory is required');
  const stateDir = options.stateDir;
  // A crash can leave a temporary copy of the T3 token. A failure here must not keep the browser tools from starting.
  await removeTemporaryCredentials(stateDir).catch(() => {
    process.stderr.write('T3-Tab could not remove a leftover temporary credential file from its state folder.\n');
  });
  const token = randomBytes(32).toString('base64url');
  const extensionToken = randomBytes(32).toString('base64url');
  const roles = new WeakMap<IncomingMessage, ConnectionRole>();
  const browsers = new Map<WebSocket, BrowserConnection>();
  const sessions = new Map<WebSocket, ToolSession>();
  const control: ControlState = { sessions, claims: new Map(), redeeming: new Map(), prompts: new Map() };
  const server = { command: process.execPath, args: [fileURLToPath(new URL('./cli.js', import.meta.url)), 'mcp'] };
  const agents = options.agents ?? new Agents({ env: process.env, stateDir, server });
  const t3Access = options.t3Access ?? new T3Access({ env: process.env, stateDir });
  const setup = options.setup ?? new Setup({ env: process.env, server, agents });
  const pairing = options.pairing ?? new T3PanelPairing({ env: process.env });
  const panel: PanelServices = { agents, t3Access, setup, pairing };
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
    const presented = requestToken(request, url);
    const credential: ConnectionCredential | undefined = tokensMatch(token, presented)
      ? 'control'
      : tokensMatch(extensionToken, presented)
        ? 'extension'
        : undefined;
    if (credential === undefined) {
      rejectUpgrade(socket, 401, 'Unauthorized');
      return;
    }

    const role = connectionRole(singleHeader(request.headers.origin), credential);
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
      if (role === 'extension') handleBrowserMessage(webSocket, browsers, control, panel, data);
      else if (role === 'control') handleControlMessage(webSocket, browsers, control, agents, data);
    });
    const forget = (): void => {
      browsers.delete(webSocket);
      connection?.close();
      browserPromptsGone(control, webSocket);
      const session = sessions.get(webSocket);
      sessions.delete(webSocket);
      control.claims.delete(webSocket);
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
    // Written first: whoever finds this daemon in `daemon.json` can then find the extension's secret too.
    await writeExtensionState(stateDir, { pid: process.pid, port: address.port, token: extensionToken });
    await writeDaemonState(stateDir, state);
  } catch (error) {
    await clearExtensionState(stateDir, extensionToken);
    await closeServer(httpServer, sockets);
    throw error;
  }

  let closed = false;
  return {
    port: address.port,
    token,
    extensionToken,
    state,
    close: async () => {
      if (closed) return;
      closed = true;
      await agents.close();
      t3Access.close();
      await clearDaemonState(stateDir, token);
      await clearExtensionState(stateDir, extensionToken);
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

interface PanelServices {
  agents: Agents;
  t3Access: T3Access;
  setup: Setup;
  pairing: T3PanelPairing;
}

function handleBrowserMessage(
  webSocket: WebSocket,
  browsers: Map<WebSocket, BrowserConnection>,
  control: ControlState,
  panel: PanelServices,
  data: RawData,
): void {
  const value = parseJson(data);
  if (!isBrowserMessage(value)) {
    webSocket.close(1008, isOtherProtocolVersion(value) ? PROTOCOL_MISMATCH : 'Invalid protocol message');
    return;
  }

  const message = value;
  const connection = browsers.get(webSocket);
  if (connection === undefined) return;
  const browser = connection.status;
  if (message.type === 'browser.response') {
    connection.handleResponse(message);
  } else if (message.type === 'browser.daemonRequest') {
    void answerDaemonRequest(webSocket, panel, message);
  } else if (message.type === 'browser.ping') {
    const pong: BrowserPongMessage = { type: 'browser.pong', protocolVersion: PROTOCOL_VERSION };
    webSocket.send(JSON.stringify(pong));
  } else if (message.type === 'browser.pong') {
    // The activity itself keeps the extension's service worker alive.
  } else if (message.type === 'browser.promptOpened') {
    promptOpened(control, webSocket, message);
  } else if (message.type === 'browser.promptClosed') {
    promptClosed(control, message.promptId);
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

/**
 * A side-panel request the extension passed on: start, continue, stop, read or list the panel's agent conversations,
 * set up an agent, sign in to T3 for its lists, run the panel's T3 session requests, or report a thread's mode. Pairing
 * and session replies carry the panel's own T3 token and nothing else; errors name what failed, not what was sent.
 */
async function answerDaemonRequest(
  webSocket: WebSocket,
  { agents, t3Access, setup, pairing }: PanelServices,
  message: BrowserDaemonRequestMessage,
): Promise<void> {
  let reply: DaemonReplyMessage;
  try {
    const params = (typeof message.params === 'object' && message.params !== null ? message.params : {}) as Record<string, unknown>;
    let result: unknown;
    if (message.method === 'agents.status') result = await agents.status(params.refresh === true);
    else if (message.method === 'agents.list') result = { conversations: agents.list() };
    else if (message.method === 'agents.start') result = { conversation: await agents.start(params) };
    else if (message.method === 'agents.send') result = { conversation: await agents.send(params.id, params.message, params.claim) };
    else if (message.method === 't3.access') result = await t3Access.view(params.refresh === true);
    else if (message.method === 't3.signIn') result = await t3Access.signIn();
    else if (message.method === 't3.signOut') result = await t3Access.signOut();
    else if (message.method === 'agents.get') result = { conversation: agents.get(params.id) };
    else if (message.method === 'agents.stop') result = { conversation: await agents.stop(params.id) };
    else if (message.method === 'setup.status') result = await setup.status(params.refresh === true);
    else if (message.method === 'setup.addAgent') result = await setup.addAgent(params.agent);
    else if (message.method === 't3.pair') result = await pairing.pair(params);
    else if (message.method === 't3.session') result = await pairing.session(params);
    else if (message.method === 't3.threadMode') result = await pairing.threadMode(params.threadId);
    else if (message.method === 't3.unpair') result = await pairing.unpair();
    else throw new Error(`Unknown method: ${String((message as { method?: unknown }).method)}`);
    reply = { type: 'daemon.reply', protocolVersion: PROTOCOL_VERSION, requestId: message.requestId, ok: true, result };
  } catch (error) {
    reply = {
      type: 'daemon.reply',
      protocolVersion: PROTOCOL_VERSION,
      requestId: message.requestId,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  if (webSocket.readyState === WebSocket.OPEN) webSocket.send(JSON.stringify(reply));
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
