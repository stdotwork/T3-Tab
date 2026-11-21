import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { open, mkdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PROTOCOL_VERSION, type BrowserStatus, type ControlRequest, type ControlResponse } from '@t3-tab/protocol';
import WebSocket from 'ws';

import { readDaemonState, stateDirectory, type DaemonState } from './state.js';

const START_TIMEOUT_MS = 10_000;
const LOCK_STALE_MS = 30_000;
const CONTROL_TIMEOUT_MS = 5_000;

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
  const response = await sendControlRequest(state, request);
  if (!response.ok) throw new Error(response.error);
  return response.result.browsers;
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

async function sendControlRequest(state: DaemonState, request: ControlRequest): Promise<ControlResponse> {
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
    }, CONTROL_TIMEOUT_MS);

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
