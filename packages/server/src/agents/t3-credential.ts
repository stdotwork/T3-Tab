import { randomBytes } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * T3-Tab's read-only sign-in to T3 Code. Only the daemon reads or writes it, in one file in T3-Tab's state folder,
 * next to `daemon.json` but separate from it, so nothing that reads the daemon's port and token ever sees it.
 */
export interface T3Credential {
  version: 1;
  /** The T3 environment the sign-in is for, such as `http://127.0.0.1:3773`. */
  environment: string;
  /** The `/mcp` address the token may be sent to, and nowhere else. */
  resource: string;
  clientId: string;
  accessToken: string;
  scope: string;
  expiresAt: number;
}

export const CREDENTIAL_FILE = 't3-credential.json';

export function credentialPath(stateDir: string): string {
  return join(stateDir, CREDENTIAL_FILE);
}

export async function readCredential(stateDir: string): Promise<T3Credential | undefined> {
  let source: string;
  try {
    source = await readFile(credentialPath(stateDir), 'utf8');
  } catch {
    return undefined;
  }
  try {
    const value: unknown = JSON.parse(source);
    return isCredential(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Writes the credential to a new file created with mode 0600 (`wx`, so an existing file or link at the temporary
 * name is never reused), then renames it over the old one. The stored file is therefore always that new 0600 file;
 * an older file's mode is never kept or widened.
 */
export async function writeCredential(stateDir: string, credential: T3Credential): Promise<void> {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const target = credentialPath(stateDir);
  const temporary = `${target}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.chmod(0o600);
      await handle.writeFile(`${JSON.stringify(credential)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, target);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

export async function deleteCredential(stateDir: string): Promise<void> {
  await unlink(credentialPath(stateDir)).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
  });
}

function isCredential(value: unknown): value is T3Credential {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.version === 1 &&
    typeof candidate.environment === 'string' &&
    typeof candidate.resource === 'string' &&
    typeof candidate.clientId === 'string' &&
    typeof candidate.accessToken === 'string' &&
    candidate.accessToken !== '' &&
    typeof candidate.scope === 'string' &&
    typeof candidate.expiresAt === 'number'
  );
}
