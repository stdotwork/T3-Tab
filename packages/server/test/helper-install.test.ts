import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { EXTENSION_ID, NATIVE_HOST_NAME, PROTOCOL_VERSION } from '@t3-tab/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { currentHost, helperLayout, launcherScript, mcpCommand } from '../src/helper-layout.js';
import { NOT_BUNDLED, setupHelper, uninstallHelper } from '../src/helper-setup.js';
import {
  applyRegistrations,
  findBrowsers,
  hostManifest,
  planRegistrations,
  removeRegistrations,
  runningProfiles,
  userDataDirFromArguments,
  userDataDirectory,
  type FindBrowsersDeps,
  type ProcessDeps,
} from '../src/install-native-host.js';

const none: FindBrowsersDeps = { exists: async () => false, onPath: async () => false };
const noProcesses: ProcessDeps = { readCommandLines: async () => [], psOutput: async () => '' };

describe('where the helper lives', () => {
  it('is one folder per user on each system, outside any checkout', () => {
    expect(helperLayout(currentHost({ HOME: '/home/ada' }, 'linux')).root).toBe('/home/ada/.local/share/t3-tab');
    expect(helperLayout(currentHost({ HOME: '/home/ada', XDG_DATA_HOME: '/data' }, 'linux')).root).toBe('/data/t3-tab');
    expect(helperLayout(currentHost({ HOME: '/Users/ada' }, 'darwin')).root).toBe('/Users/ada/Library/Application Support/T3-Tab');
    const windows = helperLayout(currentHost({ USERPROFILE: 'C:\\Users\\ada', LOCALAPPDATA: 'C:\\Users\\ada\\AppData\\Local' }, 'win32'));
    expect(windows.root).toBe('C:\\Users\\ada\\AppData\\Local\\T3-Tab');
    expect(windows.launcher).toBe('C:\\Users\\ada\\AppData\\Local\\T3-Tab\\t3-tab.cmd');
    expect(windows.hostLauncher).toBe('C:\\Users\\ada\\AppData\\Local\\T3-Tab\\native-host.cmd');
  });

  it('writes launchers that fall back to the Node on PATH and pass the browser no extra arguments to the program', () => {
    const unix = launcherScript({ platform: 'linux' }, "/opt/it's/node", '/h/cli.js', 'cli');
    expect(unix).toContain(`NODE='/opt/it'\\''s/node'`);
    expect(unix).toContain('[ -x "$NODE" ] || NODE=node');
    expect(unix).toContain(`exec "$NODE" '/h/cli.js' "$@"`);
    expect(launcherScript({ platform: 'linux' }, '/n', '/h/cli.js', 'host')).toContain(`'/h/cli.js' native-host\n`);
    const windows = launcherScript({ platform: 'win32' }, 'C:\\node\\node.exe', 'C:\\h\\cli.js', 'host');
    expect(windows).toBe('@echo off\r\nsetlocal\r\nset "NODE=C:\\node\\node.exe"\r\nif not exist "%NODE%" set "NODE=node"\r\n"%NODE%" "C:\\h\\cli.js" native-host\r\n');
  });

  it('points an agent entry at the launcher once installed, and at the checkout otherwise', () => {
    const linux = currentHost({ HOME: '/home/ada' }, 'linux');
    expect(mcpCommand(linux, '/home/ada/.local/share/t3-tab/cli.js', '/n/node', true)).toEqual({ command: '/home/ada/.local/share/t3-tab/t3-tab', args: ['mcp'] });
    expect(mcpCommand(linux, '/repo/dist/cli.js', '/n/node', false)).toEqual({ command: '/n/node', args: ['/repo/dist/cli.js', 'mcp'] });
    const windows = currentHost({ USERPROFILE: 'C:\\U\\a' }, 'win32');
    expect(mcpCommand(windows, '', 'C:\\n\\node.exe', true)).toEqual({ command: 'C:\\n\\node.exe', args: ['C:\\U\\a\\AppData\\Local\\T3-Tab\\cli.js', 'mcp'] });
  });
});

describe('native host registration on each system (planned, not run on macOS or Windows)', () => {
  it('Linux: a manifest in each browser profile folder, which follows XDG_CONFIG_HOME', () => {
    const host = currentHost({ HOME: '/home/ada' }, 'linux');
    expect(planRegistrations(['chromium', 'chrome', 'brave', 'edge', 'vivaldi'], host).map((entry) => entry.manifestPath)).toEqual([
      '/home/ada/.config/chromium/NativeMessagingHosts/com.t3tab.native.json',
      '/home/ada/.config/google-chrome/NativeMessagingHosts/com.t3tab.native.json',
      '/home/ada/.config/BraveSoftware/Brave-Browser/NativeMessagingHosts/com.t3tab.native.json',
      '/home/ada/.config/microsoft-edge/NativeMessagingHosts/com.t3tab.native.json',
      '/home/ada/.config/vivaldi/NativeMessagingHosts/com.t3tab.native.json',
    ]);
    expect(userDataDirectory('brave', currentHost({ HOME: '/h', XDG_CONFIG_HOME: '/cfg' }, 'linux'))).toBe('/cfg/BraveSoftware/Brave-Browser');
  });

  it('Linux: also the profile folder of a browser running with its own --user-data-dir, once', () => {
    const host = currentHost({ HOME: '/home/ada' }, 'linux');
    const plan = planRegistrations(['brave'], host, ['/work/test-profile', '/work/test-profile', '/home/ada/.config/BraveSoftware/Brave-Browser']);
    expect(plan.map((entry) => entry.manifestPath)).toEqual([
      '/home/ada/.config/BraveSoftware/Brave-Browser/NativeMessagingHosts/com.t3tab.native.json',
      '/work/test-profile/NativeMessagingHosts/com.t3tab.native.json',
    ]);
  });

  it('macOS: a manifest under Application Support', () => {
    const host = currentHost({ HOME: '/Users/ada' }, 'darwin');
    expect(planRegistrations(['chrome', 'brave', 'edge'], host).map((entry) => entry.manifestPath)).toEqual([
      '/Users/ada/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.t3tab.native.json',
      '/Users/ada/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts/com.t3tab.native.json',
      '/Users/ada/Library/Application Support/Microsoft Edge/NativeMessagingHosts/com.t3tab.native.json',
    ]);
  });

  it('Windows: one manifest file in the helper folder and an HKCU key per browser', () => {
    const host = currentHost({ USERPROFILE: 'C:\\Users\\ada', LOCALAPPDATA: 'C:\\Users\\ada\\AppData\\Local' }, 'win32');
    expect(planRegistrations(['chrome', 'edge', 'brave'], host, ['D:\\ignored'])).toEqual([
      { kind: 'registry', browser: 'chrome', key: `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${NATIVE_HOST_NAME}`, manifestPath: 'C:\\Users\\ada\\AppData\\Local\\T3-Tab\\com.t3tab.native.json' },
      { kind: 'registry', browser: 'edge', key: `HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\${NATIVE_HOST_NAME}`, manifestPath: 'C:\\Users\\ada\\AppData\\Local\\T3-Tab\\com.t3tab.native.json' },
      { kind: 'registry', browser: 'brave', key: `HKCU\\Software\\BraveSoftware\\Brave-Browser\\NativeMessagingHosts\\${NATIVE_HOST_NAME}`, manifestPath: 'C:\\Users\\ada\\AppData\\Local\\T3-Tab\\com.t3tab.native.json' },
    ]);
  });

  it('runs reg.exe to add and delete the Windows keys, writing the manifest the registry points at', async () => {
    const dir = await mkdtemp(join(tmpdir(), 't3-tab-reg-'));
    try {
      const manifestPath = join(dir, 'com.t3tab.native.json');
      const calls: string[][] = [];
      const entry = { kind: 'registry' as const, browser: 'chrome' as const, key: 'HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.t3tab.native', manifestPath };
      await applyRegistrations([entry], 'C:\\h\\native-host.cmd', async (args) => void calls.push(args));
      expect(calls).toEqual([['add', entry.key, '/ve', '/t', 'REG_SZ', '/d', manifestPath, '/f']]);
      expect(JSON.parse(await readFile(manifestPath, 'utf8')).path).toBe('C:\\h\\native-host.cmd');
      expect(await removeRegistrations([entry], async (args) => void calls.push(args))).toEqual([entry]);
      expect(calls[1]).toEqual(['delete', entry.key, '/f']);
      await expect(stat(manifestPath)).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('allows the extension id, and no other, in the manifest', () => {
    expect(hostManifest('/h/native-host')).toMatchObject({ name: NATIVE_HOST_NAME, type: 'stdio', path: '/h/native-host', allowed_origins: [`chrome-extension://${EXTENSION_ID}/`] });
  });

  it('finds the browsers of each system by program or profile folder', async () => {
    const exists = (present: string[]): FindBrowsersDeps => ({ exists: async (path) => present.includes(path), onPath: async () => false });
    expect(await findBrowsers(currentHost({ HOME: '/Users/ada' }, 'darwin'), exists(['/Applications/Brave Browser.app', '/Users/ada/Library/Application Support/Google/Chrome']))).toEqual(['chrome', 'brave']);
    const windows = currentHost({ USERPROFILE: 'C:\\U', LOCALAPPDATA: 'C:\\U\\L' }, 'win32');
    expect(await findBrowsers(windows, exists(['C:\\U\\L\\Microsoft\\Edge\\User Data']))).toEqual(['edge']);
    expect(await findBrowsers(currentHost({ HOME: '/h' }, 'linux'), { exists: async () => false, onPath: async (names) => names.includes('brave-browser') })).toEqual(['brave']);
    expect(await findBrowsers(currentHost({ HOME: '/h' }, 'linux'), none)).toEqual([]);
  });
});

describe('browsers running with their own profile folder', () => {
  it('reads --user-data-dir from a browser main process only', () => {
    expect(userDataDirFromArguments(['/opt/brave.com/brave/brave', '--user-data-dir=/work/p', '--x'])).toBe('/work/p');
    expect(userDataDirFromArguments(['/usr/bin/chromium', '--user-data-dir', '/work/q'])).toBe('/work/q');
    expect(userDataDirFromArguments(['/usr/bin/chromium', '--type=renderer', '--user-data-dir=/work/p'])).toBeUndefined();
    expect(userDataDirFromArguments(['/usr/bin/vim', '--user-data-dir=/work/p'])).toBeUndefined();
    expect(userDataDirFromArguments(['/usr/bin/chromium'])).toBeUndefined();
  });

  it('collects them from /proc on Linux and from ps on macOS', async () => {
    const linux = await runningProfiles(currentHost({ HOME: '/h' }, 'linux'), {
      ...noProcesses,
      readCommandLines: async () => [['/x/chrome', '--user-data-dir=/a'], ['/x/chrome', '--type=gpu-process', '--user-data-dir=/a'], ['/bin/sh']],
    });
    expect(linux).toEqual(['/a']);
    const mac = await runningProfiles(currentHost({ HOME: '/h' }, 'darwin'), {
      ...noProcesses,
      psOutput: async () => '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser --user-data-dir=/Users/a/My Profile --flag\n/bin/zsh\n',
    });
    expect(mac).toEqual(['/Users/a/My Profile']);
    expect(await runningProfiles(currentHost({ HOME: '/h' }, 'win32'), noProcesses)).toEqual([]);
  });
});

describe('setup and uninstall on Linux (run in a temporary home)', () => {
  let home: string;
  let bundle: string;
  const lines: string[] = [];
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 't3-tab-setup-'));
    bundle = join(home, 'npx-cache', 'cli.js');
    await mkdir(join(home, 'npx-cache'), { recursive: true });
    await writeFile(bundle, '#!/usr/bin/env node\nconsole.log("bundle");\n');
    lines.length = 0;
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });
  const options = (extra: Partial<Parameters<typeof setupHelper>[0]> = {}): Parameters<typeof setupHelper>[0] => ({
    host: currentHost({ HOME: home }, 'linux'),
    node: '/fake/node',
    bundle,
    version: '9.9.9',
    stateDir: join(home, '.local', 'state', 't3-tab'),
    say: (line) => void lines.push(line),
    findDeps: { exists: async (path) => path.endsWith('/.config/chromium'), onPath: async () => false },
    processDeps: { ...noProcesses, readCommandLines: async () => [['/x/chrome', `--user-data-dir=${join(home, 'elsewhere')}`]] },
    ...extra,
  });

  it('refuses to run from an unbundled build', async () => {
    await expect(setupHelper(options({ bundle: undefined, version: undefined }))).rejects.toThrow(NOT_BUNDLED);
  });

  it('copies the program, writes launchers, registers every browser found and the running profile, and records it', async () => {
    const result = await setupHelper(options());
    const layout = helperLayout(currentHost({ HOME: home }, 'linux'));
    expect(await readFile(layout.cli, 'utf8')).toContain('console.log("bundle")');
    expect(await readFile(layout.launcher, 'utf8')).toContain(`exec "$NODE" '${layout.cli}' "$@"`);
    expect((await stat(layout.hostLauncher)).mode & 0o111).not.toBe(0);
    const manifestPaths = result.registrations.map((entry) => entry.manifestPath);
    expect(manifestPaths).toEqual([
      join(home, '.config/chromium/NativeMessagingHosts/com.t3tab.native.json'),
      join(home, 'elsewhere/NativeMessagingHosts/com.t3tab.native.json'),
    ]);
    for (const path of manifestPaths) expect(JSON.parse(await readFile(path, 'utf8')).path).toBe(layout.hostLauncher);
    const marker = JSON.parse(await readFile(layout.marker, 'utf8'));
    expect(marker).toMatchObject({ name: 't3-tab', version: '9.9.9', protocolVersion: PROTOCOL_VERSION });
    expect(marker.registrations).toHaveLength(2);
  });

  it('describes what it would do and changes nothing with --print', async () => {
    await setupHelper(options({ print: true }));
    expect(lines.join('\n')).toContain('Would install T3-Tab 9.9.9');
    await expect(readdir(join(home, '.local'))).rejects.toThrow();
  });

  it('is repeatable, and an update replaces the program', async () => {
    await setupHelper(options());
    await writeFile(bundle, 'console.log("newer");\n');
    await setupHelper(options({ version: '10.0.0' }));
    const layout = helperLayout(currentHost({ HOME: home }, 'linux'));
    expect(await readFile(layout.cli, 'utf8')).toContain('newer');
    expect(JSON.parse(await readFile(layout.marker, 'utf8')).version).toBe('10.0.0');
  });

  it('uninstall removes the program, launchers, manifests (also in the running profile) and state, and nothing else', async () => {
    await setupHelper(options());
    const stateDir = join(home, '.local', 'state', 't3-tab');
    await mkdir(stateDir, { recursive: true });
    await writeFile(join(stateDir, 'daemon.json'), '{}');
    const neighbour = join(home, '.config', 'chromium', 'NativeMessagingHosts', 'com.other.host.json');
    await writeFile(neighbour, JSON.stringify({ name: 'com.other.host', type: 'stdio' }));
    await uninstallHelper({ host: currentHost({ HOME: home }, 'linux'), stateDir, agents: [], say: () => undefined, processDeps: noProcesses, removeAgent: async () => '' });
    const layout = helperLayout(currentHost({ HOME: home }, 'linux'));
    await expect(readdir(layout.root)).rejects.toThrow();
    await expect(stat(join(home, 'elsewhere/NativeMessagingHosts/com.t3tab.native.json'))).rejects.toThrow();
    await expect(stat(join(home, '.config/chromium/NativeMessagingHosts/com.t3tab.native.json'))).rejects.toThrow();
    await expect(stat(join(home, 'elsewhere/NativeMessagingHosts'))).rejects.toThrow();
    await expect(stat(stateDir)).rejects.toThrow();
    expect(await readFile(neighbour, 'utf8')).toContain('com.other.host');
  });
});
