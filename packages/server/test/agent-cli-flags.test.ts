import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { claudeArgs, codexArgs } from '../src/agents/commands.js';
import { findExecutable } from '../src/agents/locate.js';

// Reads the installed CLIs' `--help` only, under a temporary HOME; it never starts a session. Skipped where a CLI is
// not installed, such as CI.
const exec = promisify(execFile);
const server = { command: 'node', args: ['/x/cli.js', 'mcp'] };
const claude = await findExecutable('claude', process.env);
const codex = await findExecutable('codex', process.env);
let home: string;

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 't3-tab-cli-help-'));
});

afterAll(async () => {
  await rm(home, { recursive: true, force: true });
});

async function help(command: string, args: string[]): Promise<string> {
  const { stdout, stderr } = await exec(command, [...args, '--help'], {
    env: { PATH: process.env.PATH ?? '', HOME: home, XDG_CONFIG_HOME: join(home, 'config'), XDG_STATE_HOME: join(home, 'state'), CODEX_HOME: home },
    timeout: 20_000,
    maxBuffer: 4 * 1_024 * 1_024,
  });
  return `${stdout}\n${stderr}`;
}

const flagsOf = (args: string[]): string[] => [...new Set(args.filter((value) => value.startsWith('--')))];

describe('the flags direct runs depend on', () => {
  it.skipIf(claude === undefined)('are all in `claude --help`', async () => {
    const text = await help(claude as string, []);
    const flags = flagsOf(claudeArgs({ server, env: {}, model: 'm', resume: 'r' }));
    expect(flags.length).toBeGreaterThanOrEqual(10);
    for (const flag of flags) expect(text, flag).toContain(flag);
    expect(text).toContain('"dontAsk"');
  }, 30_000);

  it.skipIf(codex === undefined)('are all in `codex exec --help`', async () => {
    const text = await help(codex as string, ['exec']);
    const flags = flagsOf(codexArgs({ server, env: {} }));
    expect(flags.length).toBeGreaterThanOrEqual(5);
    for (const flag of flags) expect(text, flag).toContain(flag);
  }, 30_000);

  it.skipIf(codex === undefined)('are all in `codex exec resume --help`', async () => {
    const text = await help(codex as string, ['exec', 'resume']);
    for (const flag of flagsOf(codexArgs({ server, env: {}, resume: 'r' }))) expect(text, flag).toContain(flag);
  }, 30_000);
});
