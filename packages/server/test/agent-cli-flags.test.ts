import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it, type TestContext } from 'vitest';

import { readCodexProvider } from '../src/agents/codex-provider.js';
import { claudeArgs, codexArgs } from '../src/agents/commands.js';
import { readHelp, resolveForHelp, type HelpTarget } from './cli-help.js';

// Reads the installed CLIs' `--help`, and Codex's `features list`, under a temporary HOME. Neither starts a session.
// A CLI that is missing, is only a version-manager shim, or does not answer in a few seconds is skipped with the reason.
const server = { command: 'node', args: ['/x/cli.js', 'mcp'] };
const claude = await resolveForHelp('claude', process.env);
const codex = await resolveForHelp('codex', process.env);
let home: string;

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 't3-tab-cli-help-'));
});

afterAll(async () => {
  await rm(home, { recursive: true, force: true });
});

function helpEnv(): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH ?? '', HOME: home, XDG_CONFIG_HOME: join(home, 'config'), XDG_STATE_HOME: join(home, 'state'), CODEX_HOME: home };
}

async function output(context: TestContext, target: HelpTarget, args: string[]): Promise<string> {
  if ('skip' in target) return context.skip(target.skip);
  const result = await readHelp(target.path, args, helpEnv());
  if ('skip' in result) return context.skip(result.skip);
  return result.text;
}

// Codex 0.166.0 keeps `unified_exec` on whatever the flag says (only managed requirements can pin it off). It is not
// the gate: Codex registers no shell tool of either kind while `shell_tool` is off (`add_shell_tools` in core/src/tools/spec_plan.rs).
const FORCED_ON = new Set(['unified_exec']);

const flagsOf = (args: string[]): string[] => [...new Set(args.filter((value) => value.startsWith('--')).map((value) => value.split('=')[0] as string))];

describe('the flags direct runs depend on', () => {
  it('are all in `claude --help`', async (context) => {
    const text = await output(context, claude, ['--help']);
    const flags = flagsOf(claudeArgs({ server, env: {}, model: 'm', resume: 'r', imageInput: true }));
    expect(flags.length).toBeGreaterThanOrEqual(10);
    for (const flag of flags) expect(text, flag).toContain(flag);
    expect(text).toContain('"dontAsk"');
  }, 30_000);

  it('are all in `codex exec --help`', async (context) => {
    const text = await output(context, codex, ['exec', '--help']);
    const flags = flagsOf(codexArgs({ server, env: {}, imageFiles: ['/x/a.png'] }));
    expect(flags.length).toBeGreaterThanOrEqual(5);
    for (const flag of flags) expect(text, flag).toContain(flag);
  }, 30_000);

  it('are all in `codex exec resume --help`', async (context) => {
    const text = await output(context, codex, ['exec', 'resume', '--help']);
    for (const flag of flagsOf(codexArgs({ server, env: {}, resume: 'r', imageFiles: ['/x/a.png'] }))) expect(text, flag).toContain(flag);
  }, 30_000);

  it('name only Codex features that exist, and turn each one off', async (context) => {
    const args = codexArgs({ server, env: {} });
    const disabled = args.flatMap((value, index) => (args[index - 1] === '--disable' ? [value] : []));
    expect(disabled.length).toBeGreaterThanOrEqual(10);
    const text = await output(context, codex, [...disabled.flatMap((feature) => ['--disable', feature]), 'features', 'list']);
    const states = new Map(
      text.split('\n').flatMap((line): Array<[string, string]> => {
        const columns = line.trim().split(/\s+/);
        return columns.length >= 3 ? [[columns[0] as string, columns.at(-1) as string]] : [];
      }),
    );
    for (const feature of disabled) {
      expect(states.has(feature), feature).toBe(true);
      if (!FORCED_ON.has(feature)) expect(states.get(feature), feature).toBe('false');
    }
    expect(states.get('shell_tool')).toBe('false');
  }, 30_000);
});

describe('a custom Codex provider', () => {
  it('is accepted by the installed Codex when passed as `-c` settings', async (context) => {
    const source = join(home, 'provider-source');
    await mkdir(source, { recursive: true });
    await writeFile(
      join(source, 'config.toml'),
      'model_provider = "corp"\nmodel = "corp-model"\n[model_providers.corp]\nname = "Corp"\nbase_url = "https://llm.corp.test/v1"\nwire_api = "responses"\nexperimental_bearer_token = "not-a-real-token"\nsupports_websockets = false\nsupports_standalone_web_search = false\n[model_providers.corp.http_headers]\nX-Team = "platform"\n',
    );
    const codexProvider = await readCodexProvider({ CODEX_HOME: source });
    const args = codexArgs({ server, env: {}, codexProvider });
    const overrides = args.flatMap((value, index) => (args[index - 1] === '-c' ? ['-c', value] : []));
    expect(overrides).toContain('model_provider="corp"');
    expect(overrides.join(' ')).not.toContain('not-a-real-token');
    // `features list` loads the whole config, and fails on a selected provider that did not arrive or does not parse.
    await output(context, codex, [...overrides, 'features', 'list']);
    await expect(output(context, codex, ['-c', 'model_provider="corp"', 'features', 'list'])).rejects.toThrow();
  }, 30_000);
});

describe('finding a CLI to ask for its help', () => {
  let root: string;
  let marker: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 't3-tab-cli-shim-'));
    marker = join(root, 'downloaded');
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function script(path: string, body: string): Promise<void> {
    await writeFile(path, `#!/bin/sh\n${body}\n`);
    await chmod(path, 0o755);
  }

  /** A `mise` whose shims download when run; `which` prints `located`, or fails as for a tool not installed. */
  async function miseShim(name: string, located?: string): Promise<string> {
    const dir = join(root, name);
    const shims = join(dir, 'shims');
    await mkdir(shims, { recursive: true });
    const mise = join(dir, 'mise');
    await script(mise, `if [ "$1" = which ]; then ${located === undefined ? 'exit 1' : `echo "${located}"`}; exit 0; fi\ntouch "${marker}"\nsleep 30`);
    await symlink(mise, join(shims, 'claude'));
    return shims;
  }

  it('does not run a shim whose real file cannot be found, and says why', async () => {
    const shims = await miseShim('unresolved');
    const target = await resolveForHelp('claude', { PATH: shims, HOME: root });
    expect(target).toEqual({ skip: expect.stringContaining('version-manager shim') });
    expect(existsSync(marker)).toBe(false);
  });

  it('follows a shim to the real file', async () => {
    const real = join(root, 'real-claude');
    await script(real, 'echo real help');
    const shims = await miseShim('resolved', real);
    expect(await resolveForHelp('claude', { PATH: shims, HOME: root })).toEqual({ path: real });
    expect(existsSync(marker)).toBe(false);
  });

  it('does not run a wrapper script that fetches its tool', async () => {
    const dir = join(root, 'wrapper');
    await mkdir(dir);
    await script(join(dir, 'claude'), `touch "${marker}"\nexec npx --yes some-agent "$@"`);
    expect(await resolveForHelp('claude', { PATH: dir, HOME: root })).toEqual({ skip: expect.stringContaining('may download') });
    expect(existsSync(marker)).toBe(false);
  });

  it('skips a CLI that does not answer in time', async () => {
    const slow = join(root, 'slow');
    await script(slow, 'exec sleep 30');
    expect(await readHelp(slow, ['--help'], { PATH: process.env.PATH ?? '' }, 200)).toEqual({ skip: expect.stringContaining('did not answer within 200 ms') });
  });

  it('reports a CLI that answers with an error', async () => {
    const broken = join(root, 'broken');
    await script(broken, 'exit 3');
    await expect(readHelp(broken, ['--help'], { PATH: process.env.PATH ?? '' })).rejects.toThrow();
  });
});
