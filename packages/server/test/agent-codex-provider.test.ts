import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { tomlValue } from '../src/agents/codex-provider.js';
import { Agents } from '../src/agents/conversations.js';

const CLAIM = 'abcdefghijklmnop1234';
const TOKEN = 'sk-test-provider-token-0123456789';
const TOKEN_VARIABLE = 'T3_TAB_CODEX_PROVIDER_TOKEN';
const DONE = '{"type":"thread.started","thread_id":"cx-1"}\n{"type":"turn.completed"}\n';

const CUSTOM_CONFIG = `
model_provider = "corp"
model = "corp-model"
notify = ["/usr/bin/notify-me", "done"]
approval_policy = "on-request"

[model_providers.corp]
name = "Corp gateway"
base_url = "https://llm.corp.test/v1"
wire_api = "responses"
experimental_bearer_token = "${TOKEN}"
supports_websockets = false
supports_standalone_web_search = true

[model_providers.unused]
name = "Unused"
base_url = "https://unused.test/v1"
experimental_bearer_token = "sk-unused-token"

[mcp_servers.second]
command = "/usr/bin/second-server"

[profiles.work]
model = "profile-model"
`;

interface Spawned {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

let root: string;
let home: string;
let bin: string;
let codexHome: string;
let agents: Agents | undefined;
let spawned: Spawned[];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 't3-tab-codex-provider-'));
  home = join(root, 'home');
  bin = join(root, 'bin');
  codexHome = join(home, '.codex');
  await mkdir(codexHome, { recursive: true });
  await mkdir(bin);
  for (const name of ['codex', 'claude']) {
    await writeFile(join(bin, name), '#!/bin/sh\n');
    await chmod(join(bin, name), 0o755);
  }
  spawned = [];
});

afterEach(async () => {
  await agents?.close();
  agents = undefined;
  await rm(root, { recursive: true, force: true });
});

function fakeSpawn(command: string, args: string[], options: SpawnOptions): ChildProcess {
  spawned.push({ command, args, env: options.env ?? {} });
  const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
  const stdout = new PassThrough();
  child.stdout = stdout;
  child.stderr = new PassThrough();
  child.stdin = new Writable({
    write: (_chunk, _encoding, callback) => callback(),
    final(callback) {
      callback();
      stdout.end(DONE);
      setTimeout(() => child.emit('close', 0), 5);
    },
  });
  child.kill = () => true;
  setImmediate(() => child.emit('spawn'));
  return child as unknown as ChildProcess;
}

function make(extraEnv: NodeJS.ProcessEnv = {}): Agents {
  agents = new Agents({
    env: { PATH: bin, HOME: home, ...extraEnv },
    server: { command: 'node', args: ['/x/cli.js', 'mcp'] },
    spawn: fakeSpawn,
    stateDir: join(root, 'state'),
  });
  return agents;
}

async function config(text: string): Promise<void> {
  await writeFile(join(codexHome, 'config.toml'), text);
}

async function idle(id: string): Promise<void> {
  const end = Date.now() + 4_000;
  while (agents?.list().find((conversation) => conversation.id === id)?.status !== 'idle') {
    if (Date.now() > end) throw new Error('Timed out waiting for the turn to end');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** The `-c` settings of one codex call. */
const settings = (args: string[]): string[] => args.flatMap((value, index) => (args[index - 1] === '-c' ? [value] : []));

describe('a Codex custom provider', () => {
  it('carries the active provider, with its token only in the codex environment', async () => {
    await config(CUSTOM_CONFIG);
    const started = await make().start({ via: 'codex', message: 'Hi', claim: CLAIM });
    await idle(started.id);
    const call = spawned[0] as Spawned;
    const given = settings(call.args);
    for (const expected of [
      'model_provider="corp"',
      'model="corp-model"',
      'model_providers.corp.name="Corp gateway"',
      'model_providers.corp.base_url="https://llm.corp.test/v1"',
      'model_providers.corp.wire_api="responses"',
      'model_providers.corp.supports_websockets=false',
      'model_providers.corp.supports_standalone_web_search=true',
      `model_providers.corp.env_key="${TOKEN_VARIABLE}"`,
    ]) {
      expect(given, expected).toContain(expected);
    }
    expect(call.args.join('\n')).not.toContain(TOKEN);
    expect(call.args.join('\n')).not.toContain('experimental_bearer_token');
    expect(call.env[TOKEN_VARIABLE]).toBe(TOKEN);
  });

  it('keeps the token away from the MCP server and leaves out everything else in the config', async () => {
    await config(CUSTOM_CONFIG);
    const started = await make().start({ via: 'codex', message: 'Hi', claim: CLAIM });
    await idle(started.id);
    const args = (spawned[0] as Spawned).args;
    const server = settings(args).filter((value) => value.startsWith('mcp_servers.'));
    expect(server.length).toBeGreaterThan(0);
    expect(server.join('\n')).not.toContain(TOKEN);
    expect(server.join('\n')).not.toContain(TOKEN_VARIABLE);
    expect(server.every((value) => value.startsWith('mcp_servers.t3-tab.'))).toBe(true);
    expect(server).toContain('mcp_servers.t3-tab.env_vars=[]');
    // Codex builds a stdio MCP server's environment from this list, the entry's `env` and its `env_vars`
    // (`DEFAULT_ENV_VARS` and `create_env_for_mcp_server` in codex-rs/rmcp-client/src/utils.rs, 0.166.0).
    const inherited = ['HOME', 'LOGNAME', 'PATH', 'SHELL', 'USER', 'LANG', 'LC_ALL', 'TERM', 'TMPDIR', 'TZ'];
    const codexEnv = (spawned[0] as Spawned).env;
    const serverEnv = Object.fromEntries(inherited.flatMap((name) => (codexEnv[name] === undefined ? [] : [[name, codexEnv[name]]])));
    expect(codexEnv[TOKEN_VARIABLE]).toBe(TOKEN);
    expect(serverEnv[TOKEN_VARIABLE]).toBeUndefined();
    expect(Object.values(serverEnv)).not.toContain(TOKEN);
    const text = args.join('\n');
    for (const absent of ['second-server', 'mcp_servers.second', 'notify', 'notify-me', 'profile-model', 'profiles', 'unused', 'sk-unused-token', 'on-request']) {
      expect(text, absent).not.toContain(absent);
    }
    expect(args).toContain('--ignore-user-config');
  });

  it('prefers the model chosen in the panel', async () => {
    await config(CUSTOM_CONFIG);
    const started = await make().start({ via: 'codex', message: 'Hi', claim: CLAIM, model: 'panel-model' });
    await idle(started.id);
    const args = (spawned[0] as Spawned).args;
    expect(args[args.indexOf('-m') + 1]).toBe('panel-model');
    expect(settings(args)).not.toContain('model="corp-model"');
    expect(settings(args)).toContain('model_provider="corp"');
  });

  it('carries the provider on a resumed turn too', async () => {
    await config(CUSTOM_CONFIG);
    const started = await make().start({ via: 'codex', message: 'Hi', claim: CLAIM });
    await idle(started.id);
    await agents?.send(started.id, 'Again');
    const end = Date.now() + 4_000;
    while (spawned.length < 2 && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 5));
    const resumed = spawned[1] as Spawned;
    expect(resumed.args[1]).toBe('resume');
    expect(settings(resumed.args)).toContain(`model_providers.corp.env_key="${TOKEN_VARIABLE}"`);
    expect(resumed.args.join('\n')).not.toContain(TOKEN);
    expect(resumed.env[TOKEN_VARIABLE]).toBe(TOKEN);
    await idle(started.id);
  });

  it('reads the config from CODEX_HOME when that is set', async () => {
    const elsewhere = join(root, 'elsewhere');
    await mkdir(elsewhere);
    await writeFile(join(elsewhere, 'config.toml'), CUSTOM_CONFIG);
    const started = await make({ CODEX_HOME: elsewhere }).start({ via: 'codex', message: 'Hi', claim: CLAIM });
    await idle(started.id);
    expect(settings((spawned[0] as Spawned).args)).toContain('model_provider="corp"');
  });

  it('keeps the provider\'s own env_key, which Codex uses before a bearer token', async () => {
    await config(`model_provider = "corp"\n[model_providers.corp]\nname = "Corp"\nbase_url = "https://llm.corp.test/v1"\nenv_key = "CORP_API_KEY"\nexperimental_bearer_token = "${TOKEN}"\n`);
    const started = await make({ CORP_API_KEY: 'from-the-environment' }).start({ via: 'codex', message: 'Hi', claim: CLAIM });
    await idle(started.id);
    const call = spawned[0] as Spawned;
    expect(settings(call.args)).toContain('model_providers.corp.env_key="CORP_API_KEY"');
    expect(call.args.join('\n')).not.toContain(TOKEN);
    expect(call.env[TOKEN_VARIABLE]).toBeUndefined();
  });

  it('moves static HTTP headers into the codex environment', async () => {
    await config(`model_provider = "corp"\n[model_providers.corp]\nbase_url = "https://llm.corp.test/v1"\n[model_providers.corp.http_headers]\nAuthorization = "Bearer ${TOKEN}"\nX-Team = "platform"\n`);
    const started = await make().start({ via: 'codex', message: 'Hi', claim: CLAIM });
    await idle(started.id);
    const call = spawned[0] as Spawned;
    expect(call.args.join('\n')).not.toContain(TOKEN);
    expect(call.args.join('\n')).not.toContain('platform');
    const headers = settings(call.args).find((value) => value.startsWith('model_providers.corp.env_http_headers='));
    const authorization = /"Authorization" = "([A-Z0-9_]+)"/.exec(headers ?? '')?.[1] as string;
    const team = /"X-Team" = "([A-Z0-9_]+)"/.exec(headers ?? '')?.[1] as string;
    expect(call.env[authorization]).toBe(`Bearer ${TOKEN}`);
    expect(call.env[team]).toBe('platform');
  });

  it('warns about a provider setting it does not recognise, and leaves it out', async () => {
    await config(`model_provider = "corp"\n[model_providers.corp]\nbase_url = "https://llm.corp.test/v1"\nfuture_setting = "value-of-it"\n`);
    const started = await make().start({ via: 'codex', message: 'Hi', claim: CLAIM });
    await idle(started.id);
    expect((spawned[0] as Spawned).args.join('\n')).not.toContain('value-of-it');
    const shown = agents?.list().find((conversation) => conversation.id === started.id);
    const warning = shown?.messages.find((message) => message.role === 'error');
    expect(warning?.text).toContain('future_setting');
    expect(warning?.text).not.toContain('value-of-it');
  });

  it.each([
    ['a secret query parameter', `base_url = "https://llm.corp.test/v1"\n[model_providers.corp.query_params]\napi-key = "${TOKEN}"\n`],
    ['a non-string query parameter value', `base_url = "https://llm.corp.test/v1"\n[model_providers.corp.query_params]\nregion = { nested = "${TOKEN}" }\n`],
    ['a numeric query parameter value', `base_url = "https://llm.corp.test/v1"\n[model_providers.corp.query_params]\nversion = 2\n`],
    ['a sig query parameter', `base_url = "https://llm.corp.test/v1"\n[model_providers.corp.query_params]\nsig = "${TOKEN}"\n`],
    ['a code query parameter', `base_url = "https://llm.corp.test/v1"\n[model_providers.corp.query_params]\nCode = "${TOKEN}"\n`],
    ['a password in the address', `base_url = "https://user:${TOKEN}@llm.corp.test/v1"\n`],
    ['a key in the address', `base_url = "https://llm.corp.test/v1?api_key=${TOKEN}"\n`],
    ['a sig query parameter in the address', `base_url = "https://llm.corp.test/v1?SIG=${TOKEN}"\n`],
    ['a code query parameter in the address', `base_url = "https://llm.corp.test/v1?code=${TOKEN}"\n`],
    ['a hash fragment in the address', `base_url = "https://llm.corp.test/v1#access=${TOKEN}"\n`],
    ['a non-table http_headers', `base_url = "https://llm.corp.test/v1"\nhttp_headers = ["Authorization: Bearer ${TOKEN}"]\n`],
    ['a non-table env_http_headers', `base_url = "https://llm.corp.test/v1"\nenv_http_headers = ["Authorization: Bearer ${TOKEN}"]\n`],
    ['a nested table in env_http_headers', `base_url = "https://llm.corp.test/v1"\n[model_providers.corp.env_http_headers]\nX-Auth = { token = "${TOKEN}" }\n`],
    ['an array in env_http_headers', `base_url = "https://llm.corp.test/v1"\n[model_providers.corp.env_http_headers]\nX-Auth = ["${TOKEN}"]\n`],
    ['a number in env_http_headers', `base_url = "https://llm.corp.test/v1"\n[model_providers.corp.env_http_headers]\nX-Auth = 42\n`],
    ['a non-string env_key', `base_url = "https://llm.corp.test/v1"\nenv_key = { token = "${TOKEN}" }\n`],
    ['a sign-in command', `base_url = "https://llm.corp.test/v1"\n[model_providers.corp.auth]\ncommand = "/usr/bin/get-token"\nargs = ["${TOKEN}"]\n`],
  ])('refuses to start rather than put %s on the command line', async (_name, table) => {
    await config(`model_provider = "corp"\n[model_providers.corp]\n${table}`);
    const failure = await make().start({ via: 'codex', message: 'Hi', claim: CLAIM }).catch((error: Error) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain('corp');
    expect((failure as Error).message).not.toContain(TOKEN);
    expect((failure as Error).message).not.toContain('42');
    expect(spawned).toEqual([]);
  });

  it('uses the bearer token route when env_key is empty and omits the empty env_key', async () => {
    await config(
      `model_provider = "corp"\n[model_providers.corp]\nbase_url = "https://llm.corp.test/v1"\nenv_key = ""\nexperimental_bearer_token = "${TOKEN}"\n`,
    );
    const started = await make().start({ via: 'codex', message: 'Hi', claim: CLAIM });
    await idle(started.id);
    const call = spawned[0] as Spawned;
    const given = settings(call.args);
    expect(given).toContain(`model_providers.corp.env_key="${TOKEN_VARIABLE}"`);
    expect(given).not.toContain('model_providers.corp.env_key=""');
    expect(call.args.join('\n')).not.toContain(TOKEN);
    expect(call.env[TOKEN_VARIABLE]).toBe(TOKEN);
  });

  it('builds env_http_headers with a null-prototype map so __proto__ keys are kept safely', async () => {
    await config(
      `model_provider = "corp"\n[model_providers.corp]\nbase_url = "https://llm.corp.test/v1"\n[model_providers.corp.env_http_headers]\n"__proto__" = "PROTO_VAR"\nX-Ok = "OK_VAR"\n`,
    );
    const started = await make().start({ via: 'codex', message: 'Hi', claim: CLAIM });
    await idle(started.id);
    const call = spawned[0] as Spawned;
    const headers = settings(call.args).find((value) => value.startsWith('model_providers.corp.env_http_headers='));
    expect(headers).toBe('model_providers.corp.env_http_headers={ "__proto__" = "PROTO_VAR", "X-Ok" = "OK_VAR" }');
  });

  it('parses a config with an unrelated integer outside the safe JS range', async () => {
    await config(`other_id = 9007199254740993\n${CUSTOM_CONFIG}`);
    const started = await make().start({ via: 'codex', message: 'Hi', claim: CLAIM });
    await idle(started.id);
    const call = spawned[0] as Spawned;
    expect(settings(call.args)).toContain('model_provider="corp"');
    expect(call.env[TOKEN_VARIABLE]).toBe(TOKEN);
  });

  it('allows benign query parameters whose names only contain sig or code as substrings', async () => {
    await config(
      `model_provider = "corp"\n[model_providers.corp]\nbase_url = "https://llm.corp.test/v1?design=v2&unicode=utf8"\n[model_providers.corp.query_params]\nencode = "utf8"\n`,
    );
    const started = await make().start({ via: 'codex', message: 'Hi', claim: CLAIM });
    await idle(started.id);
    const given = settings((spawned[0] as Spawned).args);
    expect(given).toContain('model_providers.corp.base_url="https://llm.corp.test/v1?design=v2&unicode=utf8"');
    expect(given).toContain('model_providers.corp.query_params={ "encode" = "utf8" }');
  });

  it('escapes control characters in inline-table keys the same way as string values', () => {
    expect(tomlValue({ 'a\u007fb': 'c\u007fd' })).toBe('{ "a\\u007Fb" = "c\\u007Fd" }');
  });

  it('refuses a config it cannot parse, without repeating its content', async () => {
    await config(`model_provider = "corp\nexperimental_bearer_token = "${TOKEN}"\n`);
    const failure = await make().start({ via: 'codex', message: 'Hi', claim: CLAIM }).catch((error: Error) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain('config.toml');
    expect((failure as Error).message).not.toContain(TOKEN);
    expect(spawned).toEqual([]);
  });

  it.each([
    ['no config file', undefined],
    ['no provider selected', 'model = "gpt-test"\nnotify = ["/usr/bin/notify-me"]\n[mcp_servers.second]\ncommand = "/usr/bin/second-server"\n'],
    ['a built-in provider', 'model_provider = "openai"\nmodel = "gpt-test"\n'],
  ])('adds nothing with %s', async (_name, text) => {
    if (text !== undefined) await config(text);
    const started = await make().start({ via: 'codex', message: 'Hi', claim: CLAIM });
    await idle(started.id);
    const call = spawned[0] as Spawned;
    const given = settings(call.args);
    expect(given.filter((value) => value.startsWith('model'))).toEqual([]);
    expect(call.args.join('\n')).not.toContain('gpt-test');
    expect(call.args.join('\n')).not.toContain('second-server');
    expect(call.env[TOKEN_VARIABLE]).toBeUndefined();
  });

  it('gives a Claude Code run nothing from the Codex config', async () => {
    await config(CUSTOM_CONFIG);
    const started = await make().start({ via: 'claude', message: 'Hi', claim: CLAIM });
    const call = spawned[0] as Spawned;
    expect(call.args.join('\n')).not.toContain('corp');
    expect(call.env[TOKEN_VARIABLE]).toBeUndefined();
    expect(started.via).toBe('claude');
  });
});
