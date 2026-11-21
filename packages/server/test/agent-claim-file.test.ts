import { chmod, mkdir, mkdtemp, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { takeClaimFile, writeClaimFile } from '../src/agents/claim-file.js';

const CODE = 'abcdefghijklmnop1234';
let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 't3-tab-claim-file-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('claim files', () => {
  it('writes the code readable only by the owner, inside a private folder', async () => {
    const file = await writeClaimFile(root, CODE);
    expect((await stat(file.path)).mode & 0o777).toBe(0o600);
    expect((await stat(dirname(file.path))).mode & 0o777).toBe(0o700);
  });

  it('gives the code once and deletes the file', async () => {
    const file = await writeClaimFile(root, CODE);
    expect(await takeClaimFile(file.path)).toEqual({ code: CODE });
    expect(await readdir(dirname(file.path))).toEqual([]);
    expect(await takeClaimFile(file.path)).toEqual({ problem: 'missing' });
  });

  it('removes its folder', async () => {
    const file = await writeClaimFile(root, CODE);
    await file.remove();
    await expect(stat(dirname(file.path))).rejects.toThrow();
  });

  it('refuses a file other users can read', async () => {
    const path = join(root, 'claim');
    await writeFile(path, CODE, { mode: 0o600 });
    await chmod(path, 0o644);
    expect(await takeClaimFile(path)).toEqual({ problem: 'not-private' });
  });

  it('refuses a symbolic link', async () => {
    const target = join(root, 'target');
    await writeFile(target, CODE, { mode: 0o600 });
    const path = join(root, 'claim');
    await symlink(target, path);
    expect(await takeClaimFile(path)).toEqual({ problem: 'not-a-file' });
  });

  it('refuses content that is not a claim code', async () => {
    const path = join(root, 'claim');
    await writeFile(path, 'not a code', { mode: 0o600 });
    expect(await takeClaimFile(path)).toEqual({ problem: 'invalid' });
  });

  it('refuses a file another user owns', async () => {
    const path = join(root, 'claim');
    await writeFile(path, CODE, { mode: 0o600 });
    const uid = vi.spyOn(process, 'getuid').mockReturnValue((process.getuid?.() ?? 0) + 1);
    try {
      expect(await takeClaimFile(path)).toEqual({ problem: 'wrong-owner' });
    } finally {
      uid.mockRestore();
    }
  });

  it('refuses a folder in place of the file', async () => {
    const path = join(root, 'claim');
    await mkdir(path, { mode: 0o700 });
    expect(await takeClaimFile(path)).toEqual({ problem: 'not-a-file' });
  });

  it('refuses a named pipe without waiting for a writer', async () => {
    const path = join(root, 'claim');
    execFileSync('mkfifo', ['-m', '600', path]);
    expect(await takeClaimFile(path)).toEqual({ problem: 'not-a-file' });
  }, 3_000);
});
