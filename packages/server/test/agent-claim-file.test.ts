import { chmod, mkdtemp, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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
    expect(await takeClaimFile(file.path)).toBe(CODE);
    expect(await readdir(dirname(file.path))).toEqual([]);
    expect(await takeClaimFile(file.path)).toBeUndefined();
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
    expect(await takeClaimFile(path)).toBeUndefined();
  });

  it('refuses a symbolic link', async () => {
    const target = join(root, 'target');
    await writeFile(target, CODE, { mode: 0o600 });
    const path = join(root, 'claim');
    await symlink(target, path);
    expect(await takeClaimFile(path)).toBeUndefined();
  });

  it('refuses content that is not a claim code', async () => {
    const path = join(root, 'claim');
    await writeFile(path, 'not a code', { mode: 0o600 });
    expect(await takeClaimFile(path)).toBeUndefined();
  });
});
