import { execFile } from 'node:child_process';
import { open, realpath } from 'node:fs/promises';
import { basename, sep } from 'node:path';
import { promisify } from 'node:util';

import { findExecutable } from '../src/agents/locate.js';

const exec = promisify(execFile);
const VERSION_MANAGERS = new Set(['mise', 'rtx', 'asdf', 'volta', 'volta-shim']);
// A wrapper script that fetches its tool when run.
const FETCHING_WRAPPER = /\b(?:mise|rtx|asdf|volta|npx|bunx|uvx)\b|\bpnpm\s+dlx\b/;

const HELP_TIMEOUT_MS = 5_000;

export type HelpTarget = { path: string } | { skip: string };

/**
 * The real file behind a CLI, for reading its `--help` under a temporary HOME. A version-manager shim run there
 * finds no tool version and downloads one, so a shim is followed to its real file or the check is skipped.
 */
export async function resolveForHelp(name: string, env: NodeJS.ProcessEnv): Promise<HelpTarget> {
  const found = await findExecutable(name, env);
  if (found === undefined) return { skip: `${name} is not installed` };
  let real = await realpath(found);
  if (isManaged(found, real)) {
    const located = basename(real) === 'mise' || basename(real) === 'rtx' ? await askMise(real, name, env) : undefined;
    if (located === undefined) return { skip: `${found} is a version-manager shim whose real file could not be found without running it` };
    real = await realpath(located);
    if (isManaged(located, real)) return { skip: `${found} resolves only to another version-manager shim` };
  }
  if (await fetchesWhenRun(real)) return { skip: `${real} is a wrapper script that may download its tool` };
  return { path: real };
}

/** Prints the command's help, or says why it could not answer in time. Any other failure is a real one and throws. */
export async function readHelp(
  path: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs = HELP_TIMEOUT_MS,
): Promise<{ text: string } | { skip: string }> {
  try {
    const { stdout, stderr } = await exec(path, args, { env, timeout: timeoutMs, maxBuffer: 4 * 1_024 * 1_024 });
    return { text: `${stdout}\n${stderr}` };
  } catch (error) {
    if ((error as { killed?: boolean }).killed === true) return { skip: `${path} ${args.join(' ')} did not answer within ${timeoutMs} ms` };
    throw error;
  }
}

function isManaged(found: string, real: string): boolean {
  return VERSION_MANAGERS.has(basename(real)) || found.split(sep).includes('shims') || real.split(sep).includes('shims');
}

async function askMise(mise: string, name: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  try {
    const { stdout } = await exec(mise, ['which', name], {
      env: { ...env, MISE_NOT_FOUND_AUTO_INSTALL: '0', MISE_EXEC_AUTO_INSTALL: '0' },
      timeout: HELP_TIMEOUT_MS,
    });
    const path = stdout.trim();
    return path === '' ? undefined : path;
  } catch {
    return undefined;
  }
}

async function fetchesWhenRun(path: string): Promise<boolean> {
  const file = await open(path, 'r');
  try {
    const { buffer, bytesRead } = await file.read(Buffer.alloc(4_096), 0, 4_096, 0);
    const head = buffer.subarray(0, bytesRead);
    return head.subarray(0, 2).toString() === '#!' && FETCHING_WRAPPER.test(head.toString('utf8'));
  } finally {
    await file.close();
  }
}
