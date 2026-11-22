// Setup shared by the end-to-end run (extension.e2e.mjs) and the token benchmark (bench/bench.mjs):
// a temporary HOME, headless Chromium with the built extension, and MCP clients that speak to the real
// daemon over stdio. Nothing here touches the machine's own agent configuration or browser profile.
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { chromium } from 'playwright';

const execFileAsync = promisify(execFile);

export const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Paths and environment for one run, all under a new temporary HOME. */
export async function createHome() {
  const tempHome = await mkdtemp(join(tmpdir(), 't3-tab-e2e-'));
  const stateDir = join(tempHome, '.local', 'state', 't3-tab');
  return {
    rootDir,
    extensionDir: process.env.T3_TAB_E2E_EXTENSION_DIR ?? join(rootDir, 'packages/extension/.output/chrome-mv3'),
    cliPath: join(rootDir, 'packages/server/dist/cli.js'),
    tempHome,
    profileDir: join(tempHome, '.config', 'chromium'),
    stateDir,
    statePath: join(stateDir, 'daemon.json'),
    childEnv: cleanEnv({
      ...process.env,
      HOME: tempHome,
      XDG_STATE_HOME: join(tempHome, '.local', 'state'),
      XDG_CONFIG_HOME: join(tempHome, '.config'),
      XDG_CACHE_HOME: join(tempHome, '.cache'),
      XDG_DATA_HOME: join(tempHome, '.local', 'share'),
    }),
  };
}

/** Fails early when the extension has not been built. */
export async function requireBuild(home) {
  await stat(join(home.extensionDir, 'manifest.json'));
  await stat(home.cliPath);
  await mkdir(home.profileDir, { recursive: true });
}

export async function installNativeHost(home) {
  await execFileAsync(process.execPath, [home.cliPath, 'native-host', 'install', '--browser', 'chromium'], {
    env: home.childEnv,
  });
}

/** Headless Chromium with the built extension loaded and no viewport emulation. */
export async function launchBrowser(home) {
  return await chromium.launchPersistentContext(home.profileDir, {
    channel: 'chromium',
    headless: true,
    // No viewport emulation: the window is wider than 1280, so a screenshot has to be scaled down.
    viewport: null,
    env: home.childEnv,
    args: [
      '--window-size=1600,1000',
      // Without this, the "started debugging this browser" bar comes and goes as the extension attaches, and the
      // viewport's height (so every screenshot's size) changes with it.
      '--silent-debugger-extension-api',
      `--disable-extensions-except=${home.extensionDir}`,
      `--load-extension=${home.extensionDir}`,
    ],
  });
}

/** The extension's service worker, and its id. */
export async function extensionWorker(browserContext) {
  const isExtensionWorker = (worker) => worker.url().startsWith('chrome-extension://');
  let serviceWorker = browserContext.serviceWorkers().find(isExtensionWorker);
  if (serviceWorker === undefined) {
    serviceWorker = await browserContext.waitForEvent('serviceworker', {
      predicate: isExtensionWorker,
      timeout: 15_000,
    });
  }
  const extensionId = await serviceWorker.evaluate(() => chrome.runtime.id);
  if (!/^[a-p]{32}$/.test(extensionId)) {
    throw new Error(`Unexpected extension id from service worker: ${extensionId}`);
  }
  return { serviceWorker, extensionId };
}

/** One MCP client on its own `t3-tab mcp` process: one agent session. */
export async function connectMcp(home, name) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [home.cliPath, 'mcp'],
    env: home.childEnv,
    stderr: 'pipe',
  });
  transport.stderr?.on('data', (chunk) => process.stderr.write(chunk));
  const client = new Client({ name, version: '1.0.0' });
  await client.connect(transport);
  return { client, transport };
}

/** Polls `status` until exactly one browser with at least one tab is connected. */
export async function waitForBrowser(client) {
  let statusText = '';
  let tabCount = 0;
  for (let attempt = 0; attempt < 160; attempt += 1) {
    const result = await client.callTool({ name: 'status', arguments: {} });
    statusText = text(result);
    tabCount = parseStatusTabCount(statusText);
    if (/^Browsers: 1$/m.test(statusText) && tabCount >= 1) return statusText;
    await sleep(250);
  }
  throw new Error(`Expected one connected browser with at least one tab. Got:\n${statusText}`);
}

export async function panelRequest(serviceWorker, request) {
  const response = await serviceWorker.evaluate(async (message) => {
    const handle = globalThis.__t3tabHandlePanelRequest;
    if (typeof handle !== 'function') throw new Error('Panel handler is unavailable');
    return await handle(message);
  }, request);
  if (response === undefined) throw new Error(`The extension did not answer ${request.type}`);
  if (response?.ok === false) throw new Error(`${request.type}: ${response.error}`);
  return response;
}

export async function setSite(serviceWorker, origin, setting) {
  await panelRequest(serviceWorker, { type: 'panel.setSite', origin, setting });
}

export async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
}

export async function closeServer(server) {
  if (server.listening !== true) return;
  await new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

export async function stopDaemon(statePath) {
  try {
    const state = JSON.parse(await readFile(statePath, 'utf8'));
    if (typeof state.pid === 'number') {
      process.kill(state.pid, 'SIGTERM');
      for (let attempt = 0; attempt < 40; attempt += 1) {
        if (!processIsAlive(state.pid)) break;
        await sleep(50);
      }
    }
  } catch {
    // The daemon never started, or it exited before cleanup.
  }
}

/**
 * The caller's environment without what would point a child at the machine's own agent setup: Claude Code's and
 * Codex's config folders, T3 Code's home and thread (`T3CODE_*`, set inside a T3 thread), and T3-Tab's overrides.
 */
export function cleanEnv(env) {
  return Object.fromEntries(
    Object.entries(env).filter(
      ([key, value]) =>
        value !== undefined &&
        key !== 'CLAUDE_CONFIG_DIR' &&
        key !== 'CODEX_HOME' &&
        !key.startsWith('T3CODE_') &&
        !key.startsWith('T3_TAB_'),
    ),
  );
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function parseStatusTabCount(statusText) {
  const match = /^- .*: (\d+) tabs?$/m.exec(statusText);
  return match === null ? 0 : Number(match[1]);
}

export function text(result) {
  return result.content
    .filter((item) => item.type === 'text')
    .map((item) => item.text)
    .join('\n');
}

/** The ref (e12) printed at the start of the first line of a read that holds this label. */
export function refFor(readText, label) {
  return /^\s*(e\d+) /.exec(readText.split('\n').find((line) => line.includes(label)) ?? '')?.[1];
}

export function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function assert(condition, message) {
  if (!condition) throw new Error(message);
}

/** Pixel size of a JPEG, from its start-of-frame marker. */
export function jpegSize(bytes) {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined;
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1];
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: (bytes[offset + 5] << 8) | bytes[offset + 6], width: (bytes[offset + 7] << 8) | bytes[offset + 8] };
    }
    offset += 2 + ((bytes[offset + 2] << 8) | bytes[offset + 3]);
  }
  return undefined;
}
