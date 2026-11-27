import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { PROTOCOL_VERSION } from '@t3-tab/protocol';

export interface DaemonState {
  protocolVersion: typeof PROTOCOL_VERSION;
  pid: number;
  port: number;
  token: string;
  /** The packed helper's version, when the daemon runs from one. */
  helperVersion?: string;
}

/**
 * The extension's token and the daemon it belongs to. The native host passes it to the extension. It keeps an MCP
 * client holding the `daemon.json` token from connecting as the extension; any program running as the owner can read it.
 */
export interface ExtensionState {
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

function daemonStatePath(directory: string): string {
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

/** The daemon's state file whatever protocol version wrote it, so an install can tell it to stop. */
export async function readRawDaemonState(directory: string): Promise<(Omit<DaemonState, 'protocolVersion'> & { protocolVersion: number }) | null> {
  try {
    const parsed = JSON.parse(await readFile(daemonStatePath(directory), 'utf8')) as Record<string, unknown> | null;
    if (parsed === null || typeof parsed.pid !== 'number' || typeof parsed.port !== 'number' || typeof parsed.token !== 'string') return null;
    return {
      protocolVersion: typeof parsed.protocolVersion === 'number' ? parsed.protocolVersion : 0,
      pid: parsed.pid,
      port: parsed.port,
      token: parsed.token,
      ...(typeof parsed.helperVersion === 'string' ? { helperVersion: parsed.helperVersion } : {}),
    } as DaemonState & { protocolVersion: number };
  } catch {
    return null;
  }
}

export async function writeDaemonState(directory: string, state: DaemonState): Promise<void> {
  await writePrivateJson(directory, daemonStatePath(directory), state.pid, state);
}

function extensionStatePath(directory: string): string {
  return join(directory, 'extension.json');
}

export async function readExtensionState(directory: string): Promise<ExtensionState | null> {
  try {
    const parsed = JSON.parse(await readFile(extensionStatePath(directory), 'utf8')) as Partial<ExtensionState> | null;
    return typeof parsed?.pid === 'number' && typeof parsed.port === 'number' && typeof parsed.token === 'string'
      ? { pid: parsed.pid, port: parsed.port, token: parsed.token }
      : null;
  } catch {
    return null;
  }
}

export async function writeExtensionState(directory: string, state: ExtensionState): Promise<void> {
  await writePrivateJson(directory, extensionStatePath(directory), state.pid, state);
}

export async function clearExtensionState(directory: string, token: string): Promise<void> {
  const state = await readExtensionState(directory);
  if (state?.token === token) {
    await unlink(extensionStatePath(directory)).catch(() => undefined);
  }
}

async function writePrivateJson(directory: string, target: string, pid: number, value: unknown): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = `${target}.${pid}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
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
