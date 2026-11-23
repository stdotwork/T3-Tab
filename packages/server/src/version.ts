import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { currentHost, helperLayout, mcpCommand, type Host } from './helper-layout.js';
import type { McpCommand } from './install-config.js';

/** Replaced by the bundler with the packed helper's version; undefined in an unbundled build from a checkout. */
declare const __T3_TAB_VERSION__: string | undefined;

export const HELPER_VERSION: string | undefined = typeof __T3_TAB_VERSION__ === 'undefined' ? undefined : __T3_TAB_VERSION__;

/** The file running now: the bundle in a packed helper, `dist/cli.js` in a checkout. */
export function runningCliPath(): string {
  const bundled = process.argv[1];
  return HELPER_VERSION !== undefined && bundled !== undefined ? realOrSame(bundled) : fileURLToPath(new URL('./cli.js', import.meta.url));
}

/** True when `cli` is the program setup installed in the user's helper folder. */
export function isInstalledCli(host: Host, cli: string): boolean {
  return realOrSame(cli) === realOrSame(helperLayout(host).cli);
}

/** The command an agent's MCP entry runs for this program. */
export function runningMcpCommand(host: Host = currentHost(), cli: string = runningCliPath()): McpCommand {
  return mcpCommand(host, cli, process.execPath, HELPER_VERSION !== undefined && isInstalledCli(host, cli));
}

function realOrSame(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}
