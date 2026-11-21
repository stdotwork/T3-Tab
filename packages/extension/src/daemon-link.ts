import {
  PROTOCOL_VERSION,
  type BrowserDaemonRequestMessage,
  type DaemonMethod,
  type DaemonMethods,
  type DaemonReplyMessage,
} from '@t3-tab/protocol';

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
const pending = new Map<string, Pending>();

/** The service worker's current link to the background program, set when it opens and cleared when it closes. */
export function setDaemonSocket(current: WebSocket | undefined): void {
  if (socket !== undefined && socket !== current) failAll(new Error('The connection to the T3-Tab background program closed'));
  socket = current;
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
    if (Date.now() >= deadline) {
      throw new Error('T3-Tab is not connected to its background program. Run `t3-tab install`, then reopen the browser.');
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
