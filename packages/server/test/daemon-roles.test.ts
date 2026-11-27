import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { EXTENSION_ORIGIN, PROTOCOL_VERSION } from '@t3-tab/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';

import { Agents } from '../src/agents/conversations.js';
import { T3PanelPairing } from '../src/agents/t3-pairing.js';
import { startDaemon, type DaemonHandle } from '../src/daemon.js';

const directories: string[] = [];
const sockets: WebSocket[] = [];
let daemon: DaemonHandle | undefined;

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  await daemon?.close();
  daemon = undefined;
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
  vi.restoreAllMocks();
});

async function temporary(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 't3-tab-daemon-roles-'));
  directories.push(directory);
  return directory;
}

describe('the extension role', () => {
  it('is refused to the daemon token, even with the extension Origin', async () => {
    const stateDir = await temporary();
    const pairing = new T3PanelPairing({ env: {} });
    const calls = [vi.spyOn(pairing, 'pair'), vi.spyOn(pairing, 'session'), vi.spyOn(pairing, 'threadMode'), vi.spyOn(pairing, 'unpair')];
    const agents = new Agents({ env: { PATH: '' }, server: { command: 'node', args: [] } });
    daemon = await startDaemon({ port: 0, stateDir, agents, pairing });

    const socket = new WebSocket(`ws://127.0.0.1:${daemon.port}/`, { headers: { authorization: `Bearer ${daemon.token}`, origin: EXTENSION_ORIGIN } });
    sockets.push(socket);
    const opened = await new Promise<boolean>((resolve) => {
      socket.once('open', () => resolve(true));
      socket.once('error', () => resolve(false));
    });
    if (opened) {
      for (const method of ['t3.pair', 't3.session', 't3.threadMode', 't3.unpair']) {
        const reply = new Promise((resolve) => socket.once('message', resolve));
        socket.send(JSON.stringify({ type: 'browser.daemonRequest', protocolVersion: PROTOCOL_VERSION, requestId: method, method, params: {} }));
        await reply;
      }
    }

    expect(opened).toBe(false);
    for (const call of calls) expect(call).not.toHaveBeenCalled();
  });

  it('needs the extension secret and the extension Origin together, and keeps the secret out of daemon.json', async () => {
    const stateDir = await temporary();
    const agents = new Agents({ env: { PATH: '' }, server: { command: 'node', args: [] } });
    daemon = await startDaemon({ port: 0, stateDir, agents });
    const opens = async (token: string, origin?: string): Promise<boolean> => {
      const socket = new WebSocket(`ws://127.0.0.1:${daemon?.port}/`, { headers: { authorization: `Bearer ${token}`, ...(origin === undefined ? {} : { origin }) } });
      sockets.push(socket);
      return await new Promise<boolean>((resolve) => {
        socket.once('open', () => resolve(true));
        socket.once('error', () => resolve(false));
      });
    };

    expect(await opens(daemon.extensionToken, EXTENSION_ORIGIN)).toBe(true);
    expect(await opens(daemon.extensionToken)).toBe(false);
    expect(await opens(daemon.extensionToken, 'https://example.com')).toBe(false);
    expect(await opens(daemon.token)).toBe(true);
    expect(await readFile(join(stateDir, 'daemon.json'), 'utf8')).not.toContain(daemon.extensionToken);
    expect((await stat(join(stateDir, 'extension.json'))).mode & 0o777).toBe(0o600);
    expect(await readFile(join(stateDir, 'extension.json'), 'utf8')).toContain(daemon.extensionToken);
  });
});
