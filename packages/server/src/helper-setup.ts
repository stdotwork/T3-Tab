import { chmod, copyFile, mkdir, readFile, rename, rm, rmdir, unlink, writeFile } from 'node:fs/promises';

import { PROTOCOL_VERSION } from '@t3-tab/protocol';

import { helperLayout, launcherScript, mcpCommand, pathsOf, type Host } from './helper-layout.js';
import { isRecord } from './install-config.js';
import {
  BROWSERS,
  applyRegistrations,
  findBrowsers,
  planRegistrations,
  removeRegistrations,
  runningProfiles,
  type FindBrowsersDeps,
  type HostRegistration,
  type ProcessDeps,
  type RegistryRunner,
  type SupportedBrowser,
} from './install-native-host.js';
import { agentName, findAgents, installAgent, type Agent } from './install.js';
import { stopDaemon } from './client.js';
import { readRawDaemonState } from './state.js';

/** What setup records so `uninstall` can remove exactly what setup added. */
export interface InstallMarker {
  name: 't3-tab';
  version: string;
  protocolVersion: number;
  installedAt: string;
  node: string;
  registrations: HostRegistration[];
}

export interface SetupOptions {
  host: Host;
  /** The Node that runs this command; the launchers use it. */
  node: string;
  /** The bundled program running now, or undefined when this is an unbundled build from a checkout. */
  bundle: string | undefined;
  version: string | undefined;
  /** Browsers to serve; every one found when omitted. */
  browsers?: readonly SupportedBrowser[];
  /** Extra browser profile folders to serve, besides those of browsers running now. */
  userDataDirs?: readonly string[];
  /** Also add T3-Tab to Claude Code and Codex when found. */
  agents?: boolean;
  /** Say what would be done and change nothing. */
  print?: boolean;
  stateDir: string;
  say(line: string): void;
  findDeps?: FindBrowsersDeps;
  processDeps?: ProcessDeps;
  run?: RegistryRunner;
}

export interface SetupResult {
  layout: ReturnType<typeof helperLayout>;
  registrations: HostRegistration[];
  browsers: SupportedBrowser[];
  stoppedDaemon: boolean;
}

export const NO_BROWSER = `No Chromium-family browser found. Name one with --browser <${BROWSERS.join('|')}>, or the profile folder of one that is running with --user-data-dir <folder>, and run this command again.`;

export const NOT_BUNDLED =
  'This is not the packed helper, so `setup` has nothing to install. Run `npx t3-tab@latest setup`, or use `t3-tab install` from a checkout.';

/**
 * Installs the helper in the user's own folder, from the packed program that is running: the program and its launchers,
 * and the native host registration for every browser found, which a browser that is already open picks up on its next
 * connection attempt. A running daemon of another version is stopped so the next connection starts this one.
 */
export async function setupHelper(options: SetupOptions): Promise<SetupResult> {
  const { host, say } = options;
  const layout = helperLayout(host);
  if (options.bundle === undefined || options.version === undefined) throw new Error(NOT_BUNDLED);

  const browsers = options.browsers === undefined ? await findBrowsers(host, options.findDeps) : [...options.browsers];
  const profiles = [...new Set([...(options.userDataDirs ?? []), ...(await runningProfiles(host, options.processDeps))])];
  const plan = planRegistrations(browsers, host, profiles);

  if (options.print === true) {
    say(`Would install T3-Tab ${options.version} in ${layout.root}`);
    for (const entry of plan) say(`Would register the browser link: ${entry.kind === 'registry' ? entry.key : entry.manifestPath}`);
    if (plan.length === 0) say(NO_BROWSER);
    return { layout, registrations: plan, browsers, stoppedDaemon: false };
  }

  await mkdir(layout.root, { recursive: true, mode: 0o700 });
  if (options.bundle !== layout.cli) {
    const staged = `${layout.cli}.${process.pid}.tmp`;
    try {
      await copyFile(options.bundle, staged);
      await chmod(staged, 0o755);
      await rename(staged, layout.cli);
    } finally {
      await unlink(staged).catch(() => undefined);
    }
  }
  await writeFile(layout.launcher, launcherScript(host, options.node, layout.cli, 'cli'), { mode: 0o755 });
  await writeFile(layout.hostLauncher, launcherScript(host, options.node, layout.cli, 'host'), { mode: 0o755 });
  await chmod(layout.launcher, 0o755).catch(() => undefined);
  await chmod(layout.hostLauncher, 0o755).catch(() => undefined);
  say(`Installed T3-Tab ${options.version} in ${layout.root}`);

  const registrations = await applyRegistrations(plan, layout.hostLauncher, options.run);
  for (const entry of registrations) say(`Registered the browser link: ${entry.kind === 'registry' ? entry.key : entry.manifestPath}`);
  if (registrations.length === 0) say(NO_BROWSER);

  const marker: InstallMarker = {
    name: 't3-tab',
    version: options.version,
    protocolVersion: PROTOCOL_VERSION,
    installedAt: new Date().toISOString(),
    node: options.node,
    registrations,
  };
  await writeFile(layout.marker, `${JSON.stringify(marker, null, 2)}\n`, { mode: 0o644 });

  // A daemon from an older install keeps old code running; stop it so the next connection starts this version.
  const raw = await readRawDaemonState(options.stateDir);
  let stoppedDaemon = false;
  if (raw !== null && (raw.helperVersion !== options.version || raw.protocolVersion !== PROTOCOL_VERSION)) {
    stoppedDaemon = await stopDaemon(options.stateDir);
    if (stoppedDaemon) say('Stopped the older background program. Agents that were using it need to be restarted.');
  }

  if (options.agents === true) {
    const server = mcpCommand(host, layout.cli, options.node, true);
    for (const agent of await findAgents(host.home, host.env)) {
      const result = await installAgent({ agent, home: host.home, env: host.env, server });
      say(`${agentName(agent)}: added T3-Tab in ${result.configPath}`);
    }
  }
  return { layout, registrations, browsers, stoppedDaemon };
}

export interface UninstallOptions {
  host: Host;
  stateDir: string;
  agents?: readonly Agent[] | undefined;
  say(line: string): void;
  processDeps?: ProcessDeps;
  run?: RegistryRunner;
  /** Removes the entry from one agent's config and says what happened, in one line. */
  removeAgent(agent: Agent): Promise<string>;
  /** Called after each stage of a full uninstall; tests use it to widen the gaps between stages. */
  pause?(stage: 'browser link' | 'daemon'): Promise<void>;
}

/**
 * Removes everything setup (or the developer `install`) added, in this order: the browser link (registrations and the
 * host launcher), the daemon, agent entries, the program, the daemon again, and its state. With agents named it removes only their entries: the helper, state, browser links and daemon stay, because the
 * other agent's entry, and the browser, still use them.
 */
export async function uninstallHelper(options: UninstallOptions): Promise<void> {
  const { host, say } = options;
  const layout = helperLayout(host);
  const p = pathsOf(host);

  if (options.agents !== undefined && options.agents.length > 0) {
    for (const agent of options.agents) say(await options.removeAgent(agent));
    say(`Kept the helper, the browser link and the background program; only the ${options.agents.map(agentName).join(' and ')} ${options.agents.length === 1 ? 'entry was' : 'entries were'} removed.`);
    return;
  }

  // The browser link goes first. While it stands, the browser can reconnect through the native host and start a new
  // daemon right after the old one is stopped, which would leave one running.
  // What setup wrote down, plus every usual place, so an older or hand-made install is found too.
  const recorded = (await readMarker(layout.marker))?.registrations ?? [];
  const usual = planRegistrations(BROWSERS, host, await runningProfiles(host, options.processDeps));
  const seen = new Set<string>();
  const candidates = [...recorded, ...usual].filter((entry) => {
    const id = entry.kind === 'registry' ? entry.key : entry.manifestPath;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  const removed = await removeRegistrations(candidates, options.run);
  if (removed.length === 0) say('Browser link: nothing registered.');
  for (const entry of removed) say(`Removed the browser link: ${entry.kind === 'registry' ? entry.key : entry.manifestPath}`);

  // What a browser would run to start the helper goes with the registrations.
  let removedFiles = 0;
  const removeFiles = async (files: string[]): Promise<void> => {
    for (const file of files) {
      if (await unlink(file).then(() => true, () => false)) removedFiles += 1;
    }
  };
  await removeFiles([layout.hostLauncher, layout.windowsManifest]);
  await options.pause?.('browser link');

  if (await stopDaemon(options.stateDir)) say('Stopped the background program.');
  await options.pause?.('daemon');

  for (const agent of options.agents ?? (await findAgents(host.home, host.env))) {
    say(await options.removeAgent(agent));
  }

  await removeFiles([layout.cli, layout.launcher, layout.marker, p.join(layout.root, 'cli.js.map')]);
  await rmdir(layout.root).catch(() => undefined);
  say(removedFiles === 0 ? `Helper: nothing installed in ${layout.root}.` : `Removed the helper from ${layout.root}`);

  // A native host the browser had already started can still have started a daemon between the stop and now.
  for (let attempt = 0; attempt < 5 && (await stopDaemon(options.stateDir)); attempt += 1) say('Stopped the background program.');

  if (await rm(options.stateDir, { recursive: true, force: true }).then(() => true, () => false)) say(`Removed ${options.stateDir}`);
}

async function readMarker(path: string): Promise<InstallMarker | undefined> {
  try {
    const value: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (!isRecord(value) || value.name !== 't3-tab' || !Array.isArray(value.registrations)) return undefined;
    return value as unknown as InstallMarker;
  } catch {
    return undefined;
  }
}
