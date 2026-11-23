import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { T3_PANEL_CLIENT_LABEL } from '@t3-tab/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { T3PanelPairing } from '../src/agents/t3-pairing.js';

const CREDENTIAL = 'SECRETPAIRING9';

let root: string;
let env: NodeJS.ProcessEnv;
let server: Server | undefined;
let requests: string[];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 't3-tab-pairing-'));
  await mkdir(join(root, 'home'), { recursive: true });
  await mkdir(join(root, 'bin'), { recursive: true });
  env = { HOME: join(root, 'home'), PATH: join(root, 'bin'), T3CODE_HOME: join(root, 't3') };
  requests = [];
});

afterEach(async () => {
  if (server !== undefined) {
    const running = server;
    running.closeAllConnections();
    await new Promise((resolve) => running.close(resolve));
    server = undefined;
  }
  await rm(root, { recursive: true, force: true });
});

/** A T3 that listens in this process, so the pid T3-Tab checks is this one. */
async function runningT3(pid = process.pid): Promise<string> {
  server = createServer((request, response) => {
    requests.push(request.url ?? '');
    response.end('{}');
  });
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  const address = server?.address();
  if (address === null || address === undefined || typeof address === 'string') throw new Error('no address');
  const origin = `http://127.0.0.1:${address.port}`;
  await mkdir(join(root, 't3', 'userdata'), { recursive: true });
  await writeFile(join(root, 't3', 'userdata', 'server-runtime.json'), JSON.stringify({ version: 1, origin, pid, startedAt: new Date().toISOString() }));
  return origin;
}

/** A `t3` that records its arguments and answers with what the test gives it. */
async function fakeT3(script: string): Promise<string> {
  const log = join(root, 'calls');
  const path = join(root, 'bin', 't3');
  await writeFile(path, `#!/bin/sh\necho "$*" >> "${log}"\n${script}\n`);
  await chmod(path, 0o755);
  return log;
}

const calls = async (log: string): Promise<string[]> => (await readFile(log, 'utf8').catch(() => '')).split('\n').filter((line) => line !== '');

describe('pairing the panel with T3 Code', () => {
  it('mints a five-minute credential with the panel label and returns it with the address it checked', async () => {
    const origin = await runningT3();
    const log = await fakeT3(`printf '{"id":"p1","credential":"${CREDENTIAL}","label":"x","scopes":[],"expiresAt":"2026-11-23T00:05:00.000Z"}'`);
    const pairing = await new T3PanelPairing({ env }).pair();
    expect(pairing).toEqual({ origin, credential: CREDENTIAL, expiresAt: '2026-11-23T00:05:00.000Z' });
    expect(await calls(log)).toEqual([`auth pairing create --json --ttl 5m --label ${T3_PANEL_CLIENT_LABEL}`]);
    // The listener was asked something over a connection the recorded process was checked to hold.
    expect(requests).toEqual(['/.well-known/oauth-authorization-server']);
  });

  it('mints nothing when the recorded process does not own the listener', async () => {
    await runningT3(process.ppid);
    const log = await fakeT3(`printf '{"credential":"${CREDENTIAL}","expiresAt":"x"}'`);
    await expect(new T3PanelPairing({ env }).pair()).rejects.toThrow('could not confirm that the running T3 Code owns its address');
    expect(await calls(log)).toEqual([]);
    expect(requests).toEqual([]);
  });

  it('says T3 is not running, or not found, without running anything', async () => {
    const log = await fakeT3('exit 0');
    await expect(new T3PanelPairing({ env }).pair()).rejects.toThrow('T3 Code is not running.');
    await rm(join(root, 'bin', 't3'));
    await expect(new T3PanelPairing({ env }).pair()).rejects.toThrow('T3 Code was not found.');
    expect(await calls(log)).toEqual([]);
  });

  it('never puts the credential in an error', async () => {
    await runningT3();
    await fakeT3(`printf 'not json ${CREDENTIAL}'`);
    const failure = await new T3PanelPairing({ env }).pair().then(() => new Error('paired'), (error: unknown) => error as Error);
    expect(failure.message).toBe('t3 did not print a pairing credential.');
    expect(failure.message).not.toContain(CREDENTIAL);
    await fakeT3(`printf '${CREDENTIAL}'; echo 'refused' >&2; exit 3`);
    const refused = await new T3PanelPairing({ env }).pair().then(() => new Error('paired'), (error: unknown) => error as Error);
    expect(refused.message).toBe('refused');
  });
});

describe('ending the panel\'s T3 sessions', () => {
  const session = (sessionId: string, label: string): unknown => ({ sessionId, client: { label }, scopes: [] });

  it('revokes exactly the sessions the panel opened', async () => {
    const log = await fakeT3(
      `if [ "$3" = list ]; then printf '%s' '${JSON.stringify([session('a1', T3_PANEL_CLIENT_LABEL), session('b2', 'T3-Tab'), session('c3', 'Phone'), session('d4', T3_PANEL_CLIENT_LABEL), session('-rf', T3_PANEL_CLIENT_LABEL)])}'; fi`,
    );
    expect(await new T3PanelPairing({ env }).unpair()).toEqual({ revoked: 2 });
    expect(await calls(log)).toEqual(['auth session list --json', 'auth session revoke a1', 'auth session revoke d4']);
  });

  it('reports a list it cannot read, and a revoke that fails', async () => {
    await fakeT3(`if [ "$3" = list ]; then printf 'oops'; fi`);
    await expect(new T3PanelPairing({ env }).unpair()).rejects.toThrow('t3 printed no session list.');
    await fakeT3(`if [ "$3" = list ]; then printf '%s' '${JSON.stringify([session('a1', T3_PANEL_CLIENT_LABEL)])}'; else echo 'no such session' >&2; exit 1; fi`);
    await expect(new T3PanelPairing({ env }).unpair()).rejects.toThrow('no such session');
  });

  it('revokes nothing when no session carries the label', async () => {
    const log = await fakeT3(`if [ "$3" = list ]; then printf '[]'; fi`);
    expect(await new T3PanelPairing({ env }).unpair()).toEqual({ revoked: 0 });
    expect(await calls(log)).toEqual(['auth session list --json']);
  });
});
