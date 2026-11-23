import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { findT3Environment } from '../src/agents/t3-environment.js';

const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function temporary(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 't3-tab-t3-environment-'));
  directories.push(directory);
  return directory;
}

describe('finding the local T3 environment', () => {
  async function runtime(state: Record<string, unknown>): Promise<NodeJS.ProcessEnv> {
    const home = await temporary();
    await mkdir(join(home, 'userdata'), { recursive: true });
    await writeFile(join(home, 'userdata', 'server-runtime.json'), JSON.stringify({ version: 1, port: 3773, startedAt: new Date().toISOString(), ...state }));
    return { T3CODE_HOME: home };
  }

  it('reads the origin of a running server', async () => {
    expect(await findT3Environment(await runtime({ pid: process.pid, origin: 'http://127.0.0.1:3773' }))).toMatchObject({
      origin: 'http://127.0.0.1:3773',
    });
  });

  it('treats a stopped server, a missing file and a plain-http LAN address as unusable', async () => {
    expect(await findT3Environment(await runtime({ pid: 2 ** 22 + 7, origin: 'http://127.0.0.1:3773' }))).toEqual({ problem: 'T3 Code is not running.' });
    expect(await findT3Environment({ T3CODE_HOME: await temporary() })).toEqual({ problem: 'T3 Code is not running.' });
    expect(await findT3Environment(await runtime({ pid: process.pid, origin: 'http://192.168.1.5:3773' }))).toEqual({
      problem: "T3 Code listens on http://192.168.1.5:3773; T3-Tab signs in only to a T3 Code on this computer's loopback address.",
    });
    expect(await findT3Environment(await runtime({ pid: process.pid, origin: 'https://t3.example.test' }))).toEqual({
      problem: "T3 Code listens on https://t3.example.test; T3-Tab signs in only to a T3 Code on this computer's loopback address.",
    });
    expect(await findT3Environment(await runtime({ pid: process.pid, origin: 'http://127.0.0.1:3773', startedAt: 'not a time' }))).toEqual({
      problem: 'T3 Code is not running.',
    });
  });
});
