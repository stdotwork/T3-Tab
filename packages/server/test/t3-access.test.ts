import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { EXTENSION_ORIGIN, PROTOCOL_VERSION } from '@t3-tab/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';

import { approveInBrowser, startFakeT3, type FakeT3 } from '../../../e2e/fakes/t3-server.mjs';
import { Agents } from '../src/agents/conversations.js';
import { T3Access } from '../src/agents/t3-access.js';
import { confirmedFetch } from '../src/agents/t3-connection.js';
import { credentialPath, readCredential, writeCredential } from '../src/agents/t3-credential.js';
import { findT3Environment, t3EnvironmentAt, type T3Environment } from '../src/agents/t3-environment.js';
import { startDaemon, type DaemonHandle } from '../src/daemon.js';

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

/** The fake runs in this process, so the real ownership check passes for it. */
function localT3(origin: string): T3Environment {
  return t3EnvironmentAt(origin, { pid: process.pid, startedAt: Date.now() });
}

async function setup(options: Parameters<typeof startFakeT3>[0] = {}): Promise<{ fake: FakeT3; access: T3Access; stateDir: string }> {
  const fake = await startFakeT3(options);
  fakes.push(fake);
  const stateDir = await temporary();
  const access = new T3Access({
    env: {},
    stateDir,
    findEnvironment: async () => localT3(fake.origin),
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
    const access = new T3Access({ env: {}, stateDir, findEnvironment: async () => localT3(current) });
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
    await writeFile(join(home, 'userdata', 'server-runtime.json'), JSON.stringify({ version: 1, port: 3773, startedAt: new Date().toISOString(), ...state }));
    return { T3CODE_HOME: home };
  }

  it('reads the origin of a running server', async () => {
    expect(await findT3Environment(await runtime({ pid: process.pid, origin: 'http://127.0.0.1:3773' }))).toMatchObject({
      origin: 'http://127.0.0.1:3773',
      resource: 'http://127.0.0.1:3773/mcp',
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

describe('the daemon and the T3 credential', () => {
  it('never puts the token in a panel reply or its output', async () => {
    const fake = await startFakeT3();
    fakes.push(fake);
    const stateDir = await temporary();
    const t3Access = new T3Access({ env: {}, stateDir, findEnvironment: async () => localT3(fake.origin) });
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
    const socket = new WebSocket(`ws://127.0.0.1:${daemon.port}/`, { headers: { authorization: `Bearer ${daemon.extensionToken}`, origin: EXTENSION_ORIGIN } });
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
    expect(await readFile(join(stateDir, 'daemon.json'), 'utf8')).not.toContain(token);
  });
});

/** A server in another process, standing where T3 was recorded. It answers 401 and lists what it was sent at /__seen. */
const impostors: ChildProcess[] = [];
afterEach(() => {
  for (const child of impostors.splice(0)) child.kill('SIGKILL');
});

async function startImpostor(): Promise<{ port: number; seen(): Promise<Array<{ path: string; authorization: string | null }>> }> {
  const script = `
    const seen = [];
    const server = require('node:http').createServer((request, response) => {
      if (request.url === '/__seen') { response.end(JSON.stringify(seen)); return; }
      seen.push({ path: request.url, authorization: request.headers.authorization ?? null });
      request.resume();
      response.writeHead(401, { 'content-type': 'application/json' });
      response.end('{}');
    });
    server.listen(0, '127.0.0.1', () => process.stdout.write(String(server.address().port) + '\\n'));
  `;
  const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'inherit'] });
  impostors.push(child);
  const port = await new Promise<number>((resolve, reject) => {
    child.stdout?.once('data', (chunk: Buffer) => resolve(Number(chunk.toString().trim())));
    child.once('error', reject);
  });
  return {
    port,
    seen: async () => (await (await fetch(`http://127.0.0.1:${port}/__seen`)).json()) as Array<{ path: string; authorization: string | null }>,
  };
}

async function recordedT3(origin: string, pid: number, startedAt: string): Promise<NodeJS.ProcessEnv> {
  const home = await temporary();
  await mkdir(join(home, 'userdata'), { recursive: true });
  await writeFile(join(home, 'userdata', 'server-runtime.json'), JSON.stringify({ version: 1, pid, port: Number(new URL(origin).port), origin, startedAt }));
  return { T3CODE_HOME: home };
}

async function storedCredential(stateDir: string, origin: string): Promise<string> {
  const accessToken = randomBytes(32).toString('base64url');
  await writeCredential(stateDir, {
    version: 1,
    environment: origin,
    resource: `${origin}/mcp`,
    clientId: 'client',
    accessToken,
    scope: 'orchestration:read',
    expiresAt: Date.now() + 60_000,
  });
  return accessToken;
}

describe('sending the credential only to the process T3 recorded', () => {
  it('sends nothing when the recorded pid is alive but another process owns the port', async () => {
    const impostor = await startImpostor();
    const origin = `http://127.0.0.1:${impostor.port}`;
    const stateDir = await temporary();
    await storedCredential(stateDir, origin);
    const access = new T3Access({ env: await recordedT3(origin, process.pid, new Date().toISOString()), stateDir });
    accesses.push(access);

    const view = await access.view(true);

    expect(await impostor.seen()).toEqual([]);
    expect(view.state).toBe('signed-in');
    expect(view.detail).toContain('could not confirm');
    expect(await readCredential(stateDir)).toBeDefined();
  });

  it('starts no sign-in with a server the recorded pid does not own', async () => {
    const impostor = await startImpostor();
    const origin = `http://127.0.0.1:${impostor.port}`;
    const access = new T3Access({ env: await recordedT3(origin, process.pid, new Date().toISOString()), stateDir: await temporary() });
    accesses.push(access);

    await expect(access.signIn()).rejects.toThrow('could not confirm');
    expect(await impostor.seen()).toEqual([]);
  });

  it('sends nothing when the recorded pid belongs to a process started after T3 recorded it', async () => {
    const fake = await startFakeT3();
    fakes.push(fake);
    const stateDir = await temporary();
    const token = await storedCredential(stateDir, fake.origin);
    const beforeThisProcess = new Date(Date.now() - process.uptime() * 1_000 - 3_600_000).toISOString();
    const access = new T3Access({ env: await recordedT3(fake.origin, process.pid, beforeThisProcess), stateDir });
    accesses.push(access);

    const view = await access.view(true);

    expect(fake.log().filter((entry) => entry.bearer === token)).toEqual([]);
    expect(view.detail).toContain('could not confirm');
  });

  it('sends the token when the recorded process owns the port', async () => {
    const fake = await startFakeT3();
    fakes.push(fake);
    const stateDir = await temporary();
    const token = await storedCredential(stateDir, fake.origin);
    fake.acceptToken(token);
    const access = new T3Access({ env: await recordedT3(fake.origin, process.pid, new Date().toISOString()), stateDir });
    accesses.push(access);

    const view = await access.view(true);

    expect(view.catalog?.projects.map((project) => project.id)).toEqual(['proj-demo', 'proj-docs', 'proj-api']);
    expect(fake.log().some((entry) => entry.path === '/mcp' && entry.bearer === token)).toBe(true);
  });
});

describe('the checked connection to T3', () => {
  async function listening(host: string, handler: Parameters<typeof createServer>[1]): Promise<{ port: number; close(): Promise<void> }> {
    const server = createServer(handler);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, host, () => resolve());
    });
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('The test server has no TCP address');
    return {
      port: address.port,
      close: async () => {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
      },
    };
  }

  /** A real separate process listening on loopback, so its start time in `/proc` is the moment it was spawned. */
  async function serverProcess(): Promise<{ pid: number; origin: string; requests(): number; stop(): void }> {
    const script =
      "require('http').createServer((q,r)=>{process.stdout.write('request\\n');r.end('answered')})" +
      ".listen(0,'127.0.0.1',function(){process.stdout.write('port '+this.address().port+'\\n')})";
    const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'inherit'] });
    let output = '';
    const port = await new Promise<number>((resolve, reject) => {
      child.once('error', reject);
      child.stdout.on('data', (chunk: Buffer) => {
        output += chunk.toString();
        const found = /^port (\d+)$/m.exec(output);
        if (found !== null) resolve(Number(found[1]));
      });
    });
    return {
      pid: child.pid as number,
      origin: `http://127.0.0.1:${port}`,
      requests: () => output.split('\n').filter((line) => line === 'request').length,
      stop: () => child.kill('SIGKILL'),
    };
  }

  it('sends nothing to a process that started 1.5 seconds after the recorded start', async () => {
    // Above the at most 1.01 s by which the start time read from /proc can come out early.
    const recorded = Date.now() - 1_500;
    const server = await serverProcess();
    try {
      const send = confirmedFetch(server.origin, { pid: server.pid, startedAt: recorded });
      await expect(send(`${server.origin}/check`)).rejects.toThrow('could not confirm');
      expect(server.requests()).toBe(0);
    } finally {
      server.stop();
    }
  });

  it('accepts a process whose record was written right after it started', async () => {
    const server = await serverProcess();
    try {
      const response = await confirmedFetch(server.origin, { pid: server.pid, startedAt: Date.now() })(`${server.origin}/check`);
      expect(await response.text()).toBe('answered');
      expect(server.requests()).toBe(1);
    } finally {
      server.stop();
    }
  });

  // T3 with no host set listens on every address and records 127.0.0.1, so its side of the connection is IPv4-mapped.
  it.each([
    ['every address, reached over 127.0.0.1', '::', 'http://127.0.0.1'],
    ['the IPv6 loopback address', '::1', 'http://[::1]'],
    ['127.0.0.1, reached as localhost', '127.0.0.1', 'http://localhost'],
  ])('accepts this process listening on %s', async (_name, host, base) => {
    const server = await listening(host, (_request, response) => response.end('answered'));
    try {
      const origin = `${base}:${server.port}`;
      const response = await confirmedFetch(origin, { pid: process.pid, startedAt: Date.now() })(`${origin}/check`);
      expect(await response.text()).toBe('answered');
    } finally {
      await server.close();
    }
  });

  it('refuses a redirect and another origin', async () => {
    let requests = 0;
    const elsewhere = await listening('127.0.0.1', (_request, response) => {
      requests += 1;
      response.end('followed');
    });
    const server = await listening('127.0.0.1', (_request, response) => {
      response.writeHead(302, { location: `http://127.0.0.1:${elsewhere.port}/stolen` });
      response.end();
    });
    try {
      const origin = `http://127.0.0.1:${server.port}`;
      const send = confirmedFetch(origin, { pid: process.pid, startedAt: Date.now() });
      await expect(send(`${origin}/mcp`, { headers: { authorization: 'Bearer generated-at-runtime' } })).rejects.toThrow('redirect');
      await expect(send(`http://127.0.0.1:${elsewhere.port}/mcp`)).rejects.toThrow('could not confirm');
      expect(requests).toBe(0);
    } finally {
      await server.close();
      await elsewhere.close();
    }
  });
});

describe('leftover temporary credential files', () => {
  const leftover = 't3-credential.json.0123456789abcdef.tmp';

  async function seeded(): Promise<{ stateDir: string; outside: string }> {
    const stateDir = await temporary();
    const outside = join(await temporary(), 'outside');
    await writeFile(outside, 'keep me');
    await writeFile(join(stateDir, leftover), '{"accessToken":"left-behind"}', { mode: 0o600 });
    await writeFile(join(stateDir, 't3-credential.json.notes.tmp'), 'not ours');
    await writeFile(join(stateDir, `${leftover}.bak`), 'not ours');
    await mkdir(join(stateDir, 't3-credential.json.1111111111111111.tmp'));
    await symlink(outside, join(stateDir, 't3-credential.json.2222222222222222.tmp'));
    return { stateDir, outside };
  }

  async function expectOnlyLeftoverGone(stateDir: string, outside: string): Promise<void> {
    await expect(lstat(join(stateDir, leftover))).rejects.toThrow();
    expect(await readFile(join(stateDir, 't3-credential.json.notes.tmp'), 'utf8')).toBe('not ours');
    expect(await readFile(join(stateDir, `${leftover}.bak`), 'utf8')).toBe('not ours');
    expect((await lstat(join(stateDir, 't3-credential.json.1111111111111111.tmp'))).isDirectory()).toBe(true);
    expect((await lstat(join(stateDir, 't3-credential.json.2222222222222222.tmp'))).isSymbolicLink()).toBe(true);
    expect(await readFile(outside, 'utf8')).toBe('keep me');
  }

  it('removes them on sign-out, and nothing else', async () => {
    const { stateDir, outside } = await seeded();
    const access = new T3Access({ env: {}, stateDir, findEnvironment: async () => ({ problem: 'T3 Code is not running.' }) });
    accesses.push(access);
    await access.signOut();
    await expectOnlyLeftoverGone(stateDir, outside);
  });

  it('removes them when the daemon starts, and nothing else', async () => {
    const { stateDir, outside } = await seeded();
    const agents = new Agents({ env: { PATH: '' }, server: { command: 'node', args: [] } });
    daemon = await startDaemon({ port: 0, stateDir, agents });
    await expectOnlyLeftoverGone(stateDir, outside);
  });
});

describe('the issuer on the sign-in answer', () => {
  it('refuses an answer without iss and keeps nothing', async () => {
    const { fake, access, stateDir } = await setup({ callbackIss: 'missing' });
    const landed = await approveInBrowser((await access.signIn()).url, 'read-only');
    expect(landed.status).toBe(400);
    expect(fake.issued()).toEqual([]);
    await expect(stat(credentialPath(stateDir))).rejects.toThrow();
  });

  it('refuses an answer with another issuer and keeps nothing', async () => {
    const { fake, access, stateDir } = await setup({ callbackIss: 'wrong' });
    const landed = await approveInBrowser((await access.signIn()).url, 'read-only');
    expect(landed.status).toBe(400);
    expect(fake.issued()).toEqual([]);
    await expect(stat(credentialPath(stateDir))).rejects.toThrow();
  });

  it('starts no sign-in with a server that does not promise iss', async () => {
    const { access } = await setup({ advertiseIss: false });
    await expect(access.signIn()).rejects.toThrow('described a sign-in T3-Tab does not use');
  });
});

describe('the extension role', () => {
  it('is refused to the daemon token, even with the extension Origin', async () => {
    const stateDir = await temporary();
    const t3Access = new T3Access({ env: {}, stateDir, findEnvironment: async () => ({ problem: 'T3 Code is not running.' }) });
    accesses.push(t3Access);
    const calls = [vi.spyOn(t3Access, 'view'), vi.spyOn(t3Access, 'signIn'), vi.spyOn(t3Access, 'signOut')];
    const agents = new Agents({ env: { PATH: '' }, server: { command: 'node', args: [] } });
    daemon = await startDaemon({ port: 0, stateDir, agents, t3Access });

    const socket = new WebSocket(`ws://127.0.0.1:${daemon.port}/`, { headers: { authorization: `Bearer ${daemon.token}`, origin: EXTENSION_ORIGIN } });
    sockets.push(socket);
    const opened = await new Promise<boolean>((resolve) => {
      socket.once('open', () => resolve(true));
      socket.once('error', () => resolve(false));
    });
    if (opened) {
      for (const method of ['t3.access', 't3.signIn', 't3.signOut']) {
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
