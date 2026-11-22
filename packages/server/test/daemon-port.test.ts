import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DEFAULT_DAEMON_PORT } from '@t3-tab/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import { startDaemon, type DaemonHandle } from '../src/daemon.js';

let daemon: DaemonHandle | undefined;
let directory: string | undefined;
const holders: Server[] = [];

afterEach(async () => {
  await daemon?.close();
  daemon = undefined;
  for (const server of holders.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  if (directory !== undefined) {
    await rm(directory, { recursive: true, force: true });
    directory = undefined;
  }
});

/** Holds a loopback TCP port the way another process would, until the test ends. Port 0 picks a free port. */
async function holdPort(port: number): Promise<number> {
  const server = createServer();
  holders.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('The held port has no TCP address');
  return address.port;
}

describe('daemon port', () => {
  it('starts on a free loopback port when the default port is taken, and records that port', async () => {
    // Fails before the test starts if something else already holds the default port on this machine.
    await holdPort(DEFAULT_DAEMON_PORT);
    directory = await mkdtemp(join(tmpdir(), 't3-tab-daemon-port-'));

    daemon = await startDaemon({ stateDir: directory });

    expect(daemon.port).not.toBe(DEFAULT_DAEMON_PORT);
    expect(daemon.port).toBeGreaterThan(0);
    const state = JSON.parse(await readFile(join(directory, 'daemon.json'), 'utf8'));
    expect(state.port).toBe(daemon.port);
    const health = await fetch(`http://127.0.0.1:${state.port}/health`, {
      headers: { authorization: `Bearer ${state.token}` },
    });
    expect(health.status).toBe(200);
  });

  it('fails with an error that names the port when an explicitly requested port is taken', async () => {
    const taken = await holdPort(0);
    directory = await mkdtemp(join(tmpdir(), 't3-tab-daemon-port-'));

    await expect(startDaemon({ port: taken, stateDir: directory })).rejects.toThrow(
      `Port ${taken} on 127.0.0.1 is already in use`,
    );
    await expect(readFile(join(directory, 'daemon.json'), 'utf8')).rejects.toThrow();
  });
});
