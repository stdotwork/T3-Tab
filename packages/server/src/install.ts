import { spawn } from 'node:child_process';
import {
  access,
  chmod,
  mkdir,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
  constants as fsConstants,
} from 'node:fs/promises';
import { delimiter, dirname, join } from 'node:path';

import { EXTENSION_ID, NATIVE_HOST_NAME } from '@t3-tab/protocol';

import { tomlString } from './toml.js';

export type SupportedBrowser = 'chromium' | 'chrome' | 'brave';
export type Agent = 'claude' | 'codex';
export type InstallMethod = 'cli' | 'file';

export interface McpCommand {
  command: string;
  args: string[];
}

export interface InstallNativeHostOptions {
  browser: SupportedBrowser;
  home: string;
  cliPath: string;
}

export interface InstallAgentOptions {
  agent: Agent;
  home: string;
  env: NodeJS.ProcessEnv;
  server: McpCommand;
}

export interface UninstallAgentOptions {
  agent: Agent;
  home: string;
  env: NodeJS.ProcessEnv;
}

export interface AgentInstallResult {
  agent: Agent;
  configPath: string;
  method: InstallMethod;
}

export interface AgentUninstallResult {
  agent: Agent;
  configPath: string;
  method: InstallMethod;
  removed: boolean;
}

export interface NativeHostPaths {
  launcherPath: string;
  manifestDirectory: string;
  manifestPath: string;
}

const CLAUDE_SERVER_NAME = 't3-tab';
const CODEX_SERVER_NAME = 't3-tab';
const AGENTS: readonly Agent[] = ['claude', 'codex'];
const BROWSERS: readonly SupportedBrowser[] = ['chromium', 'chrome', 'brave'];
const BROWSER_EXECUTABLES: Record<SupportedBrowser, readonly string[]> = {
  chromium: ['chromium', 'chromium-browser'],
  chrome: ['google-chrome', 'google-chrome-stable'],
  brave: ['brave', 'brave-browser', 'brave-browser-stable'],
};

export async function installNativeHost(options: InstallNativeHostOptions): Promise<string> {
  const paths = nativeHostPaths(options.browser, options.home);
  await mkdir(dirname(paths.launcherPath), { recursive: true, mode: 0o700 });
  await writeFile(paths.launcherPath, nativeHostLauncher(process.execPath, options.cliPath), { mode: 0o755 });
  await chmod(paths.launcherPath, 0o755);

  const manifest = {
    name: NATIVE_HOST_NAME,
    description: 'T3-Tab browser link',
    path: paths.launcherPath,
    type: 'stdio',
    allowed_origins: [`chrome-extension://${EXTENSION_ID}/`],
  };
  await mkdir(paths.manifestDirectory, { recursive: true, mode: 0o700 });
  await writeFile(paths.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 });
  await chmod(paths.manifestPath, 0o644);
  return paths.manifestPath;
}

export function nativeHostPaths(browser: SupportedBrowser, home: string): NativeHostPaths {
  const hostDirectory = join(home, '.local', 'share', 't3-tab');
  const manifestDirectory = join(home, '.config', browserConfigDirectory(browser), 'NativeMessagingHosts');
  return {
    launcherPath: join(hostDirectory, 'native-host'),
    manifestDirectory,
    manifestPath: join(manifestDirectory, `${NATIVE_HOST_NAME}.json`),
  };
}

export async function uninstallNativeHosts(home: string): Promise<SupportedBrowser[]> {
  const removed: SupportedBrowser[] = [];
  for (const browser of BROWSERS) {
    const paths = nativeHostPaths(browser, home);
    let manifest: unknown;
    try {
      manifest = JSON.parse(await readFile(paths.manifestPath, 'utf8'));
    } catch {
      continue;
    }
    if (!isNativeHostManifest(manifest, paths.launcherPath)) continue;
    await unlink(paths.manifestPath).catch(() => undefined);
    removed.push(browser);
  }
  await unlink(nativeHostPaths('chromium', home).launcherPath).catch(() => undefined);
  return removed;
}

export async function installAgent(options: InstallAgentOptions): Promise<AgentInstallResult> {
  const configPath = agentConfigPath(options.agent, options.home);
  const executable = await executableOnPath(options.agent, options.env);
  if (executable === undefined) {
    await editAgentConfig(options.agent, configPath, options.server, 'install');
    return { agent: options.agent, configPath, method: 'file' };
  }

  if (await hasAgentServer(options.agent, configPath)) {
    await removeAgentWithCli(options.agent, executable, options.env);
  }
  await addAgentWithCli(options.agent, executable, options.server, options.env);
  if (!(await hasAgentServer(options.agent, configPath))) {
    throw new Error(`${agentName(options.agent)} did not write t3-tab to ${configPath}`);
  }
  return { agent: options.agent, configPath, method: 'cli' };
}

export async function uninstallAgent(options: UninstallAgentOptions): Promise<AgentUninstallResult> {
  const configPath = agentConfigPath(options.agent, options.home);
  const executable = await executableOnPath(options.agent, options.env);
  const present = await hasAgentServer(options.agent, configPath);
  if (executable !== undefined) {
    if (present) await removeAgentWithCli(options.agent, executable, options.env);
    return { agent: options.agent, configPath, method: 'cli', removed: present };
  }

  const removed = await editAgentConfig(options.agent, configPath, undefined, 'uninstall');
  return { agent: options.agent, configPath, method: 'file', removed };
}

export function agentConfigPath(agent: Agent, home: string): string {
  return agent === 'claude' ? join(home, '.claude.json') : join(home, '.codex', 'config.toml');
}

export function agentName(agent: Agent): string {
  return agent === 'claude' ? 'Claude Code' : 'Codex';
}

export async function agentInstallMethod(
  agent: Agent,
  env: NodeJS.ProcessEnv,
): Promise<InstallMethod> {
  return (await executableOnPath(agent, env)) === undefined ? 'file' : 'cli';
}

export async function findAgents(home: string, env: NodeJS.ProcessEnv): Promise<Agent[]> {
  const found: Agent[] = [];
  for (const agent of AGENTS) {
    if ((await executableOnPath(agent, env)) !== undefined || (await fileExists(agentConfigPath(agent, home)))) {
      found.push(agent);
    }
  }
  return found;
}

export async function findBrowsers(home: string, env: NodeJS.ProcessEnv): Promise<SupportedBrowser[]> {
  const found: SupportedBrowser[] = [];
  for (const browser of BROWSERS) {
    const hasExecutable = await anyExecutableOnPath(BROWSER_EXECUTABLES[browser], env);
    if (hasExecutable || (await fileExists(dirname(nativeHostPaths(browser, home).manifestDirectory)))) {
      found.push(browser);
    }
  }
  return found;
}

export function addClaudeServer(source: string, server: McpCommand): string {
  const config = parseClaudeConfig(source);
  const mcpServers = ensureMcpServers(config);
  mcpServers[CLAUDE_SERVER_NAME] = {
    type: 'stdio',
    command: server.command,
    args: server.args,
    env: {},
  };
  return `${JSON.stringify(config, null, 2)}\n`;
}

export function removeClaudeServer(source: string): string {
  const config = parseClaudeConfig(source);
  const mcpServers = config.mcpServers;
  if (!isRecord(mcpServers) || !Object.hasOwn(mcpServers, CLAUDE_SERVER_NAME)) return source;
  delete mcpServers[CLAUDE_SERVER_NAME];
  return `${JSON.stringify(config, null, 2)}\n`;
}

export function addCodexServer(source: string, server: McpCommand): string {
  const block = codexServerBlock(server);
  const range = findCodexServerRange(source);
  if (range === undefined) return appendCodexServer(source, block);
  const before = ensureBlankLineBefore(source.slice(0, range.start));
  const after = removeCodexServer(source.slice(range.end));
  return `${before}${block}${ensureBlankLineAfter(after)}`;
}

export function removeCodexServer(source: string): string {
  let current = source;
  for (;;) {
    const range = findCodexServerRange(current);
    if (range === undefined) return current;
    const before = current.slice(0, range.start);
    const after = current.slice(range.end);
    current = after.length === 0 ? before.replace(/\n\n$/, '\n') : `${before}${after}`;
  }
}

export function codexServerBlock(server: McpCommand): string {
  const args = server.args.map(tomlString).join(', ');
  return `[mcp_servers.${CODEX_SERVER_NAME}]\ncommand = ${tomlString(server.command)}\nargs = [${args}]\n`;
}

function parseClaudeConfig(source: string): Record<string, unknown> {
  const parsed: unknown = source.trim() === '' ? {} : JSON.parse(source);
  if (!isRecord(parsed)) throw new Error('Claude Code config must contain a JSON object');
  return parsed;
}

function ensureMcpServers(config: Record<string, unknown>): Record<string, unknown> {
  const existing = config.mcpServers;
  if (existing === undefined) {
    const created: Record<string, unknown> = {};
    config.mcpServers = created;
    return created;
  }
  if (!isRecord(existing)) throw new Error('mcpServers must be an object');
  return existing;
}

function findCodexServerRange(source: string): { start: number; end: number } | undefined {
  const lines = linesWithOffsets(source);
  const first = lines.findIndex((line) => {
    const key = tableKey(line.text);
    return key !== undefined && isT3TabHeader(key);
  });
  if (first === -1) return undefined;

  let boundary = lines.length;
  for (let index = first + 1; index < lines.length; index += 1) {
    const key = tableKey(lines[index]?.text ?? '');
    if (key !== undefined && !isT3TabHeader(key)) {
      boundary = index;
      while (boundary > first + 1 && (lines[boundary - 1]?.text.trimStart().startsWith('#') ?? false)) {
        boundary -= 1;
      }
      break;
    }
  }

  let start = first;
  while (start > 0 && (lines[start - 1]?.text.trimStart().startsWith('#') ?? false)) {
    start -= 1;
  }

  return {
    start: lines[start]?.start ?? 0,
    end: boundary < lines.length ? (lines[boundary]?.start ?? source.length) : source.length,
  };
}

function appendCodexServer(source: string, block: string): string {
  if (source === '') return block;
  return `${ensureBlankLineBefore(source)}${block}`;
}

function ensureBlankLineBefore(value: string): string {
  if (value === '') return '';
  if (value.endsWith('\n\n')) return value;
  return value.endsWith('\n') ? `${value}\n` : `${value}\n\n`;
}

function ensureBlankLineAfter(value: string): string {
  if (value === '') return '';
  return value.startsWith('\n') ? value : `\n${value}`;
}

function linesWithOffsets(source: string): Array<{ text: string; start: number }> {
  const lines: Array<{ text: string; start: number }> = [];
  let start = 0;
  while (start < source.length) {
    const newline = source.indexOf('\n', start);
    const end = newline === -1 ? source.length : newline + 1;
    lines.push({ text: source.slice(start, end), start });
    start = end;
  }
  return lines;
}

function tableKey(line: string): string | undefined {
  const trimmed = line.trimStart();
  if (!trimmed.startsWith('[') || trimmed.startsWith('[[')) return undefined;
  let quote: '"' | "'" | undefined;
  let escaped = false;
  for (let index = 1; index < trimmed.length; index += 1) {
    const character = trimmed[index];
    if (quote === '"') {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote) quote = undefined;
    } else if (quote === "'") {
      if (character === quote) quote = undefined;
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === ']') {
      return trimmed.slice(1, index).trim();
    } else if (character === '#') {
      return undefined;
    }
  }
  return undefined;
}

function isT3TabHeader(key: string): boolean {
  return /^(?:"mcp_servers"|'mcp_servers'|mcp_servers)\s*\.\s*(?:"t3-tab"|'t3-tab'|t3-tab)(?:\s*\.|$)/.test(
    key,
  );
}

async function editAgentConfig(
  agent: Agent,
  configPath: string,
  server: McpCommand | undefined,
  action: 'install' | 'uninstall',
): Promise<boolean> {
  const source = await readOptional(configPath);
  const current = source ?? '';
  let updated: string;
  if (agent === 'claude') {
    updated =
      action === 'install'
        ? addClaudeServer(current, requireServer(server))
        : removeClaudeServer(current);
  } else {
    updated =
      action === 'install'
        ? addCodexServer(current, requireServer(server))
        : removeCodexServer(current);
  }
  if (updated === current && (source !== undefined || updated === '')) return false;
  await writeConfig(configPath, updated);
  return action === 'uninstall';
}

async function hasAgentServer(agent: Agent, configPath: string): Promise<boolean> {
  const source = await readOptional(configPath);
  if (source === undefined) return false;
  if (agent === 'claude') {
    const config = parseClaudeConfig(source);
    return isRecord(config.mcpServers) && Object.hasOwn(config.mcpServers, CLAUDE_SERVER_NAME);
  }
  return findCodexServerRange(source) !== undefined;
}

async function addAgentWithCli(
  agent: Agent,
  executable: string,
  server: McpCommand,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const args =
    agent === 'claude'
      ? ['mcp', 'add', '--scope', 'user', CLAUDE_SERVER_NAME, '--', server.command, ...server.args]
      : ['mcp', 'add', CODEX_SERVER_NAME, '--', server.command, ...server.args];
  await runCommand(executable, args, env);
}

async function removeAgentWithCli(
  agent: Agent,
  executable: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const args =
    agent === 'claude'
      ? ['mcp', 'remove', '--scope', 'user', CLAUDE_SERVER_NAME]
      : ['mcp', 'remove', CODEX_SERVER_NAME];
  await runCommand(executable, args, env);
}

async function executableOnPath(name: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const paths = (env.PATH ?? '').split(delimiter).filter(Boolean);
  for (const directory of paths) {
    const candidate = join(directory, name);
    try {
      await access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // Keep looking for another PATH entry.
    }
  }
  return undefined;
}

async function anyExecutableOnPath(names: readonly string[], env: NodeJS.ProcessEnv): Promise<boolean> {
  for (const name of names) {
    if ((await executableOnPath(name, env)) !== undefined) return true;
  }
  return false;
}

async function runCommand(
  executable: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolve();
      else {
        const details = stderr.trim() || stdout.trim();
        reject(new Error(`${executable} ${args.join(' ')} exited ${code ?? 'without a status'}${details ? `: ${details}` : ''}`));
      }
    });
  });
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return undefined;
    throw error;
  }
}

async function writeConfig(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  let mode = 0o600;
  try {
    mode = (await stat(path)).mode & 0o777;
  } catch {
    // A new agent config is private to the user.
  }
  try {
    await writeFile(temporary, content, { mode });
    await chmod(temporary, mode);
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNativeHostManifest(value: unknown, launcherPath: string): boolean {
  if (!isRecord(value)) return false;
  return value.name === NATIVE_HOST_NAME && value.path === launcherPath && value.type === 'stdio';
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code;
}

function requireServer(server: McpCommand | undefined): McpCommand {
  if (server === undefined) throw new Error('An MCP server command is required');
  return server;
}

function browserConfigDirectory(browser: SupportedBrowser): string {
  switch (browser) {
    case 'chromium':
      return 'chromium';
    case 'chrome':
      return 'google-chrome';
    case 'brave':
      return 'BraveSoftware/Brave-Browser';
  }
}

function nativeHostLauncher(nodePath: string, cliPath: string): string {
  return `#!/bin/sh\nexec ${shellQuote(nodePath)} ${shellQuote(cliPath)} native-host\n`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
