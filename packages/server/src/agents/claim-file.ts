import { constants } from 'node:fs';
import { mkdir, mkdtemp, open, rm, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const CLAIM_CODE = /^[A-Za-z0-9_-]{16,64}$/;

export interface ClaimFile {
  path: string;
  remove(): Promise<void>;
}

/**
 * Writes a direct turn's claim code where only the owner can read it. The MCP server gets the path, which is
 * harmless on a command line, and deletes the file as it reads it.
 */
export async function writeClaimFile(stateDir: string, code: string): Promise<ClaimFile> {
  const parent = join(stateDir, 'claims');
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const folder = await mkdtemp(join(parent, 'run-'));
  const path = join(folder, 'claim');
  await writeFile(path, code, { mode: 0o600, flag: 'wx' });
  return { path, remove: async () => await rm(folder, { recursive: true, force: true }) };
}

/** Reads a claim file once and deletes it. Anything but a private regular file holding a code gives nothing. */
export async function takeClaimFile(path: string): Promise<string | undefined> {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return undefined;
  }
  try {
    const info = await file.stat();
    if (!info.isFile() || (info.mode & 0o077) !== 0) return undefined;
    if (process.getuid !== undefined && info.uid !== process.getuid()) return undefined;
    const code = (await file.readFile('utf8')).trim();
    await unlink(path).catch(() => undefined);
    return CLAIM_CODE.test(code) ? code : undefined;
  } finally {
    await file.close();
  }
}
