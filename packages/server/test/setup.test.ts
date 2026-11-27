import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AgentsStatus, SetupStatus } from '@t3-tab/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Setup } from '../src/setup.js';

let root: string;
let home: string;
let env: NodeJS.ProcessEnv;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 't3-tab-setup-'));
  home = join(root, 'home');
  await mkdir(home, { recursive: true });
  env = { HOME: home, PATH: '', T3CODE_HOME: join(root, 't3') };
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const server = { command: '/usr/bin/node', args: ['/x/cli.js', 'mcp'] };
const probe = (t3: AgentsStatus['t3']) => ({ status: async (): Promise<AgentsStatus> => ({ t3 }) });
const found = (...names: string[]) => async (name: string): Promise<string | undefined> => (names.includes(name) ? `/bin/${name}` : undefined);

async function recordT3(origin: string): Promise<void> {
  await mkdir(join(root, 't3', 'userdata'), { recursive: true });
  await writeFile(join(root, 't3', 'userdata', 'server-runtime.json'), JSON.stringify({ version: 1, origin, pid: process.pid, startedAt: new Date().toISOString() }));
}

describe('setup status', () => {
  it('reports which agents are found and which have the t3-tab entry in their user config', async () => {
    await writeFile(join(home, '.claude.json'), JSON.stringify({ mcpServers: { 't3-tab': { type: 'stdio', command: 'x', args: [] }, other: {} } }));
    await mkdir(join(home, '.codex'), { recursive: true });
    await writeFile(join(home, '.codex', 'config.toml'), '[mcp_servers.other]\ncommand = "y"\n');
    const status = await new Setup({ env, server, agents: probe({ state: 'stopped' }), find: found('claude', 'codex') }).status();
    expect(status.agents).toEqual([
      { id: 'claude', found: true, registered: true },
      { id: 'codex', found: true, registered: false },
    ]);
  });

  it('reads the config files and starts no agent command', async () => {
    // A `claude` that records every start would show if the status ran it.
    const bin = join(root, 'bin');
    await mkdir(bin);
    await writeFile(join(bin, 'claude'), `#!/bin/sh\necho ran >> "${join(root, 'ran')}"\n`);
    await chmod(join(bin, 'claude'), 0o755);
    await new Setup({ env: { ...env, PATH: bin }, server, agents: probe({ state: 'missing' }) }).status();
    expect(existsSync(join(root, 'ran'))).toBe(false);
  });

  it('treats a config it cannot parse as not registered, and a missing agent as not found', async () => {
    await writeFile(join(home, '.claude.json'), '{ not json');
    const status = await new Setup({ env, server, agents: probe({ state: 'missing' }), find: found() }).status();
    expect(status.agents).toEqual([
      { id: 'claude', found: false, registered: false },
      { id: 'codex', found: false, registered: false },
    ]);
    expect(status.t3).toEqual({ state: 'missing' });
  });

  it('gives T3 Code its address from server-runtime.json only while it runs', async () => {
    await recordT3('http://127.0.0.1:3773');
    expect((await new Setup({ env, server, agents: probe({ state: 'running' }), find: found() }).status()).t3).toEqual({
      state: 'running',
      origin: 'http://127.0.0.1:3773',
    });
    expect((await new Setup({ env, server, agents: probe({ state: 'stopped' }), find: found() }).status()).t3).toEqual({ state: 'stopped' });
  });

  it('gives no address for one T3-Tab would not send anything to', async () => {
    await recordT3('http://192.168.1.5:3773');
    expect((await new Setup({ env, server, agents: probe({ state: 'running' }), find: found() }).status()).t3).toEqual({ state: 'running' });
  });

  it('passes the refresh request to T3 Code\'s own probe', async () => {
    const seen: boolean[] = [];
    const agents = { status: async (refresh?: boolean): Promise<AgentsStatus> => (seen.push(refresh === true), { t3: { state: 'missing' } }) };
    await new Setup({ env, server, agents, find: found() }).status(true);
    expect(seen).toEqual([true]);
  });
});

describe('adding one agent', () => {
  it('registers t3-tab in that agent\'s config as `t3-tab install --codex` does, and in nothing else', async () => {
    const setup = new Setup({ env, server, agents: probe({ state: 'missing' }), find: found('claude', 'codex') });
    const status: SetupStatus = await setup.addAgent('codex');
    expect(status.agents).toEqual([
      { id: 'claude', found: true, registered: false },
      { id: 'codex', found: true, registered: true },
    ]);
    expect(await readFile(join(home, '.codex', 'config.toml'), 'utf8')).toBe(
      '[mcp_servers.t3-tab]\ncommand = "/usr/bin/node"\nargs = ["/x/cli.js", "mcp"]\ntool_timeout_sec = 330\n',
    );
    expect(existsSync(join(home, '.claude.json'))).toBe(false);
    // The browser link is not touched.
    expect(existsSync(join(home, '.config'))).toBe(false);
    expect(existsSync(join(home, '.local'))).toBe(false);
  });

  it('writes Codex\'s entry under CODEX_HOME when that is set', async () => {
    const codexHome = join(root, 'codex-home');
    const setup = new Setup({ env: { ...env, CODEX_HOME: codexHome }, server, agents: probe({ state: 'missing' }), find: found('codex') });
    const status = await setup.addAgent('codex');
    expect(status.agents.find((agent) => agent.id === 'codex')?.registered).toBe(true);
    expect(await readFile(join(codexHome, 'config.toml'), 'utf8')).toContain('[mcp_servers.t3-tab]');
    expect(existsSync(join(home, '.codex'))).toBe(false);
  });

  it('keeps the rest of a Claude Code config', async () => {
    await writeFile(join(home, '.claude.json'), JSON.stringify({ theme: 'dark', mcpServers: { other: { type: 'stdio', command: 'o', args: [] } } }));
    await new Setup({ env, server, agents: probe({ state: 'missing' }), find: found('claude') }).addAgent('claude');
    const config = JSON.parse(await readFile(join(home, '.claude.json'), 'utf8')) as { theme: string; mcpServers: Record<string, unknown> };
    expect(config.theme).toBe('dark');
    expect(Object.keys(config.mcpServers).sort()).toEqual(['other', 't3-tab']);
  });

  it('is repeatable and refuses anything but the two agents', async () => {
    const setup = new Setup({ env, server, agents: probe({ state: 'missing' }), find: found('codex') });
    await setup.addAgent('codex');
    await setup.addAgent('codex');
    expect((await readFile(join(home, '.codex', 'config.toml'), 'utf8')).match(/\[mcp_servers\.t3-tab\]/g)).toHaveLength(1);
    await expect(setup.addAgent('t3')).rejects.toThrow('Choose Claude Code or Codex');
    await expect(setup.addAgent(undefined)).rejects.toThrow('Choose Claude Code or Codex');
  });
});
