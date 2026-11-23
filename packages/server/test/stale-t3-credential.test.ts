import { mkdir, lstat, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { Agents } from '../src/agents/conversations.js';
import { removeStaleT3Credentials } from '../src/agents/stale-t3-credential.js';
import { startDaemon, type DaemonHandle } from '../src/daemon.js';

const directories: string[] = [];
let daemon: DaemonHandle | undefined;

afterEach(async () => {
  await daemon?.close();
  daemon = undefined;
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function temporary(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 't3-tab-stale-credential-'));
  directories.push(directory);
  return directory;
}

const CREDENTIAL = 't3-credential.json';
const LEFTOVER = 't3-credential.json.0123456789abcdef.tmp';

/** What an older T3-Tab left behind, next to files and folders that are not its own. */
async function seeded(): Promise<{ stateDir: string; outside: string }> {
  const stateDir = await temporary();
  const outside = join(await temporary(), 'outside');
  await writeFile(outside, 'keep me');
  await writeFile(join(stateDir, CREDENTIAL), '{"accessToken":"left-behind"}', { mode: 0o600 });
  await writeFile(join(stateDir, LEFTOVER), '{"accessToken":"left-behind"}', { mode: 0o600 });
  await writeFile(join(stateDir, 't3-credential.json.fedcba9876543210.tmp'), 'second copy');
  await writeFile(join(stateDir, 't3-credential.json.notes.tmp'), 'not ours');
  await writeFile(join(stateDir, `${LEFTOVER}.bak`), 'not ours');
  await writeFile(join(stateDir, 'notes.txt'), 'mine');
  await mkdir(join(stateDir, 't3-credential.json.1111111111111111.tmp'));
  await symlink(outside, join(stateDir, 't3-credential.json.2222222222222222.tmp'));
  return { stateDir, outside };
}

async function expectOnlyCredentialsGone(stateDir: string, outside: string): Promise<void> {
  await expect(lstat(join(stateDir, CREDENTIAL))).rejects.toThrow();
  await expect(lstat(join(stateDir, LEFTOVER))).rejects.toThrow();
  await expect(lstat(join(stateDir, 't3-credential.json.fedcba9876543210.tmp'))).rejects.toThrow();
  expect(await readFile(join(stateDir, 't3-credential.json.notes.tmp'), 'utf8')).toBe('not ours');
  expect(await readFile(join(stateDir, `${LEFTOVER}.bak`), 'utf8')).toBe('not ours');
  expect(await readFile(join(stateDir, 'notes.txt'), 'utf8')).toBe('mine');
  expect((await lstat(join(stateDir, 't3-credential.json.1111111111111111.tmp'))).isDirectory()).toBe(true);
  expect((await lstat(join(stateDir, 't3-credential.json.2222222222222222.tmp'))).isSymbolicLink()).toBe(true);
  expect(await readFile(outside, 'utf8')).toBe('keep me');
}

describe('the T3 token an older sign-in left in the state folder', () => {
  it('is deleted with its crash leftovers, and nothing else', async () => {
    const { stateDir, outside } = await seeded();
    expect(await removeStaleT3Credentials(stateDir)).toBe(3);
    await expectOnlyCredentialsGone(stateDir, outside);
  });

  it('is deleted when the daemon starts', async () => {
    const { stateDir, outside } = await seeded();
    const agents = new Agents({ env: { PATH: '' }, server: { command: 'node', args: [] } });
    daemon = await startDaemon({ port: 0, stateDir, agents });
    await expectOnlyCredentialsGone(stateDir, outside);
  });

  it('is nothing to do when the folder has none or does not exist yet', async () => {
    expect(await removeStaleT3Credentials(await temporary())).toBe(0);
    expect(await removeStaleT3Credentials(join(await temporary(), 'missing'))).toBe(0);
  });
});
