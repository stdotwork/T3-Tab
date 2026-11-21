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
const registrations = new Map<string, Promise<WebSocket>>();

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

/** Registers one MCP server process with the daemon and keeps its control connection alive while it runs. */
export async function registerSession(session: ToolSession, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const previous = registrations.get(session.id);
  if (previous !== undefined) {
    const socket = await previous.catch(() => undefined);
    if (socket?.readyState === WebSocket.OPEN) return;
  }
  const registration = openSessionRegistration(session, env);
  registrations.set(session.id, registration);
  try {
    const socket = await registration;
    const forget = (): void => {
      if (registrations.get(session.id) === registration) registrations.delete(session.id);
    };
    socket.once('close', forget);
    socket.once('error', forget);
  } catch (error) {
    if (registrations.get(session.id) === registration) registrations.delete(session.id);
    throw error;
  }
}

async function openSessionRegistration(session: ToolSession, env: NodeJS.ProcessEnv): Promise<WebSocket> {
  const state = await ensureDaemon(env);
  const socket = new WebSocket(`ws://127.0.0.1:${state.port}/`, {
    headers: { authorization: `Bearer ${state.token}` },
  });
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error === undefined) resolve();
      else {
        socket.terminate();
        reject(error);
      }
    };
    const timer = setTimeout(() => finish(new Error('T3-Tab daemon did not register the session')), CONTROL_TIMEOUT_MS);
    socket.once('open', () => {
      socket.send(
        JSON.stringify({
          type: 'control.request',
          protocolVersion: PROTOCOL_VERSION,
          requestId: randomUUID(),
          method: 'session.register',
          session,
        } satisfies ControlRequest),
      );
    });
    socket.once('message', (data) => {
      try {
        const response = JSON.parse(data.toString()) as ControlResponse;
        if (response.ok) finish();
        else finish(new Error(response.error));
      } catch {
        finish(new Error('T3-Tab daemon returned invalid JSON'));
      }
    });
    socket.once('error', (error) => finish(error));
    socket.once('close', () => finish(new Error('T3-Tab daemon closed the session registration')));
  });
  return socket;
}

/** Runs a browser tool through the daemon. `session` identifies the calling MCP server and owns its tabs. */
export async function callTool(
  method: ToolMethod,
  params: Record<string, unknown>,
  session: ToolSession,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ToolContent[]> {
  const state = await ensureDaemon(env);
  await registerSession(session, env);
  const request: ControlRequest = {
    type: 'control.request',
    protocolVersion: PROTOCOL_VERSION,
    requestId: randomUUID(),
    method,
    session,
    params,
  };
  const response = await sendControlRequest(state, request, TOOL_TIMEOUT_MS);
  if (!response.ok) throw new Error(response.error);
  if (!('content' in response.result)) throw new Error('T3-Tab daemon returned an unexpected reply');
  return response.result.content;
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
