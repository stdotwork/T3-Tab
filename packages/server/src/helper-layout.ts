import { homedir } from 'node:os';
import path from 'node:path';

import type { McpCommand } from './install-config.js';

export type Platform = 'linux' | 'darwin' | 'win32';

/** The machine a command runs on. Tests pass their own; the commands pass the real one. */
export interface Host {
  platform: Platform;
  home: string;
  env: NodeJS.ProcessEnv;
}

export function currentHost(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): Host {
  const isWindows = platform === 'win32';
  const named = (isWindows ? (env.USERPROFILE ?? env.HOME) : env.HOME)?.trim();
  const home = named === undefined || named === '' ? homedir() : named;
  return { platform: platform === 'win32' || platform === 'darwin' ? platform : 'linux', home, env };
}

/** The path functions of the host's own platform, so Windows paths can be built and checked on any machine. */
export function pathsOf(host: Pick<Host, 'platform'>): typeof path.posix {
  return host.platform === 'win32' ? path.win32 : path.posix;
}

/** Where the installed helper lives: one stable folder per user, outside any checkout or package cache. */
export interface HelperLayout {
  root: string;
  /** The bundled program, `t3-tab` itself. */
  cli: string;
  /** Starts `cli` with the Node that installed it. Agents' MCP entries point here (on Windows they use Node and `cli`). */
  launcher: string;
  /** The program the browser starts for native messaging. */
  hostLauncher: string;
  /** What setup installed, and every file and registry key it added, so uninstall can remove exactly that. */
  marker: string;
  /** Windows keeps the native host manifest here; the registry points at it. */
  windowsManifest: string;
}

export function helperLayout(host: Host): HelperLayout {
  const p = pathsOf(host);
  let root: string;
  if (host.platform === 'darwin') root = p.join(host.home, 'Library', 'Application Support', 'T3-Tab');
  else if (host.platform === 'win32') root = p.join(nonEmpty(host.env.LOCALAPPDATA) ?? p.join(host.home, 'AppData', 'Local'), 'T3-Tab');
  else root = p.join(nonEmpty(host.env.XDG_DATA_HOME) ?? p.join(host.home, '.local', 'share'), 't3-tab');
  const script = host.platform === 'win32' ? '.cmd' : '';
  return {
    root,
    cli: p.join(root, 'cli.js'),
    launcher: p.join(root, `t3-tab${script}`),
    hostLauncher: p.join(root, `native-host${script}`),
    marker: p.join(root, 'install.json'),
    windowsManifest: p.join(root, 'com.t3tab.native.json'),
  };
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === '' ? undefined : trimmed;
}

/**
 * A launcher script. It runs `cli` with the Node that wrote it and, when that Node is gone (an upgrade moved it), with
 * the first `node` on PATH. The native host launcher passes no arguments on: the browser adds its own.
 */
export function launcherScript(host: Pick<Host, 'platform'>, node: string, cli: string, kind: 'cli' | 'host'): string {
  if (host.platform === 'win32') {
    const rest = kind === 'host' ? 'native-host' : '%*';
    return `@echo off\r\nsetlocal\r\nset "NODE=${node}"\r\nif not exist "%NODE%" set "NODE=node"\r\n"%NODE%" "${cli}" ${rest}\r\n`;
  }
  const rest = kind === 'host' ? 'native-host' : '"$@"';
  return `#!/bin/sh\nNODE=${shellQuote(node)}\n[ -x "$NODE" ] || NODE=node\nexec "$NODE" ${shellQuote(cli)} ${rest}\n`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * The command an agent's MCP entry runs. When `cli` is the installed helper it is the launcher, so the entry names no
 * Node and no package folder; from a checkout it is the running Node and that checkout's built file.
 */
export function mcpCommand(host: Host, cli: string, node: string, installed: boolean): McpCommand {
  if (!installed) return { command: node, args: [cli, 'mcp'] };
  const layout = helperLayout(host);
  return host.platform === 'win32' ? { command: node, args: [layout.cli, 'mcp'] } : { command: layout.launcher, args: ['mcp'] };
}
