import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { compareVersions, findExecutable, findT3 } from '../src/agents/locate.js';

let root: string;
let home: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 't3-tab-locate-'));
  home = join(root, 'home');
  await mkdir(home, { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function exe(path: string): Promise<string> {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, '#!/bin/sh\n');
  await chmod(path, 0o755);
  return path;
}

describe('findExecutable', () => {
  it('finds a command on PATH, and nothing for a missing one', async () => {
    const bin = join(root, 'bin');
    const claude = await exe(join(bin, 'claude'));
    expect(await findExecutable('claude', { PATH: bin, HOME: home })).toBe(claude);
    expect(await findExecutable('codex-missing-xyz', { PATH: bin, HOME: home })).toBeUndefined();
  });

  it('skips a file that is not executable', async () => {
    const bin = join(root, 'bin');
    await mkdir(bin);
    await writeFile(join(bin, 'claude'), 'x');
    await chmod(join(bin, 'claude'), 0o644);
    expect(await findExecutable('claude', { PATH: bin, HOME: home })).toBeUndefined();
  });

  it('falls back to the usual folders under HOME', async () => {
    const codex = await exe(join(home, '.local', 'bin', 'codex'));
    expect(await findExecutable('codex', { PATH: '', HOME: home })).toBe(codex);
  });

  it('prefers PATH over the usual folders', async () => {
    await exe(join(home, '.local', 'bin', 'codex'));
    const onPath = await exe(join(root, 'bin', 'codex'));
    expect(await findExecutable('codex', { PATH: join(root, 'bin'), HOME: home })).toBe(onPath);
  });
});

describe('findT3', () => {
  it('uses T3_TAB_T3 alone when set', async () => {
    const override = await exe(join(root, 'custom', 't3'));
    await exe(join(root, 'bin', 't3'));
    expect(await findT3({ T3_TAB_T3: override, PATH: join(root, 'bin'), HOME: home })).toBe(override);
    expect(await findT3({ T3_TAB_T3: join(root, 'nope'), PATH: join(root, 'bin'), HOME: home })).toBeUndefined();
  });

  it('prefers PATH over T3 home entries', async () => {
    const onPath = await exe(join(root, 'bin', 't3'));
    await exe(join(home, '.t3', 'runtime', 'bin', 't3'));
    expect(await findT3({ PATH: join(root, 'bin'), HOME: home })).toBe(onPath);
  });

  it('uses a launcher listed in runtime/launchers, ignoring relative or missing lines', async () => {
    const launcher = await exe(join(root, 'launch', 't3-launch'));
    await exe(join(home, '.t3', 'runtime', 'bin', 't3'));
    await writeFile(join(home, '.t3', 'runtime', 'launchers'), `relative/t3\n${join(root, 'gone')}\n${launcher}\n`);
    expect(await findT3({ PATH: '', HOME: home })).toBe(launcher);
  });

  it('honours T3CODE_HOME over HOME/.t3', async () => {
    const custom = join(root, 'custom-home');
    const bin = await exe(join(custom, 'runtime', 'bin', 't3'));
    await exe(join(home, '.t3', 'runtime', 'bin', 't3'));
    expect(await findT3({ PATH: '', HOME: home, T3CODE_HOME: custom })).toBe(bin);
  });

  it('uses runtime/bin/t3 before versions', async () => {
    const bin = await exe(join(home, '.t3', 'runtime', 'bin', 't3'));
    const version = join(home, '.t3', 'runtime', 'versions', '0.1.9', 't3');
    await exe(version);
    await writeFile(join(version, '..', '.install-complete'), '');
    expect(await findT3({ PATH: '', HOME: home })).toBe(bin);
  });

  it("uses the desktop app's bin/t3 after runtime/bin and before versions", async () => {
    const desktop = await exe(join(home, '.t3', 'bin', 't3'));
    const version = join(home, '.t3', 'runtime', 'versions', '0.1.9', 't3');
    await exe(version);
    await writeFile(join(version, '..', '.install-complete'), '');
    expect(await findT3({ PATH: '', HOME: home })).toBe(desktop);
    const runtime = await exe(join(home, '.t3', 'runtime', 'bin', 't3'));
    expect(await findT3({ PATH: '', HOME: home })).toBe(runtime);
  });

  it('picks the newest version that has an install marker and skips one without', async () => {
    const versions = join(home, '.t3', 'runtime', 'versions');
    const old = await exe(join(versions, '0.1.8-nightly.20261101.1', 't3'));
    const newest = await exe(join(versions, '0.1.11-nightly.20261119.4928', 't3'));
    await exe(join(versions, '0.1.20', 't3'));
    for (const path of [old, newest]) await writeFile(join(path, '..', '.install-complete'), '');
    expect(await findT3({ PATH: '', HOME: home })).toBe(newest);
  });

  it('is undefined when nothing is installed', async () => {
    expect(await findT3({ PATH: '', HOME: join(root, 'empty') })).toBeUndefined();
  });
});

describe('compareVersions', () => {
  it('compares numeric parts as numbers', () => {
    expect(compareVersions('0.1.11-nightly.20261119.4928', '0.1.8-nightly.20261101.1')).toBeGreaterThan(0);
    expect(compareVersions('0.1.8-nightly.20261101.1', '0.1.11-nightly.20261119.4928')).toBeLessThan(0);
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0);
    expect(compareVersions('2.0.0', '10.0.0')).toBeLessThan(0);
  });
});
