import {
  EXTENSION_OUTDATED,
  HELPER_OUTDATED,
  PROTOCOL_MISMATCH,
  PROTOCOL_VERSION,
  type BrowserDaemonRequestMessage,
  type BrowserPromptClosedMessage,
  type BrowserPromptOpenedMessage,
  type DaemonMethod,
  type DaemonMethods,
  type DaemonReplyMessage,
} from '@t3-tab/protocol';

import { NOT_CONNECTED, classifyHelperProblem, type HelperProblem } from './helper-problem';

interface Pending {
  resolve(result: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

// `t3 thread start` waits for the T3 server; give it longer than the daemon's own 60-second limit.
const REQUEST_TIMEOUT_MS = 75_000;
const CONNECT_WAIT_MS = 5_000;

let socket: WebSocket | undefined;
let connect: (() => void) | undefined;
/** Set when the helper closed the link because it speaks another protocol version: what it said. */
let closeReason: string | undefined;
const pending = new Map<string, Pending>();
/** Why the last attempt to reach the background program failed, for the panel's "install the helper" step. */
let lastProblem: string | undefined;
/** Set when the problem is one the message alone does not name, such as a refused WebSocket. */
let lastKind: HelperProblem | undefined;


/** The service worker's current link to the background program, set when it opens and cleared when it closes. */
export function setDaemonSocket(current: WebSocket | undefined): void {
  if (current !== undefined) {
    closeReason = undefined;
    lastProblem = undefined;
    lastKind = undefined;
  }
  if (socket !== undefined && socket !== current) {
    failAll(new Error(closeReason ?? 'The connection to the T3-Tab helper closed'));
  }
  socket = current;
}

/**
 * Records why the link closed. A daemon of another version closes it with 1008: an older one says "Invalid protocol
 * message", because it does not know this version's messages.
 */
export function noteDaemonClose(code: number, reason: string): void {
  const versionProblem = code === 1008 && (reason === 'Invalid protocol message' || reason === PROTOCOL_MISMATCH || reason === HELPER_OUTDATED || reason === EXTENSION_OUTDATED);
  closeReason = versionProblem ? (reason === 'Invalid protocol message' ? HELPER_OUTDATED : reason) : undefined;
}

/**
 * Records a WebSocket that closed or never opened, with the browser's code and the helper's reason, so the panel can
 * show it. A version mismatch is recorded by `noteDaemonClose`, which the caller runs first.
 */
export function noteSocketClosed(code: number, reason: string, wasOpen: boolean): void {
  if (closeReason !== undefined) return;
  const why = reason === '' ? `code ${code}` : `${reason}, code ${code}`;
  lastProblem = wasOpen ? `The helper's background program closed the connection (${why}).` : `The browser could not connect to the helper's background program (${why}).`;
  lastKind = 'connection';
}

/** Records why the worker could not reach the helper, such as a native host that is not installed. */
export function noteDaemonProblem(error: unknown): void {
  closeReason = undefined;
  lastKind = undefined;
  lastProblem = error instanceof Error ? error.message : String(error);
}

/** Tells the background program a permission prompt opened or closed. Nothing is sent when the link is down. */
export function sendPromptNotice(message: BrowserPromptOpenedMessage | BrowserPromptClosedMessage): void {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

export type { HelperProblem } from './helper-problem';

export interface HelperState {
  connected: boolean;
  error?: string;
  problem?: HelperProblem;
}

/**
 * Whether the worker has a link to the helper, and if not, why. Answers when nothing is reachable: it tries to
 * connect, waits a moment, and reports what it found. Each call is a new attempt, so a helper installed a moment ago
 * is found without reloading anything: the browser reads its registration again every time.
 */
export async function daemonLinkState(waitMs = 1_500): Promise<HelperState> {
  const deadline = Date.now() + waitMs;
  if (socket?.readyState !== WebSocket.OPEN) connect?.();
  while (socket?.readyState !== WebSocket.OPEN && closeReason === undefined && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (socket?.readyState === WebSocket.OPEN) return { connected: true };
  const error = closeReason ?? lastProblem;
  // No error yet means an attempt is still under way, not that the helper is missing.
  return error === undefined ? { connected: false, problem: 'pending' } : { connected: false, error, problem: lastKind ?? classifyHelperProblem(error) };
}

/** Called when a request finds no open link, so the worker tries to connect again. */
export function setDaemonConnector(connector: () => void): void {
  connect = connector;
}

/** Returns true when the message was a reply to a side-panel request. */
export function handleDaemonReply(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const reply = value as DaemonReplyMessage;
  if (reply.type !== 'daemon.reply' || reply.protocolVersion !== PROTOCOL_VERSION || typeof reply.requestId !== 'string') return false;
  const waiting = pending.get(reply.requestId);
  if (waiting === undefined) return true;
  pending.delete(reply.requestId);
  clearTimeout(waiting.timer);
  if (reply.ok) waiting.resolve(reply.result);
  else waiting.reject(new Error(typeof reply.error === 'string' ? reply.error : 'The request failed'));
  return true;
}

/** Sends a side-panel request to the background program and waits for its answer. */
export async function askDaemon<M extends DaemonMethod>(
  method: M,
  params: DaemonMethods[M]['params'],
): Promise<DaemonMethods[M]['result']> {
  const current = await openSocket();
  const requestId = crypto.randomUUID();
  const message = { type: 'browser.daemonRequest', protocolVersion: PROTOCOL_VERSION, requestId, method, params } as BrowserDaemonRequestMessage;
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(requestId);
      reject(new Error(`The background program did not answer ${method}`));
    }, REQUEST_TIMEOUT_MS);
    pending.set(requestId, { resolve: resolve as (result: unknown) => void, reject, timer });
    current.send(JSON.stringify(message));
  });
}

async function openSocket(): Promise<WebSocket> {
  const deadline = Date.now() + CONNECT_WAIT_MS;
  if (socket?.readyState !== WebSocket.OPEN) connect?.();
  while (socket?.readyState !== WebSocket.OPEN) {
    if (closeReason !== undefined) throw new Error(closeReason);
    if (Date.now() >= deadline) {
      throw new Error(NOT_CONNECTED);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return socket;
}

function failAll(error: Error): void {
  for (const waiting of pending.values()) {
    clearTimeout(waiting.timer);
    waiting.reject(error);
  }
  pending.clear();
}
