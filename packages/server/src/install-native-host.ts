import { execFile } from 'node:child_process';
import { access, chmod, mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { delimiter } from 'node:path';
import { promisify } from 'node:util';

import { EXTENSION_IDS, NATIVE_HOST_NAME } from '@t3-tab/protocol';

import { helperLayout, launcherScript, pathsOf, type Host } from './helper-layout.js';
import { isRecord } from './install-config.js';

export type SupportedBrowser = 'chromium' | 'chrome' | 'brave' | 'edge' | 'vivaldi';

export const BROWSERS: readonly SupportedBrowser[] = ['chromium', 'chrome', 'brave', 'edge', 'vivaldi'];

export function isSupportedBrowser(value: string | undefined): value is SupportedBrowser {
  return BROWSERS.includes(value as SupportedBrowser);
}

/** Where a browser keeps its profile on Linux (under the config folder) and macOS (under Application Support). */
const PROFILE_FOLDERS: Record<'linux' | 'darwin', Record<SupportedBrowser, string>> = {
  linux: { chromium: 'chromium', chrome: 'google-chrome', brave: 'BraveSoftware/Brave-Browser', edge: 'microsoft-edge', vivaldi: 'vivaldi' },
  darwin: { chromium: 'Chromium', chrome: 'Google/Chrome', brave: 'BraveSoftware/Brave-Browser', edge: 'Microsoft Edge', vivaldi: 'Vivaldi' },
};
/** Windows: the vendor folder under %LOCALAPPDATA% (profile) and the HKCU key (native hosts). */
const WINDOWS: Record<SupportedBrowser, { profile: string; registry: string }> = {
  chromium: { profile: 'Chromium\\User Data', registry: 'Software\\Chromium' },
  chrome: { profile: 'Google\\Chrome\\User Data', registry: 'Software\\Google\\Chrome' },
  brave: { profile: 'BraveSoftware\\Brave-Browser\\User Data', registry: 'Software\\BraveSoftware\\Brave-Browser' },
  edge: { profile: 'Microsoft\\Edge\\User Data', registry: 'Software\\Microsoft\\Edge' },
  vivaldi: { profile: 'Vivaldi\\User Data', registry: 'Software\\Vivaldi' },
};
const LINUX_EXECUTABLES: Record<SupportedBrowser, readonly string[]> = {
  chromium: ['chromium', 'chromium-browser'],
  chrome: ['google-chrome', 'google-chrome-stable'],
  brave: ['brave', 'brave-browser', 'brave-browser-stable'],
  edge: ['microsoft-edge', 'microsoft-edge-stable'],
  vivaldi: ['vivaldi', 'vivaldi-stable'],
};
const MAC_APPS: Record<SupportedBrowser, string> = {
  chromium: 'Chromium.app',
  chrome: 'Google Chrome.app',
  brave: 'Brave Browser.app',
  edge: 'Microsoft Edge.app',
  vivaldi: 'Vivaldi.app',
};

/** The browser's own profile folder (its "user data dir"). A browser reads native host manifests from `NativeMessagingHosts` in it. */
export function userDataDirectory(browser: SupportedBrowser, host: Host): string {
  const p = pathsOf(host);
  if (host.platform === 'win32') {
    const local = host.env.LOCALAPPDATA?.trim();
    return p.join(local === undefined || local === '' ? p.join(host.home, 'AppData', 'Local') : local, WINDOWS[browser].profile);
  }
  if (host.platform === 'darwin') return p.join(host.home, 'Library', 'Application Support', PROFILE_FOLDERS.darwin[browser]);
  // Chromium reads XDG_CONFIG_HOME, not HOME, for its profile folder.
  const config = host.env.XDG_CONFIG_HOME?.trim();
  return p.join(config === undefined || config === '' ? p.join(host.home, '.config') : config, PROFILE_FOLDERS.linux[browser]);
}

/** One place the helper is registered so a browser can start it. */
export type HostRegistration =
  | { kind: 'file'; browser: SupportedBrowser | undefined; manifestPath: string }
  | { kind: 'registry'; browser: SupportedBrowser; key: string; manifestPath: string };

/**
 * Where to register for these browsers. Linux and macOS: a manifest in the browser's profile folder, plus one in the
 * profile folder of every browser process running with its own `--user-data-dir` (`extraProfiles`), which a browser reads
 * instead of its usual one. Windows: an HKCU registry key per browser that points at one manifest file.
 */
export function planRegistrations(browsers: readonly SupportedBrowser[], host: Host, extraProfiles: readonly string[] = []): HostRegistration[] {
  const p = pathsOf(host);
  if (host.platform === 'win32') {
    const manifestPath = helperLayout(host).windowsManifest;
    return browsers.map((browser) => ({ kind: 'registry', browser, key: `HKCU\\${WINDOWS[browser].registry}\\NativeMessagingHosts\\${NATIVE_HOST_NAME}`, manifestPath }));
  }
  const plan: HostRegistration[] = browsers.map((browser) => ({ kind: 'file', browser, manifestPath: manifestIn(userDataDirectory(browser, host), p.join) }));
  for (const profile of extraProfiles) {
    const manifestPath = manifestIn(profile, p.join);
    if (!plan.some((entry) => entry.manifestPath === manifestPath)) plan.push({ kind: 'file', browser: undefined, manifestPath });
  }
  return plan;
}

function manifestIn(profile: string, join: (...parts: string[]) => string): string {
  return join(profile, 'NativeMessagingHosts', `${NATIVE_HOST_NAME}.json`);
}

export function hostManifest(launcherPath: string): Record<string, unknown> {
  return {
    name: NATIVE_HOST_NAME,
    description: 'T3-Tab browser link',
    path: launcherPath,
    type: 'stdio',
    allowed_origins: EXTENSION_IDS.map((id) => `chrome-extension://${id}/`),
  };
}

const execFileAsync = promisify(execFile);
/** Runs `reg.exe` (Windows only); tests pass their own. */
export type RegistryRunner = (args: string[]) => Promise<void>;
const runReg: RegistryRunner = async (args) => {
  await execFileAsync('reg', args, { windowsHide: true });
};

/** Writes the manifests (and registry keys) in `plan`, pointing at `launcherPath`. Returns what it wrote. */
export async function applyRegistrations(plan: readonly HostRegistration[], launcherPath: string, run: RegistryRunner = runReg): Promise<HostRegistration[]> {
  const manifest = `${JSON.stringify(hostManifest(launcherPath), null, 2)}\n`;
  const written: HostRegistration[] = [];
  for (const entry of plan) {
    await mkdir(directoryOf(entry.manifestPath), { recursive: true, mode: 0o700 });
    await writeFile(entry.manifestPath, manifest, { mode: 0o644 });
    await chmod(entry.manifestPath, 0o644).catch(() => undefined);
    if (entry.kind === 'registry') await run(['add', entry.key, '/ve', '/t', 'REG_SZ', '/d', entry.manifestPath, '/f']);
    written.push(entry);
  }
  return written;
}

/** Removes what `applyRegistrations` wrote. A manifest that is not T3-Tab's is left alone. */
export async function removeRegistrations(entries: readonly HostRegistration[], run: RegistryRunner = runReg): Promise<HostRegistration[]> {
  const removed: HostRegistration[] = [];
  for (const entry of entries) {
    let gone = false;
    if (entry.kind === 'registry') {
      await run(['delete', entry.key, '/f']).then(() => (gone = true), () => undefined);
    }
    if (await isOurManifest(entry.manifestPath)) {
      await unlink(entry.manifestPath).then(() => (gone = true), () => undefined);
    }
    if (gone) removed.push(entry);
  }
  return removed;
}

async function isOurManifest(manifestPath: string): Promise<boolean> {
  try {
    const value: unknown = JSON.parse(await readFile(manifestPath, 'utf8'));
    return isRecord(value) && value.name === NATIVE_HOST_NAME && value.type === 'stdio';
  } catch {
    return false;
  }
}

function directoryOf(file: string): string {
  const cut = Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\'));
  return file.slice(0, cut);
}

export interface FindBrowsersDeps {
  /** True when the path exists. */
  exists(path: string): Promise<boolean>;
  /** The first folder on PATH that holds one of these programs, or undefined. */
  onPath(names: readonly string[]): Promise<boolean>;
}

export function realFindDeps(env: NodeJS.ProcessEnv): FindBrowsersDeps {
  const exists = async (target: string): Promise<boolean> => access(target).then(() => true, () => false);
  return {
    exists,
    onPath: async (names) => {
      for (const directory of (env.PATH ?? '').split(delimiter).filter(Boolean)) {
        for (const name of names) if (await exists(`${directory}/${name}`)) return true;
      }
      return false;
    },
  };
}

/** Every browser whose program or profile folder is on this machine. */
export async function findBrowsers(host: Host, deps: FindBrowsersDeps = realFindDeps(host.env)): Promise<SupportedBrowser[]> {
  const found: SupportedBrowser[] = [];
  const p = pathsOf(host);
  for (const browser of BROWSERS) {
    let present = await deps.exists(userDataDirectory(browser, host));
    if (!present && host.platform === 'linux') present = await deps.onPath(LINUX_EXECUTABLES[browser]);
    if (!present && host.platform === 'darwin') {
      present = (await deps.exists(p.join('/Applications', MAC_APPS[browser]))) || (await deps.exists(p.join(host.home, 'Applications', MAC_APPS[browser])));
    }
    if (present) found.push(browser);
  }
  return found;
}

const BROWSER_PROGRAM = /(chrom|brave|vivaldi|msedge|microsoft-edge)/i;

/** The `--user-data-dir` of a browser's main process, from its command line; undefined for helpers and other programs. */
export function userDataDirFromArguments(argv: readonly string[]): string | undefined {
  const [program, ...rest] = argv;
  if (program === undefined || !BROWSER_PROGRAM.test(program.slice(program.lastIndexOf('/') + 1))) return undefined;
  if (rest.some((argument) => argument.startsWith('--type='))) return undefined;
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index] ?? '';
    if (argument.startsWith('--user-data-dir=')) return argument.slice('--user-data-dir='.length) || undefined;
    if (argument === '--user-data-dir') return rest[index + 1] || undefined;
  }
  return undefined;
}

export interface ProcessDeps {
  /** Linux: the command lines in /proc. */
  readCommandLines(): Promise<string[][]>;
  /** macOS: the output of `ps -axo args=`. */
  psOutput(): Promise<string>;
}

export function realProcessDeps(): ProcessDeps {
  return {
    readCommandLines: async () => {
      const lines: string[][] = [];
      for (const entry of await readdir('/proc').catch(() => [] as string[])) {
        if (!/^\d+$/.test(entry)) continue;
        const raw = await readFile(`/proc/${entry}/cmdline`, 'utf8').catch(() => '');
        if (raw !== '') lines.push(raw.split('\0').filter((part, index, all) => part !== '' || index < all.length - 1));
      }
      return lines;
    },
    psOutput: async () => (await execFileAsync('ps', ['-axo', 'args='], { maxBuffer: 16 * 1024 * 1024 })).stdout,
  };
}

/**
 * Profile folders of browsers running now with their own `--user-data-dir`. Such a browser reads native host manifests
 * from that folder only, so the usual one would leave the helper "not found" there. Windows reads its registry
 * instead, so nothing is looked for there.
 */
export async function runningProfiles(host: Host, deps: ProcessDeps = realProcessDeps()): Promise<string[]> {
  const found = new Set<string>();
  try {
    if (host.platform === 'linux') {
      for (const argv of await deps.readCommandLines()) {
        const profile = userDataDirFromArguments(argv);
        if (profile !== undefined) found.add(profile);
      }
    } else if (host.platform === 'darwin') {
      for (const line of (await deps.psOutput()).split('\n')) {
        const profile = userDataDirFromArguments(splitMacCommand(line));
        if (profile !== undefined) found.add(profile);
      }
    }
  } catch {
    // No process list: the usual profile folders still get the helper.
  }
  return [...found];
}

/** `ps` joins the arguments with spaces, so a path with spaces is cut at the next ` --` flag. Best effort. */
function splitMacCommand(line: string): string[] {
  const program = /^(.*?\.app\/Contents\/MacOS\/[^ ]+|\S+)/.exec(line.trim())?.[1];
  if (program === undefined) return [];
  const flags = line.trim().slice(program.length).split(/ (?=--)/).map((part) => part.trim()).filter(Boolean);
  return [program, ...flags];
}

// -- Developer path: a launcher that runs a checkout's built `dist/cli.js`. --

/**
 * The browsers `native-host install` serves: the one asked for, else every browser found. When none is found it keeps
 * the old default, Chromium, so the command still installs something.
 */
export async function nativeHostBrowsers(
  requested: SupportedBrowser | undefined,
  host: Host,
  deps?: FindBrowsersDeps,
): Promise<{ browsers: SupportedBrowser[]; found: boolean }> {
  if (requested !== undefined) return { browsers: [requested], found: true };
  const found = await findBrowsers(host, deps);
  return found.length === 0 ? { browsers: ['chromium'], found: false } : { browsers: found, found: true };
}

// -- Developer path: a launcher that runs a checkout's built `dist/cli.js`. --

export interface InstallNativeHostOptions {
  browsers: readonly SupportedBrowser[];
  host: Host;
  cliPath: string;
  /** Profile folders of browsers running with their own `--user-data-dir`. */
  profiles?: readonly string[];
}

/** Installs the native host for these browsers, running `cliPath` with the running Node. For development from a checkout. Returns the manifests written. */
export async function installNativeHost(options: InstallNativeHostOptions): Promise<string[]> {
  const layout = helperLayout(options.host);
  await mkdir(layout.root, { recursive: true, mode: 0o700 });
  await writeFile(layout.hostLauncher, launcherScript(options.host, process.execPath, options.cliPath, 'host'), { mode: 0o755 });
  await chmod(layout.hostLauncher, 0o755).catch(() => undefined);
  const written = await applyRegistrations(planRegistrations(options.browsers, options.host, options.profiles), layout.hostLauncher);
  return written.map((entry) => entry.manifestPath);
}
