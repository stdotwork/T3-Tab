import { chmod, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { EXTENSION_ID, NATIVE_HOST_NAME } from '@t3-tab/protocol';

import { isRecord } from './install-config.js';

export type SupportedBrowser = 'chromium' | 'chrome' | 'brave';

export interface InstallNativeHostOptions {
  browser: SupportedBrowser;
  home: string;
  cliPath: string;
}

export interface NativeHostPaths {
  launcherPath: string;
  manifestDirectory: string;
  manifestPath: string;
}

export const BROWSERS: readonly SupportedBrowser[] = ['chromium', 'chrome', 'brave'];

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

function isNativeHostManifest(value: unknown, launcherPath: string): boolean {
  if (!isRecord(value)) return false;
  return value.name === NATIVE_HOST_NAME && value.path === launcherPath && value.type === 'stdio';
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
