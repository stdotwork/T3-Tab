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

import {
  CLAUDE_SERVER_NAME,
  CODEX_SERVER_NAME,
  addClaudeServer,
  addCodexServer,
  findCodexServerRange,
  isRecord,
  parseClaudeConfig,
  removeClaudeServer,
  removeCodexServer,
  type McpCommand,
} from './install-config.js';

export type Agent = 'claude' | 'codex';
export type InstallMethod = 'cli' | 'file';

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

const AGENTS: readonly Agent[] = ['claude', 'codex'];
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

/** True when the agent's user config already holds the `t3-tab` MCP entry. It reads the file; it starts no agent command. */
export async function hasAgentServer(agent: Agent, configPath: string): Promise<boolean> {
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

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code;
}

function requireServer(server: McpCommand | undefined): McpCommand {
  if (server === undefined) throw new Error('An MCP server command is required');
  return server;
}
