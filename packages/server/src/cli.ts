#!/usr/bin/env node
import { startDaemon } from './daemon.js';
import { currentHost } from './helper-layout.js';
import { helpFor } from './help.js';
import { setupHelper, uninstallHelper } from './helper-setup.js';
import {
  agentConfigPath,
  agentInstallMethod,
  agentName,
  findAgents,
  installAgent,
  uninstallAgent,
  type Agent,
} from './install.js';
import {
  BROWSERS,
  findBrowsers,
  installNativeHost,
  isSupportedBrowser,
  nativeHostBrowsers,
  installProfiles,
  planRegistrations,
  runningProfiles,
  type SupportedBrowser,
} from './install-native-host.js';
import { runMcpServer } from './mcp.js';
import { runNativeHost } from './native-host.js';
import { readDaemonState, stateDirectory } from './state.js';
import { daemonIsHealthy } from './client.js';
import { HELPER_VERSION, runningCliPath, runningMcpCommand } from './version.js';

const cliPath = runningCliPath();

export async function main(args: string[] = process.argv.slice(2)): Promise<void> {
  const [command, ...rest] = args;
  const help = helpFor(args);
  if (help !== undefined) {
    process.stdout.write(help);
    return;
  }
  switch (command) {
    case 'daemon':
      await runDaemon(rest);
      return;
    case 'setup':
      await runSetup(rest);
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
        throw new UsageError('Usage: t3-tab native-host [install [--browser chromium|chrome|brave|edge|vivaldi]]');
      }
      return;
    case 'mcp':
      await runMcpServer(mcpOptions(rest));
      return;
    case '--version':
    case 'version':
      process.stdout.write(`${HELPER_VERSION ?? 'development build'}\n`);
      return;
    default:
      throw new UsageError('Usage: t3-tab <setup|uninstall|daemon|native-host|mcp|version>   (developers also: install)\nRun `t3-tab --help` for what each does.');
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
  const host = currentHost();
  const server = runningMcpCommand(host, cliPath);
  const agents = parsed.agents ?? (await findAgents(home, process.env));
  const browsers = parsed.browser === undefined ? await findBrowsers(host) : [parsed.browser];

  if (parsed.print) {
    if (agents.length === 0) process.stdout.write('No Claude Code or Codex installation found.\n');
    for (const agent of agents) {
      const method = await agentInstallMethod(agent, process.env);
      const configPath = agentConfigPath(agent, home, process.env);
      const action = method === 'cli' ? `${agent} mcp add` : 'file edit';
      process.stdout.write(
        `${agentName(agent)}: would register t3-tab in ${configPath} with ${action} (${server.command} ${server.args.join(' ')})\n`,
      );
    }
    if (browsers.length === 0) process.stdout.write('No supported browser installation found.\n');
    for (const entry of planRegistrations(browsers, host, await installProfiles(browsers, host))) {
      process.stdout.write(`Native host (${entry.browser ?? 'profile'}): would install ${entry.manifestPath}\n`);
    }
    return;
  }

  for (const agent of agents) {
    const result = await installAgent({ agent, home, env: process.env, server });
    const action = result.method === 'cli' ? `${agent} mcp add` : 'file edit';
    process.stdout.write(`${agentName(agent)}: registered t3-tab in ${result.configPath} with ${action}\n`);
  }
  if (browsers.length > 0) {
    const manifests = await installNativeHost({ browsers, host, cliPath, profiles: await installProfiles(browsers, host) });
    for (const manifest of manifests) process.stdout.write(`Native host: installed ${manifest}\n`);
  }
  if (agents.length === 0 && browsers.length === 0) {
    process.stdout.write('No Claude Code, Codex or supported browser installation found.\n');
  }
}

async function runAgentUninstall(args: string[]): Promise<void> {
  const selectedAgents = parseAgentUninstallArguments(args);
  await uninstallHelper({
    host: currentHost(),
    stateDir: stateDirectory(),
    agents: selectedAgents,
    say: (line) => process.stdout.write(`${line}\n`),
    removeAgent: async (agent) => {
      const result = await uninstallAgent({ agent, home: homeDirectory(), env: process.env });
      const detail = result.removed ? 'removed t3-tab from' : 'no t3-tab entry in';
      const action = result.method === 'cli' ? `${agent} mcp remove` : 'file edit';
      return `${agentName(agent)}: ${detail} ${result.configPath} with ${action}`;
    },
  });
}

interface SetupArguments {
  browsers: SupportedBrowser[];
  userDataDirs: string[];
  agents: boolean;
  print: boolean;
}

const SETUP_USAGE = 'Usage: t3-tab setup [--print] [--agents] [--browser chromium|chrome|brave|edge|vivaldi]... [--user-data-dir <folder>]...';

function parseSetupArguments(args: string[]): SetupArguments {
  const parsed: SetupArguments = { browsers: [], userDataDirs: [], agents: false, print: false };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] ?? '';
    const value = (): string => {
      const inline = argument.indexOf('=');
      if (inline >= 0) return argument.slice(inline + 1);
      index += 1;
      return args[index] ?? '';
    };
    if (argument === '--print') parsed.print = true;
    else if (argument === '--agents') parsed.agents = true;
    else if (argument === '--browser' || argument.startsWith('--browser=')) {
      const browser = value();
      if (!isSupportedBrowser(browser)) throw new UsageError(`--browser must be ${BROWSERS.join(', ')}`);
      parsed.browsers.push(browser);
    } else if (argument === '--user-data-dir' || argument.startsWith('--user-data-dir=')) {
      const folder = value();
      if (folder === '') throw new UsageError('--user-data-dir needs a folder');
      parsed.userDataDirs.push(folder);
    } else throw new UsageError(SETUP_USAGE);
  }
  return parsed;
}

/** `t3-tab setup`: installs the packed helper for this user and registers it with every browser found. */
async function runSetup(args: string[]): Promise<void> {
  const parsed = parseSetupArguments(args);
  const say = (line: string): void => void process.stdout.write(`${line}\n`);
  const host = currentHost();
  const result = await setupHelper({
    host,
    node: process.execPath,
    bundle: HELPER_VERSION === undefined ? undefined : cliPath,
    version: HELPER_VERSION,
    ...(parsed.browsers.length > 0 ? { browsers: parsed.browsers } : {}),
    userDataDirs: parsed.userDataDirs,
    agents: parsed.agents,
    print: parsed.print,
    stateDir: stateDirectory(),
    say,
  });
  // The helper is installed either way, but with no browser link written the browser cannot find it: that is a failure.
  if (!parsed.print && result.registrations.length === 0) process.exitCode = 1;
  if (!parsed.print && result.registrations.length > 0) {
    say('Done. Open the T3-Tab side panel in your browser: it finds the helper by itself, with no reload.');
    if (!parsed.agents) say('Add Claude Code or Codex from the panel, or run this again with --agents.');
  }
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
      if (!isSupportedBrowser(value)) throw new UsageError(`--browser must be ${BROWSERS.join(', ')}`);
      browser = value;
      index += 1;
    } else if (argument?.startsWith('--browser=')) {
      const value = argument.slice('--browser='.length);
      if (!isSupportedBrowser(value)) throw new UsageError(`--browser must be ${BROWSERS.join(', ')}`);
      browser = value;
    } else {
      throw new UsageError(
        'Usage: t3-tab install [--claude] [--codex] [--browser chromium|chrome|brave|edge|vivaldi] [--print]   (developer path: use `t3-tab setup`)',
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
  let browser: SupportedBrowser | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--browser') {
      const value = args[index + 1];
      if (!isSupportedBrowser(value)) throw new UsageError(`--browser must be ${BROWSERS.join(', ')}`);
      browser = value;
      index += 1;
    } else if (argument?.startsWith('--browser=')) {
      const value = argument.slice('--browser='.length);
      if (!isSupportedBrowser(value)) throw new UsageError(`--browser must be ${BROWSERS.join(', ')}`);
      browser = value;
    } else {
      throw new UsageError('Usage: t3-tab native-host install [--browser chromium|chrome|brave|edge|vivaldi]');
    }
  }

  const host = currentHost();
  // Without --browser, every browser found gets the native host, and so does the profile folder of any browser running with its own.
  const { browsers, found } = await nativeHostBrowsers(browser, host);
  if (!found) process.stderr.write('No supported browser installation found; installing for Chromium. Use --browser to choose another.\n');
  const profiles = await runningProfiles(host);
  for (const manifest of await installNativeHost({ browsers, host, cliPath, profiles })) process.stdout.write(`${manifest}\n`);
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

class UsageError extends Error {}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
