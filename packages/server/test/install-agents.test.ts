import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parse as parseToml } from 'smol-toml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { agentConfigPath, findAgents, installAgent, uninstallAgent } from '../src/install.js';

const server = { command: '/h/t3-tab', args: ['mcp'] };

let root: string;
let home: string;
let codexHome: string;
let bin: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 't3-tab-agents-'));
  home = join(root, 'home');
  codexHome = join(root, 'elsewhere', 'codex');
  bin = join(root, 'bin');
  await mkdir(home, { recursive: true });
  await mkdir(bin, { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** A `codex` that does what `codex mcp add|remove` does: it edits `$CODEX_HOME/config.toml`, else `~/.codex/config.toml`. */
async function fakeCodex(): Promise<void> {
  const script = `#!/bin/sh
dir="\${CODEX_HOME:-$HOME/.codex}"
file="$dir/config.toml"
[ "$1" = mcp ] || exit 2
case "$2" in
  add)
    name="$3"; cmd="$5"; shift 5
    mkdir -p "$dir"
    args=""
    for a in "$@"; do args="$args, \\"$a\\""; done
    printf '\\n[mcp_servers.%s]\\ncommand = "%s"\\nargs = [%s]\\n' "$name" "$cmd" "\${args#, }" >> "$file"
    ;;
  remove)
    [ -f "$file" ] && sed -i "/^\\[mcp_servers\\.$3\\]/,\\$d" "$file"
    ;;
esac
`;
  await writeFile(join(bin, 'codex'), script);
  await chmod(join(bin, 'codex'), 0o755);
}

const env = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({ HOME: home, PATH: `${bin}:/usr/bin:/bin`, ...extra });
const tables = (source: string): Record<string, Record<string, unknown>> => (parseToml(source).mcp_servers ?? {}) as Record<string, Record<string, unknown>>;

describe('where the Codex config is', () => {
  it('is under CODEX_HOME when that is set, and ~/.codex otherwise (also when it is empty)', () => {
    expect(agentConfigPath('codex', home, env({ CODEX_HOME: codexHome }))).toBe(join(codexHome, 'config.toml'));
    expect(agentConfigPath('codex', home, env())).toBe(join(home, '.codex', 'config.toml'));
    expect(agentConfigPath('codex', home, env({ CODEX_HOME: '  ' }))).toBe(join(home, '.codex', 'config.toml'));
    expect(agentConfigPath('claude', home, env({ CODEX_HOME: codexHome }))).toBe(join(home, '.claude.json'));
  });

  it('finds Codex by a config under CODEX_HOME', async () => {
    expect(await findAgents(home, env({ CODEX_HOME: codexHome }))).toEqual([]);
    await mkdir(codexHome, { recursive: true });
    await writeFile(join(codexHome, 'config.toml'), 'model = "x"\n');
    expect(await findAgents(home, env({ CODEX_HOME: codexHome }))).toEqual(['codex']);
    expect(await findAgents(home, env())).toEqual([]);
  });
});

describe('adding and removing Codex', () => {
  it('through a file edit: honours CODEX_HOME and sets the tool timeout above a browser prompt\'s wait', async () => {
    const result = await installAgent({ agent: 'codex', home, env: env({ CODEX_HOME: codexHome }), server });
    expect(result).toEqual({ agent: 'codex', configPath: join(codexHome, 'config.toml'), method: 'file' });
    const entry = tables(await readFile(join(codexHome, 'config.toml'), 'utf8'))['t3-tab'];
    expect(entry).toEqual({ command: '/h/t3-tab', args: ['mcp'], tool_timeout_sec: 330 });
    const removed = await uninstallAgent({ agent: 'codex', home, env: env({ CODEX_HOME: codexHome }) });
    expect(removed.removed).toBe(true);
    expect(tables(await readFile(join(codexHome, 'config.toml'), 'utf8'))['t3-tab']).toBeUndefined();
  });

  it('through `codex mcp add`: finds the entry under CODEX_HOME and adds the timeout key, once', async () => {
    await fakeCodex();
    await mkdir(codexHome, { recursive: true });
    await writeFile(join(codexHome, 'config.toml'), '# mine\nmodel = "gpt-5"\n\n[mcp_servers.other]\ncommand = "o"\n');
    const options = { agent: 'codex' as const, home, env: env({ CODEX_HOME: codexHome }), server };
    expect((await installAgent(options)).method).toBe('cli');
    const first = await readFile(join(codexHome, 'config.toml'), 'utf8');
    expect(first.startsWith('# mine\nmodel = "gpt-5"\n\n[mcp_servers.other]\ncommand = "o"\n')).toBe(true);
    expect(tables(first)['t3-tab']).toEqual({ command: '/h/t3-tab', args: ['mcp'], tool_timeout_sec: 330 });
    await installAgent(options);
    const second = await readFile(join(codexHome, 'config.toml'), 'utf8');
    expect(second.match(/^\[mcp_servers\.t3-tab\]$/gm)).toHaveLength(1);
    expect(second.match(/tool_timeout_sec/g)).toHaveLength(1);
    expect(tables(second).other).toEqual({ command: 'o' });
    expect((await uninstallAgent(options)).removed).toBe(true);
  });

  it('through `codex mcp add` without CODEX_HOME: writes ~/.codex/config.toml with the key', async () => {
    await fakeCodex();
    await installAgent({ agent: 'codex', home, env: env(), server });
    expect(tables(await readFile(join(home, '.codex', 'config.toml'), 'utf8'))['t3-tab']?.tool_timeout_sec).toBe(330);
  });

  it('leaves a timeout the table already has', async () => {
    const table = '[mcp_servers.t3-tab]\ncommand = "/old"\nargs = ["mcp"]\ntool_timeout_sec = 600\n';
    await mkdir(codexHome, { recursive: true });
    await writeFile(join(codexHome, 'config.toml'), table);
    await fakeCodex();
    // The fake re-adds the table after the real flow removes the old one, so check the helper that decides.
    const { ensureCodexToolTimeout } = await import('../src/install-config.js');
    expect(ensureCodexToolTimeout(table)).toBe(table);
  });
});
