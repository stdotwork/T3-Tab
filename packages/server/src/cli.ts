#!/usr/bin/env node
import { fileURLToPath } from 'node:url';

import { DEFAULT_DAEMON_PORT } from '@t3-tab/protocol';

import { startDaemon } from './daemon.js';
import { installNativeHost, type SupportedBrowser } from './install.js';
import { runMcpServer } from './mcp.js';
import { runNativeHost } from './native-host.js';
import { stateDirectory } from './state.js';

const cliPath = fileURLToPath(import.meta.url);

export async function main(args: string[] = process.argv.slice(2)): Promise<void> {
  const [command, ...rest] = args;
  switch (command) {
    case 'daemon':
      await runDaemon(rest);
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
      if (rest.length !== 0) throw new UsageError('Usage: t3-tab mcp');
      await runMcpServer();
      return;
    default:
      throw new UsageError('Usage: t3-tab <daemon|native-host|mcp>');
  }
}

async function runDaemon(args: string[]): Promise<void> {
  const port = daemonPort(args);
  const handle = await startDaemon({ port, stateDir: stateDirectory() });
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

function daemonPort(args: string[]): number {
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
  if (value === undefined || value === '') return DEFAULT_DAEMON_PORT;
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
