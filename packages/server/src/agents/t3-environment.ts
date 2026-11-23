import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { t3Home } from './locate.js';
import { confirmedFetch, type T3Fetch, type T3Process } from './t3-connection.js';

export interface T3Environment {
  /** Such as `http://127.0.0.1:3773`. */
  origin: string;
  /** Sends a request only on a connection the recorded T3 process accepted. Every request to T3 goes through it. */
  fetch: T3Fetch;
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

/**
 * The local T3 Code environment, from `<T3 home>/userdata/server-runtime.json`, which the running T3 server writes.
 * Only its `origin`, `pid` and `startedAt` are read. T3 records a plain http address, so only a loopback one is used:
 * that is the only kind whose listening process this computer can check, which `confirmedFetch` does for each request.
 */
export async function findT3Environment(env: NodeJS.ProcessEnv): Promise<T3Environment | { problem: string }> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(join(t3Home(env), 'userdata', 'server-runtime.json'), 'utf8'));
  } catch {
    return { problem: 'T3 Code is not running.' };
  }
  const state = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
  if (typeof state.origin !== 'string' || !Number.isInteger(state.pid)) return { problem: 'T3 Code is not running.' };
  if (!processIsAlive(state.pid as number)) return { problem: 'T3 Code is not running.' };
  const startedAt = typeof state.startedAt === 'string' ? Date.parse(state.startedAt) : Number.NaN;
  if (Number.isNaN(startedAt)) return { problem: 'T3 Code is not running.' };
  let url: URL;
  try {
    url = new URL(state.origin);
  } catch {
    return { problem: 'T3 Code reported an address T3-Tab cannot use.' };
  }
  if (url.protocol !== 'http:' || !LOOPBACK.has(url.hostname) || url.username !== '' || url.password !== '') {
    return { problem: `T3 Code listens on ${url.origin}; T3-Tab signs in only to a T3 Code on this computer's loopback address.` };
  }
  return t3EnvironmentAt(url.origin, { pid: state.pid as number, startedAt });
}

/** The live process `server-runtime.json` records, without its address. Undefined when T3 is not running. */
export async function recordedT3Process(env: NodeJS.ProcessEnv): Promise<T3Process | undefined> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(join(t3Home(env), 'userdata', 'server-runtime.json'), 'utf8'));
  } catch {
    return undefined;
  }
  const state = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
  if (!Number.isInteger(state.pid) || !processIsAlive(state.pid as number)) return undefined;
  const startedAt = typeof state.startedAt === 'string' ? Date.parse(state.startedAt) : Number.NaN;
  return Number.isNaN(startedAt) ? undefined : { pid: state.pid as number, startedAt };
}

export function t3EnvironmentAt(origin: string, owner: T3Process): T3Environment {
  return { origin, fetch: confirmedFetch(origin, owner) };
}

function processIsAlive(pid: number): boolean {
  if (pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}
