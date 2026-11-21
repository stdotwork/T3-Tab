import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { open, mkdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  PROTOCOL_VERSION,
  type BrowserStatus,
  type ControlRequest,
  type ControlResponse,
  type ToolContent,
  type ToolMethod,
  type ToolSession,
} from '@t3-tab/protocol';
import WebSocket from 'ws';

import { readDaemonState, stateDirectory, type DaemonState } from './state.js';

const START_TIMEOUT_MS = 10_000;
const LOCK_STALE_MS = 30_000;
const CONTROL_TIMEOUT_MS = 5_000;
// Longer than the daemon waits on the browser, so the daemon's own error arrives first.
const TOOL_TIMEOUT_MS = 310_000;

export async function ensureDaemon(env: NodeJS.ProcessEnv = process.env): Promise<DaemonState> {
  const directory = stateDirectory(env);
  const existing = await readDaemonState(directory);
  if (existing !== null && (await daemonIsHealthy(existing))) return existing;

  const releaseLock = await acquireStartLock(directory);
  try {
    const running = await readDaemonState(directory);
    if (running !== null && (await daemonIsHealthy(running))) return running;

    startDaemonProcess(env);
    const deadline = Date.now() + START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const started = await readDaemonState(directory);
      if (started !== null && (await daemonIsHealthy(started))) return started;
      await sleep(100);
    }
    throw new Error(`T3-Tab daemon did not start within ${START_TIMEOUT_MS / 1_000} seconds`);
  } finally {
    await releaseLock();
  }
}

export async function getStatus(env: NodeJS.ProcessEnv = process.env): Promise<BrowserStatus[]> {
  const state = await ensureDaemon(env);
  const request: ControlRequest = {
    type: 'control.request',
    protocolVersion: PROTOCOL_VERSION,
    requestId: randomUUID(),
    method: 'status',
  };
  const response = await sendControlRequest(state, request, CONTROL_TIMEOUT_MS);
  if (!response.ok) throw new Error(response.error);
  if (!('browsers' in response.result)) throw new Error('T3-Tab daemon returned an unexpected status');
  return response.result.browsers;
}

interface PendingControl {
  resolve(response: ControlResponse): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

/** One long-lived control connection. The daemon issues its session id, which only this socket may use. */
export class DaemonSession {
  private socket: WebSocket | undefined;
  private session: ToolSession | undefined;
  private registration: Promise<ToolSession> | undefined;
  private terminal = false;
  private readonly pending = new Map<string, PendingControl>();
  private clientName = 'MCP client';

  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  setClientName(name: string | undefined): void {
    if (name !== undefined && name !== '') this.clientName = name;
  }

  async register(): Promise<ToolSession> {
    if (this.terminal) throw new Error('The session control connection closed; restart the MCP client.');
    if (this.session !== undefined) return this.session;
    if (this.registration !== undefined) return await this.registration;
    this.registration = this.connectAndRegister();
    try {
      return await this.registration;
    } finally {
      this.registration = undefined;
    }
  }

  async callTool(method: ToolMethod, params: Record<string, unknown>): Promise<ToolContent[]> {
    const session = await this.register();
    const response = await this.request(
      {
        type: 'control.request',
        protocolVersion: PROTOCOL_VERSION,
        requestId: randomUUID(),
        method,
        session,
        params,
      },
      TOOL_TIMEOUT_MS,
    );
    if (!response.ok) throw new Error(response.error);
    if (!('content' in response.result)) throw new Error('T3-Tab daemon returned an unexpected reply');
    return response.result.content;
  }

  private async connectAndRegister(): Promise<ToolSession> {
    const state = await ensureDaemon(this.env);
    const socket = new WebSocket(`ws://127.0.0.1:${state.port}/`, {
      headers: { authorization: `Bearer ${state.token}` },
    });
    this.socket = socket;
    try {
      socket.on('message', (data) => this.handleMessage(data));
      socket.on('error', (error) => this.failAll(error));
      socket.on('close', () => this.failAll(new Error('The session control connection closed; restart the MCP client.')));
      await new Promise<void>((resolve, reject) => {
        socket.once('open', () => resolve());
        socket.once('error', reject);
      });
      const response = await this.request(
        {
          type: 'control.request',
          protocolVersion: PROTOCOL_VERSION,
          requestId: randomUUID(),
          method: 'session.register',
          clientName: this.clientName,
        },
        CONTROL_TIMEOUT_MS,
      );
      if (!response.ok) throw new Error(response.error);
      if (!('session' in response.result)) throw new Error('T3-Tab daemon did not issue a session');
      const session = response.result.session;
      if (typeof session.id !== 'string' || typeof session.name !== 'string') {
        throw new Error('T3-Tab daemon returned an invalid session');
      }
      this.session = session;
      return session;
    } catch (error) {
      if (this.socket === socket) this.socket = undefined;
      socket.terminate();
      throw error;
    }
  }

  private async request(request: ControlRequest, timeoutMs: number): Promise<ControlResponse> {
    const socket = this.socket;
    if (socket === undefined || socket.readyState !== WebSocket.OPEN) {
      throw new Error('The session control connection is not open; restart the MCP client.');
    }
    return await new Promise<ControlResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(request.requestId);
        reject(new Error('T3-Tab daemon did not answer the control request'));
      }, timeoutMs);
      this.pending.set(request.requestId, { resolve, reject, timer });
      socket.send(JSON.stringify(request), (error?: Error | null) => {
        if (error === undefined || error === null) return;
        clearTimeout(timer);
        this.pending.delete(request.requestId);
        reject(error);
      });
    });
  }

  private handleMessage(data: WebSocket.RawData): void {
    let response: ControlResponse;
    try {
      response = JSON.parse(data.toString()) as ControlResponse;
    } catch {
      this.failAll(new Error('T3-Tab daemon returned invalid JSON'));
      return;
    }
    if (response.type !== 'control.response' || typeof response.requestId !== 'string') return;
    const pending = this.pending.get(response.requestId);
    if (pending === undefined) return;
    this.pending.delete(response.requestId);
    clearTimeout(pending.timer);
    pending.resolve(response);
  }

  private failAll(error: Error): void {
    this.terminal = true;
    this.session = undefined;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.socket = undefined;
  }
}

async function daemonIsHealthy(state: DaemonState): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${state.port}/health`, {
      headers: { authorization: `Bearer ${state.token}` },
      signal: AbortSignal.timeout(1_000),
    });
    if (!response.ok) return false;
    const body: unknown = await response.json();
    return typeof body === 'object' && body !== null && (body as Record<string, unknown>).ok === true;
  } catch {
    return false;
  }
}

function startDaemonProcess(env: NodeJS.ProcessEnv): void {
  const cliPath = fileURLToPath(new URL('./cli.js', import.meta.url));
  const child = spawn(process.execPath, [cliPath, 'daemon'], {
    env,
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
}

async function sendControlRequest(
  state: DaemonState,
  request: ControlRequest,
  timeoutMs: number,
): Promise<ControlResponse> {
  return await new Promise<ControlResponse>((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${state.port}/`, {
      headers: { authorization: `Bearer ${state.token}` },
    });
    let settled = false;
    const finish = (error: Error | undefined, response?: ControlResponse): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.terminate();
      if (error !== undefined) reject(error);
      else if (response !== undefined) resolve(response);
      else reject(new Error('T3-Tab daemon returned no response'));
    };
    const timer = setTimeout(() => {
      finish(new Error('T3-Tab daemon did not answer the control request'));
    }, timeoutMs);

    socket.on('open', () => socket.send(JSON.stringify(request)));
    socket.on('message', (data) => {
      try {
        const response: unknown = JSON.parse(data.toString());
        if (isControlResponse(response, request.requestId)) finish(undefined, response);
      } catch {
        finish(new Error('T3-Tab daemon returned invalid JSON'));
      }
    });
    socket.on('error', (error) => finish(error));
    socket.on('close', () => finish(new Error('T3-Tab daemon closed the control connection')));
  });
}

function isControlResponse(value: unknown, requestId: string): value is ControlResponse {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.type === 'control.response' &&
    candidate.protocolVersion === PROTOCOL_VERSION &&
    candidate.requestId === requestId &&
    typeof candidate.ok === 'boolean'
  );
}

async function acquireStartLock(directory: string): Promise<() => Promise<void>> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const lockPath = join(directory, 'start.lock');
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (true) {
    try {
      const handle = await open(lockPath, 'wx', 0o600);
      await handle.writeFile(`${process.pid}\n`);
      await handle.close();
      return async () => {
        await unlink(lockPath).catch(() => undefined);
      };
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      await removeStaleLock(lockPath);
      if (Date.now() >= deadline) throw new Error('Timed out waiting to start the T3-Tab daemon');
      await sleep(50);
    }
  }
}

async function removeStaleLock(lockPath: string): Promise<void> {
  try {
    const info = await stat(lockPath);
    if (Date.now() - info.mtimeMs > LOCK_STALE_MS) await unlink(lockPath);
  } catch {
    // Another process may have released the lock between stat and unlink.
  }
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === 'EEXIST';
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
