import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { PROTOCOL_VERSION } from '@t3-tab/protocol';

export interface DaemonState {
  protocolVersion: typeof PROTOCOL_VERSION;
  pid: number;
  port: number;
  token: string;
}

export function stateDirectory(env: NodeJS.ProcessEnv = process.env): string {
  const xdgStateHome = env.XDG_STATE_HOME?.trim();
  if (xdgStateHome !== undefined && xdgStateHome !== '') return join(xdgStateHome, 't3-tab');

  const home = env.HOME?.trim();
  return join(home === undefined || home === '' ? homedir() : home, '.local', 'state', 't3-tab');
}

export function daemonStatePath(directory: string): string {
  return join(directory, 'daemon.json');
}

export async function readDaemonState(directory: string): Promise<DaemonState | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(daemonStatePath(directory), 'utf8'));
    return isDaemonState(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export async function writeDaemonState(directory: string, state: DaemonState): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const target = daemonStatePath(directory);
  const temporary = `${target}.${state.pid}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, target);
    await chmod(target, 0o600);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

export async function clearDaemonState(directory: string, token: string): Promise<void> {
  const state = await readDaemonState(directory);
  if (state?.token === token) {
    await unlink(daemonStatePath(directory)).catch(() => undefined);
  }
}

function isDaemonState(value: unknown): value is DaemonState {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.protocolVersion === PROTOCOL_VERSION &&
    typeof candidate.pid === 'number' &&
    typeof candidate.port === 'number' &&
    typeof candidate.token === 'string'
  );
}
