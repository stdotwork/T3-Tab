#!/usr/bin/env node
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { startDaemon } from './daemon.js';
import {
  agentConfigPath,
  agentInstallMethod,
  agentName,
  findAgents,
  findBrowsers,
  installAgent,
  uninstallAgent,
  type Agent,
} from './install.js';
import type { McpCommand } from './install-config.js';
import {
  installNativeHost,
  nativeHostPaths,
  uninstallNativeHosts,
  type SupportedBrowser,
} from './install-native-host.js';
import { runMcpServer } from './mcp.js';
import { runNativeHost } from './native-host.js';
import { readDaemonState, stateDirectory } from './state.js';
import { daemonIsHealthy } from './client.js';

const cliPath = fileURLToPath(import.meta.url);

export async function main(args: string[] = process.argv.slice(2)): Promise<void> {
  const [command, ...rest] = args;
  switch (command) {
    case 'daemon':
      await runDaemon(rest);
      return;
    case 'install':
      await runAgentInstall(rest, cliPath);
      return;
    case 'uninstall':
      await runAgentUninstall(rest);
      return;
    case 'native-host':
      if (rest[0] === 'install') {
        await runInstall(rest.slice(1));
      } else if (rest.length === 0) {
        await runNativeHost();
      } else {
        throw new UsageError('Usage: t3-tab native-host [install [--browser chromium|chrome|brave]]');
      }
      return;
    case 'mcp':
      await runMcpServer(mcpOptions(rest));
      return;
    default:
      throw new UsageError('Usage: t3-tab <install|uninstall|daemon|native-host|mcp>');
  }
}

function mcpOptions(args: string[]): { claimFile?: string } {
  if (args.length === 0) return {};
  const [flag, path] = args;
  if (args.length !== 2 || flag !== '--claim-file' || path === undefined || path === '') {
    throw new UsageError('Usage: t3-tab mcp [--claim-file <path>]');
  }
  return { claimFile: path };
}

async function runDaemon(args: string[]): Promise<void> {
  const port = daemonPort(args);
  const stateDir = stateDirectory();
  const running = await readDaemonState(stateDir);
  if (running !== null && (await daemonIsHealthy(running))) {
    throw new UsageError(`A T3-Tab daemon is already running on 127.0.0.1:${running.port} for ${stateDir}.`);
  }
  const handle = await startDaemon({ port, stateDir });
  process.stderr.write(`T3-Tab daemon listening on 127.0.0.1:${handle.port}\n`);

  let stopping = false;
  const stop = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    await handle.close();
    process.exit(0);
  };
  process.once('SIGINT', () => void stop());
  process.once('SIGTERM', () => void stop());
}

interface AgentInstallArguments {
  agents: Agent[] | undefined;
  browser: SupportedBrowser | undefined;
  print: boolean;
}

async function runAgentInstall(args: string[], cliPath: string): Promise<void> {
  const parsed = parseAgentInstallArguments(args);
  const home = homeDirectory();
  const server: McpCommand = { command: process.execPath, args: [resolve(cliPath), 'mcp'] };
  const agents = parsed.agents ?? (await findAgents(home, process.env));
  const browsers = parsed.browser === undefined ? await findBrowsers(home, process.env) : [parsed.browser];

  if (parsed.print) {
    if (agents.length === 0) process.stdout.write('No Claude Code or Codex installation found.\n');
    for (const agent of agents) {
      const method = await agentInstallMethod(agent, process.env);
      const configPath = agentConfigPath(agent, home);
      const action = method === 'cli' ? `${agent} mcp add` : 'file edit';
      process.stdout.write(
        `${agentName(agent)}: would register t3-tab in ${configPath} with ${action} (${server.command} ${server.args.join(' ')})\n`,
      );
    }
    if (browsers.length === 0) process.stdout.write('No Chromium, Chrome or Brave installation found.\n');
    for (const browser of browsers) {
      process.stdout.write(
        `Native host (${browser}): would install ${nativeHostPaths(browser, home).manifestPath}\n`,
      );
    }
    return;
  }

  for (const agent of agents) {
    const result = await installAgent({ agent, home, env: process.env, server });
    const action = result.method === 'cli' ? `${agent} mcp add` : 'file edit';
    process.stdout.write(`${agentName(agent)}: registered t3-tab in ${result.configPath} with ${action}\n`);
  }
  for (const browser of browsers) {
    const manifestPath = await installNativeHost({ browser, home, cliPath });
    process.stdout.write(`Native host (${browser}): installed ${manifestPath}\n`);
  }
  if (agents.length === 0 && browsers.length === 0) {
    process.stdout.write('No Claude Code, Codex or supported browser installation found.\n');
  }
}

async function runAgentUninstall(args: string[]): Promise<void> {
  const selectedAgents = parseAgentUninstallArguments(args);
  const home = homeDirectory();
  const agents = selectedAgents ?? (await findAgents(home, process.env));

  for (const agent of agents) {
    const result = await uninstallAgent({ agent, home, env: process.env });
    const detail = result.removed ? 'removed t3-tab from' : 'no t3-tab entry in';
    const action = result.method === 'cli' ? `${agent} mcp remove` : 'file edit';
    process.stdout.write(`${agentName(agent)}: ${detail} ${result.configPath} with ${action}\n`);
  }
  const removedHosts = await uninstallNativeHosts(home);
  if (removedHosts.length === 0) process.stdout.write('Native host: no installed manifests found.\n');
  else process.stdout.write(`Native host: removed ${removedHosts.join(', ')}\n`);
}

function parseAgentInstallArguments(args: string[]): AgentInstallArguments {
  const agents = new Set<Agent>();
  let browser: SupportedBrowser | undefined;
  let print = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--claude') agents.add('claude');
    else if (argument === '--codex') agents.add('codex');
    else if (argument === '--print') print = true;
    else if (argument === '--browser') {
      const value = args[index + 1];
      if (!isSupportedBrowser(value)) throw new UsageError('--browser must be chromium, chrome or brave');
      browser = value;
      index += 1;
    } else if (argument?.startsWith('--browser=')) {
      const value = argument.slice('--browser='.length);
      if (!isSupportedBrowser(value)) throw new UsageError('--browser must be chromium, chrome or brave');
      browser = value;
    } else {
      throw new UsageError(
        'Usage: t3-tab install [--claude] [--codex] [--browser chromium|chrome|brave] [--print]',
      );
    }
  }
  return { agents: agents.size === 0 ? undefined : [...agents], browser, print };
}

function parseAgentUninstallArguments(args: string[]): Agent[] | undefined {
  const agents = new Set<Agent>();
  for (const argument of args) {
    if (argument === '--claude') agents.add('claude');
    else if (argument === '--codex') agents.add('codex');
    else throw new UsageError('Usage: t3-tab uninstall [--claude] [--codex]');
  }
  return agents.size === 0 ? undefined : [...agents];
}

function homeDirectory(): string {
  const home = process.env.HOME?.trim();
  if (home === undefined || home === '') throw new Error('HOME is not set');
  return home;
}

async function runInstall(args: string[]): Promise<void> {
  let browser: SupportedBrowser = 'chromium';
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--browser') {
      const value = args[index + 1];
      if (!isSupportedBrowser(value)) throw new UsageError('--browser must be chromium, chrome or brave');
      browser = value;
      index += 1;
    } else if (argument?.startsWith('--browser=')) {
      const value = argument.slice('--browser='.length);
      if (!isSupportedBrowser(value)) throw new UsageError('--browser must be chromium, chrome or brave');
      browser = value;
    } else {
      throw new UsageError('Usage: t3-tab native-host install [--browser chromium|chrome|brave]');
    }
  }

  const home = process.env.HOME?.trim();
  if (home === undefined || home === '') throw new Error('HOME is not set');
  const manifestPath = await installNativeHost({ browser, home, cliPath });
  process.stdout.write(`${manifestPath}\n`);
}

/** The port the user asked for with --port or T3_TAB_PORT, or undefined when neither was given. */
function daemonPort(args: string[]): number | undefined {
  let value = process.env.T3_TAB_PORT?.trim();
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--port') {
      const next = args[index + 1];
      if (next === undefined || next.startsWith('--')) throw new UsageError('--port requires a number');
      value = next;
      index += 1;
    } else if (argument?.startsWith('--port=')) {
      value = argument.slice('--port='.length);
    } else {
      throw new UsageError('Usage: t3-tab daemon [--port 1-65535]');
    }
  }
  if (value === undefined || value === '') return undefined;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new UsageError('Port must be 1-65535');
  return port;
}

function isSupportedBrowser(value: string | undefined): value is SupportedBrowser {
  return value === 'chromium' || value === 'chrome' || value === 'brave';
}

class UsageError extends Error {}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
