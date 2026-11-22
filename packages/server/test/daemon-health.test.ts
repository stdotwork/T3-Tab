import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { startDaemon, type DaemonHandle } from '../src/index.js';

let daemon: DaemonHandle | undefined;
let directory: string | undefined;

afterEach(async () => {
  if (daemon !== undefined) {
    await daemon.close();
    daemon = undefined;
  }
  if (directory !== undefined) {
    await rm(directory, { recursive: true, force: true });
    directory = undefined;
  }
});

describe('background daemon', () => {
  it('writes a private token and protects the health endpoint', async () => {
    directory = await mkdtemp(join(tmpdir(), 't3-tab-daemon-test-'));
    daemon = await startDaemon({ port: 0, stateDir: directory });

    const statePath = join(directory, 'daemon.json');
    const state = JSON.parse(await readFile(statePath, 'utf8'));
    expect(state.token).toEqual(expect.any(String));
    expect((await stat(statePath)).mode & 0o777).toBe(0o600);

    const url = `http://127.0.0.1:${daemon.port}/health`;
    const authorized = await fetch(url, { headers: { authorization: `Bearer ${daemon.token}` } });
    expect(authorized.status).toBe(200);

    const missingToken = await fetch(url);
    expect(missingToken.status).toBe(401);

    expect(
      await rawGet(url, {
        authorization: `Bearer ${daemon.token}`,
        host: 'attacker.example',
      }),
    ).toBe(403);
  });
});

async function rawGet(url: string, headers: Record<string, string>): Promise<number> {
  return await new Promise((resolve, reject) => {
    const outgoing = request(url, { headers }, (response) => {
      response.resume();
      response.once('end', () => resolve(response.statusCode ?? 0));
    });
    outgoing.once('error', reject);
    outgoing.end();
  });
}
