import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { EXTENSION_ORIGIN, PROTOCOL_VERSION } from '@t3-tab/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';

import { approveInBrowser, startFakeT3, type FakeT3 } from '../../../e2e/fakes/t3-server.mjs';
import { Agents } from '../src/agents/conversations.js';
import { T3Access } from '../src/agents/t3-access.js';
import { credentialPath, readCredential, writeCredential } from '../src/agents/t3-credential.js';
import { findT3Environment } from '../src/agents/t3-environment.js';
import { startDaemon, type DaemonHandle } from '../src/index.js';

const fakes: FakeT3[] = [];
const accesses: T3Access[] = [];
const directories: string[] = [];
let daemon: DaemonHandle | undefined;
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  await daemon?.close();
  daemon = undefined;
  for (const access of accesses.splice(0)) access.close();
  for (const fake of fakes.splice(0)) await fake.close();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
  vi.restoreAllMocks();
});

async function temporary(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 't3-tab-t3-access-'));
  directories.push(directory);
  return directory;
}

async function setup(options: { pageSize?: number } = {}): Promise<{ fake: FakeT3; access: T3Access; stateDir: string }> {
  const fake = await startFakeT3(options);
  fakes.push(fake);
  const stateDir = await temporary();
  const access = new T3Access({
    env: {},
    stateDir,
    findEnvironment: async () => ({ origin: fake.origin, resource: `${fake.origin}/mcp` }),
  });
  accesses.push(access);
  return { fake, access, stateDir };
}

describe('T3 sign-in', () => {
  it('signs in read-only through T3 OAuth, stores the token in a 0600 file and lists projects and models', async () => {
    const { fake, access, stateDir } = await setup();
    expect((await access.view()).state).toBe('signed-out');

    const { url } = await access.signIn();
    const authorize = new URL(url);
    expect(authorize.origin + authorize.pathname).toBe(`${fake.origin}/oauth/mcp/authorize`);
    expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorize.searchParams.get('redirect_uri')).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    expect((await access.view()).state).toBe('signing-in');

    const landed = await approveInBrowser(url, 'read-only');
    expect(landed.status).toBe(200);
    expect(landed.text).toContain('Signed in to T3 Code with read-only access');

    const token = fake.issued()[0];
    expect(token).toBeDefined();
    const info = await stat(credentialPath(stateDir));
    expect(info.mode & 0o777).toBe(0o600);
    expect((await readCredential(stateDir))?.accessToken).toBe(token);

    const view = await access.view();
    expect(view.state).toBe('signed-in');
    expect(view.environment).toBe(fake.origin);
    expect(view.catalog?.projects.map((project) => project.id)).toEqual(['proj-demo', 'proj-docs', 'proj-api']);
    expect(view.catalog?.projects[0]).toEqual({
      id: 'proj-demo',
      title: 'Demo app',
      workspaceRoot: '/work/demo',
      defaultProvider: 'claudeAgent',
      defaultModel: 'claude-sonnet-5-5',
    });
    expect(view.catalog?.providers).toEqual([
      {
        instanceId: 'claudeAgent',
        name: 'Claude',
        models: [
          { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5' },
          { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5' },
        ],
        omittedModels: 3,
      },
      { instanceId: 'codex', name: 'codex (codex)', models: [{ id: 'gpt-5.3-codex' }] },
      { instanceId: 'opencode', name: 'OpenCode', models: [{ id: 'big-pickle' }], unavailable: 'Provider executable is not installed.' },
    ]);
    expect(JSON.stringify(view)).not.toContain(token);

    // The token went only to /mcp, and only T3's two read-only listing tools were called.
    const log = fake.log();
    expect(log.filter((entry) => entry.bearer === token).every((entry) => entry.path === '/mcp')).toBe(true);
    expect(log.some((entry) => entry.path === '/mcp' && entry.bearer === token)).toBe(true);
    expect([...new Set(log.flatMap((entry) => (entry.tool === undefined ? [] : [entry.tool])))]).toEqual(['t3_project_list', 'orchestrator_capabilities']);

    // The lists are held: a plain view does not call T3 again.
    const calls = fake.log().length;
    await access.view();
    expect(fake.log().length).toBe(calls);

    // The listener took one answer and closed.
    await expect(fetch(landed.callback)).rejects.toThrow();
  });

  it('keeps nothing when the owner approves more than read-only', async () => {
    const { fake, access, stateDir } = await setup();
    const { url } = await access.signIn();
    const landed = await approveInBrowser(url, 'full-access');
    expect(landed.status).toBe(400);
    expect(landed.text).toContain('granted more than read-only access');
    expect(fake.issued()).toHaveLength(1);
    await expect(stat(credentialPath(stateDir))).rejects.toThrow();
    const view = await access.view();
    expect(view.state).toBe('signed-out');
    expect(view.detail).toContain('revoke T3-Tab in Settings → Sharing & access');
    expect(JSON.stringify(view)).not.toContain(fake.issued()[0]);
  });

  it('ignores an answer with the wrong state and still accepts the real one', async () => {
    const { access, stateDir } = await setup();
    const { url } = await access.signIn();
    const callback = new URL(new URL(url).searchParams.get('redirect_uri') ?? '');
    callback.searchParams.set('code', 'forged-code');
    callback.searchParams.set('state', 'not-the-state');
    const forged = await fetch(callback);
    expect(forged.status).toBe(400);
    expect(await forged.text()).toContain('not for the sign-in T3-Tab started');
    expect((await access.view()).state).toBe('signing-in');
    await expect(stat(credentialPath(stateDir))).rejects.toThrow();

    const landed = await approveInBrowser(url, 'read-only');
    expect(landed.status).toBe(200);
    expect((await access.view()).state).toBe('signed-in');
  });

  it('reports a declined sign-in', async () => {
    const { access } = await setup();
    const { url } = await access.signIn();
    const landed = await approveInBrowser(url, 'deny');
    expect(landed.text).toContain('The sign-in was declined in T3 Code.');
    expect(await access.view()).toEqual({ state: 'signed-out', detail: 'The sign-in was declined in T3 Code.' });
  });

  it('drops a sign-in T3 no longer accepts', async () => {
    const { fake, access, stateDir } = await setup();
    await approveInBrowser((await access.signIn()).url, 'read-only');
    expect((await access.view()).catalog).toBeDefined();
    fake.revokeAll();
    const view = await access.view(true);
    expect(view.state).toBe('signed-out');
    expect(view.detail).toContain("no longer accepts T3-Tab's sign-in");
    await expect(stat(credentialPath(stateDir))).rejects.toThrow();
  });

  it('signs out by deleting the file and says how to end it in T3', async () => {
    const { access, stateDir } = await setup();
    await approveInBrowser((await access.signIn()).url, 'read-only');
    const view = await access.signOut();
    expect(view.state).toBe('signed-out');
    expect(view.detail).toContain('Settings → Sharing & access');
    await expect(stat(credentialPath(stateDir))).rejects.toThrow();
  });

  it('reads every page of projects', async () => {
    const { fake, access } = await setup({ pageSize: 2 });
    await approveInBrowser((await access.signIn()).url, 'read-only');
    expect((await access.view()).catalog?.projects.map((project) => project.id)).toEqual(['proj-demo', 'proj-docs', 'proj-api']);
    expect(fake.log().filter((entry) => entry.tool === 't3_project_list').map((entry) => entry.args?.cursor)).toEqual([undefined, 2]);
  });

  it('does not send the token to a T3 that moved to another address', async () => {
    const { fake, stateDir } = await setup();
    const moved = await startFakeT3();
    fakes.push(moved);
    let current = fake.origin;
    const access = new T3Access({ env: {}, stateDir, findEnvironment: async () => ({ origin: current, resource: `${current}/mcp` }) });
    accesses.push(access);
    await approveInBrowser((await access.signIn()).url, 'read-only');
    current = moved.origin;
    const view = await access.view(true);
    expect(view.state).toBe('signed-in');
    expect(view.detail).toContain(`T3 Code now runs at ${moved.origin}`);
    expect(moved.log()).toEqual([]);
  });

  it('refuses to start when T3 is not running', async () => {
    const access = new T3Access({ env: {}, stateDir: await temporary(), findEnvironment: async () => ({ problem: 'T3 Code is not running.' }) });
    accesses.push(access);
    await expect(access.signIn()).rejects.toThrow('T3 Code is not running. Start T3 Code, then sign in.');
  });
});

describe('the credential file', () => {
  it('replaces an older, wider file with a new 0600 one', async () => {
    const stateDir = await temporary();
    await writeFile(credentialPath(stateDir), '{}', { mode: 0o644 });
    await chmod(credentialPath(stateDir), 0o644);
    await writeCredential(stateDir, {
      version: 1,
      environment: 'http://127.0.0.1:1',
      resource: 'http://127.0.0.1:1/mcp',
      clientId: 'client',
      accessToken: 'generated-at-runtime',
      scope: 'orchestration:read',
      expiresAt: Date.now() + 1_000,
    });
    expect((await stat(credentialPath(stateDir))).mode & 0o777).toBe(0o600);
  });
});

describe('finding the local T3 environment', () => {
  async function runtime(state: Record<string, unknown>): Promise<NodeJS.ProcessEnv> {
    const home = await temporary();
    await mkdir(join(home, 'userdata'), { recursive: true });
    await writeFile(join(home, 'userdata', 'server-runtime.json'), JSON.stringify({ version: 1, port: 3773, startedAt: 'x', ...state }));
    return { T3CODE_HOME: home };
  }

  it('reads the origin of a running server', async () => {
    expect(await findT3Environment(await runtime({ pid: process.pid, origin: 'http://127.0.0.1:3773' }))).toEqual({
      origin: 'http://127.0.0.1:3773',
      resource: 'http://127.0.0.1:3773/mcp',
    });
  });

  it('treats a stopped server, a missing file and a plain-http LAN address as unusable', async () => {
    expect(await findT3Environment(await runtime({ pid: 2 ** 22 + 7, origin: 'http://127.0.0.1:3773' }))).toEqual({ problem: 'T3 Code is not running.' });
    expect(await findT3Environment({ T3CODE_HOME: await temporary() })).toEqual({ problem: 'T3 Code is not running.' });
    expect(await findT3Environment(await runtime({ pid: process.pid, origin: 'http://192.168.1.5:3773' }))).toEqual({
      problem: 'T3 Code listens on http://192.168.1.5:3773; T3-Tab signs in only over localhost or https.',
    });
  });
});

describe('the daemon and the T3 credential', () => {
  it('never puts the token in a panel reply or its output', async () => {
    const fake = await startFakeT3();
    fakes.push(fake);
    const stateDir = await temporary();
    const t3Access = new T3Access({ env: {}, stateDir, findEnvironment: async () => ({ origin: fake.origin, resource: `${fake.origin}/mcp` }) });
    const output: string[] = [];
    const capture = (stream: NodeJS.WriteStream) =>
      vi.spyOn(stream, 'write').mockImplementation((chunk: string | Uint8Array) => {
        output.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
        return true;
      });
    capture(process.stdout);
    capture(process.stderr);
    for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => void output.push(args.map(String).join(' ')));
    }
    const agents = new Agents({ env: { PATH: '' }, server: { command: 'node', args: [] } });
    daemon = await startDaemon({ port: 0, stateDir, agents, t3Access });
    const socket = new WebSocket(`ws://127.0.0.1:${daemon.port}/`, { headers: { authorization: `Bearer ${daemon.token}`, origin: EXTENSION_ORIGIN } });
    sockets.push(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.once('error', reject);
    });
    const replies: string[] = [];
    const ask = async (method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> => {
      const requestId = `r-${replies.length}-${Math.random()}`;
      const reply = new Promise<string>((resolve) => {
        const onMessage = (data: WebSocket.RawData): void => {
          const text = data.toString();
          if ((JSON.parse(text) as { requestId?: string }).requestId !== requestId) return;
          socket.off('message', onMessage);
          resolve(text);
        };
        socket.on('message', onMessage);
      });
      socket.send(JSON.stringify({ type: 'browser.daemonRequest', protocolVersion: PROTOCOL_VERSION, requestId, method, params }));
      const text = await reply;
      replies.push(text);
      return JSON.parse(text) as Record<string, unknown>;
    };

    const signIn = await ask('t3.signIn');
    const url = (signIn.result as { url: string }).url;
    await approveInBrowser(url, 'read-only');
    const signedIn = await ask('t3.access', { refresh: true });
    expect((signedIn.result as { state: string; catalog?: unknown }).state).toBe('signed-in');
    expect((signedIn.result as { catalog?: unknown }).catalog).toBeDefined();
    fake.revokeAll();
    await ask('t3.access', { refresh: true });
    await ask('t3.signOut');

    const token = fake.issued()[0] ?? '';
    expect(token.length).toBeGreaterThan(20);
    expect(replies.join('\n')).not.toContain(token);
    expect(output.join('\n')).not.toContain(token);
    // Only `t3-credential.json` ever held it; `daemon.json` never does.
    const { readFile } = await import('node:fs/promises');
    expect(await readFile(join(stateDir, 'daemon.json'), 'utf8')).not.toContain(token);
  });
});
