import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { t3Home } from './locate.js';

export interface T3Environment {
  /** Such as `http://127.0.0.1:3773`. */
  origin: string;
  /** `<origin>/mcp`, the only address T3-Tab sends its T3 credential to. */
  resource: string;
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

/**
 * The local T3 Code environment, from `<T3 home>/userdata/server-runtime.json`, which the running T3 server writes.
 * Only its `origin` and `pid` are read. The server must still be alive, so a credential is never sent to whatever
 * took a stopped server's port. A sign-in sends credentials only over loopback or https, as T3's own agents do.
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
  let url: URL;
  try {
    url = new URL(state.origin);
  } catch {
    return { problem: 'T3 Code reported an address T3-Tab cannot use.' };
  }
  const allowed = url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK.has(url.hostname));
  if (!allowed || url.username !== '' || url.password !== '') {
    return { problem: `T3 Code listens on ${url.origin}; T3-Tab signs in only over localhost or https.` };
  }
  return { origin: url.origin, resource: `${url.origin}/mcp` };
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
