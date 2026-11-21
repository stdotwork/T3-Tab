import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { EXTENSION_ID, NATIVE_HOST_NAME } from '@t3-tab/protocol';

export type SupportedBrowser = 'chromium' | 'chrome' | 'brave';

export interface InstallNativeHostOptions {
  browser: SupportedBrowser;
  home: string;
  cliPath: string;
}

export async function installNativeHost(options: InstallNativeHostOptions): Promise<string> {
  const hostDirectory = join(options.home, '.local', 'share', 't3-tab');
  const launcherPath = join(hostDirectory, 'native-host');
  const manifestDirectory = join(
    options.home,
    '.config',
    browserConfigDirectory(options.browser),
    'NativeMessagingHosts',
  );
  const manifestPath = join(manifestDirectory, `${NATIVE_HOST_NAME}.json`);

  await mkdir(hostDirectory, { recursive: true, mode: 0o700 });
  await writeFile(launcherPath, nativeHostLauncher(process.execPath, options.cliPath), { mode: 0o755 });
  await chmod(launcherPath, 0o755);

  const manifest = {
    name: NATIVE_HOST_NAME,
    description: 'T3-Tab browser link',
    path: launcherPath,
    type: 'stdio',
    allowed_origins: [`chrome-extension://${EXTENSION_ID}/`],
  };
  await mkdir(manifestDirectory, { recursive: true, mode: 0o700 });
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 });
  await chmod(manifestPath, 0o644);
  return manifestPath;
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
