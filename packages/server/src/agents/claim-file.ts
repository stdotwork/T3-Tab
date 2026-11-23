import { constants } from 'node:fs';
import { mkdir, mkdtemp, open, rm, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { ClaimFileProblem } from '@t3-tab/protocol';

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

const PROBLEM_TEXT: Record<ClaimFileProblem, string> = {
  missing: 'it was missing',
  'not-private': 'other users could read it',
  'wrong-owner': 'it belongs to another user',
  'not-a-file': 'it is not a regular file',
  invalid: 'it held no valid code',
  unreadable: 'it could not be opened',
};

export const CLAIM_FILE_PROBLEMS: ReadonlySet<string> = new Set(Object.keys(PROBLEM_TEXT));

/** The warning in the conversation whose turn could not use its claim file. */
export function claimFileWarning(problem: ClaimFileProblem): string {
  return `T3-Tab could not use the private file for this turn's tabs: ${PROBLEM_TEXT[problem]}. The agent has no tabs from you this turn. Share a tab from Threads in the side panel if it needs one.`;
}

/** The line the agent's first browser tool reply starts with when its claim file could not be used. */
export function claimFileNotice(problem: ClaimFileProblem): string {
  return `T3-Tab: the tabs the owner shared for this turn are not available (their private file: ${PROBLEM_TEXT[problem]}). You have no shared tabs. Ask the owner to share one from the T3-Tab side panel.`;
}

export type ClaimFileResult = { code: string } | { problem: ClaimFileProblem };

/**
 * Reads a claim file once and deletes it. Anything but a private regular file holding a code gives no code and
 * says why, so a turn that was meant to have tabs can tell the owner it has none. A pipe in its place must not
 * block the MCP server's start, so it is opened without waiting for a writer.
 */
export async function takeClaimFile(path: string): Promise<ClaimFileResult> {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    const reason = (error as NodeJS.ErrnoException).code;
    return { problem: reason === 'ENOENT' ? 'missing' : reason === 'ELOOP' || reason === 'EMLINK' ? 'not-a-file' : 'unreadable' };
  }
  try {
    const info = await file.stat();
    if (!info.isFile()) return { problem: 'not-a-file' };
    if (process.getuid !== undefined && info.uid !== process.getuid()) return { problem: 'wrong-owner' };
    if ((info.mode & 0o077) !== 0) return { problem: 'not-private' };
    const code = (await file.readFile('utf8')).trim();
    await unlink(path).catch(() => undefined);
    return CLAIM_CODE.test(code) ? { code } : { problem: 'invalid' };
  } catch {
    return { problem: 'unreadable' };
  } finally {
    await file.close();
  }
}
