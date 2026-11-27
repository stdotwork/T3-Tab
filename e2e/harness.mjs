// Setup shared by the end-to-end run (extension.e2e.mjs) and the token benchmark (bench/bench.mjs):
// a temporary HOME, headless Chromium with the built extension, and MCP clients that speak to the real
// daemon over stdio. Nothing here touches the machine's own agent configuration or browser profile.
import { execFile, spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { chromium } from 'playwright';

const execFileAsync = promisify(execFile);

/**
 * Chromium upgrades an `http://` address to `https://` before it sends anything, and when the https site does not answer
 * within about 5 s or resets the connection the load fails as `net::ERR_BLOCKED_BY_CLIENT`. Playwright's own launches turn
 * the upgrade off with these two features (`HttpsUpgrades` alone is not enough); a browser started directly does so by
 * passing this flag. The benchmark browsers do, so a run on an http site does not depend on whether its https side answers.
 * The end-to-end browsers do not: they are meant to behave as the owner's browser does.
 */
export const NO_HTTPS_UPGRADE_FLAG = '--disable-features=HttpsUpgrades,HttpsFirstBalancedModeAutoEnable';

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

let shortTemp;
/**
 * A short folder for a browser's own temporary files. Chromium puts a socket there (`<TMPDIR>/org.chromium.Chromium.XXXXXX/SingletonSocket`)
 * and a Unix socket path is limited to about 100 characters, so a long TMPDIR of the caller (a CI workspace, a sandbox) made
 * every browser abort with "Socket path too long". The caller's TMPDIR stays as it is for everything else. One folder per
 * run, removed when the process exits.
 */
function browserTemp() {
  shortTemp ??= mkdtemp('/tmp/t3e-').then(
    (folder) => {
      process.once('exit', () => rmSync(folder, { recursive: true, force: true }));
      return folder;
    },
    () => tmpdir(),
  );
  return shortTemp;
}

/** The environment of a browser the harness starts: the run's own, with the short temporary folder. */
async function browserEnv(home) {
  return { ...home.childEnv, TMPDIR: await browserTemp() };
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
    env: await browserEnv(home),
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

/**
 * Headless Chromium that nothing but the extension debugs. Playwright attaches to every page, answers dialogs
 * itself and makes hidden tabs act focused, which hides how a real browser treats dialogs and background tabs.
 * `panel` sends a request to the extension's side-panel handler over a connection to its service worker only.
 * `httpsUpgrades: false` starts it without the browser's http-to-https upgrade (`NO_HTTPS_UPGRADE_FLAG`), for the benchmark.
 */
export async function launchUndrivenBrowser(home, startUrl, extraExtensions = [], { httpsUpgrades = true } = {}) {
  const extensions = [home.extensionDir, ...extraExtensions].join(',');
  const browser = spawn(
    chromium.executablePath(),
    [
      '--headless=new',
      '--no-sandbox',
      '--no-first-run',
      '--no-default-browser-check',
      `--user-data-dir=${home.profileDir}`,
      '--remote-debugging-port=0',
      '--window-size=1600,1000',
      '--silent-debugger-extension-api',
      `--disable-extensions-except=${extensions}`,
      `--load-extension=${extensions}`,
      ...(httpsUpgrades ? [] : [NO_HTTPS_UPGRADE_FLAG]),
      startUrl,
    ],
    { env: await browserEnv(home), stdio: 'ignore' },
  );
  const close = async () => {
    if (browser.exitCode !== null) return;
    const exited = new Promise((resolve) => browser.once('exit', resolve));
    browser.kill('SIGTERM');
    await Promise.race([exited, sleep(3_000)]);
    if (browser.exitCode === null) browser.kill('SIGKILL');
  };
  try {
    let port;
    for (let attempt = 0; attempt < 120 && port === undefined; attempt += 1) {
      port = await readFile(join(home.profileDir, 'DevToolsActivePort'), 'utf8').then(
        (content) => content.split('\n')[0],
        () => undefined,
      );
      if (port === undefined) await sleep(100);
    }
    if (port === undefined) throw new Error('Chromium did not report a debugging port');
    const workerUrl = await findExtensionWorker(port);
    const panel = async (request) => {
      const response = await evaluateOver(workerUrl, `globalThis.__t3tabHandlePanelRequest(${JSON.stringify(request)})`);
      if (response?.ok === false) throw new Error(`${request.type}: ${response.error}`);
      return response;
    };
    return { panel, worker: (expression) => evaluateOver(workerUrl, expression), close };
  } catch (error) {
    await close();
    throw error;
  }
}

async function findExtensionWorker(port) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());
    for (const target of targets) {
      if (target.type !== 'service_worker') continue;
      // A worker still starting has no `chrome.runtime` or panel handler yet: look again on the next pass.
      const name = await evaluateOver(
        target.webSocketDebuggerUrl,
        "typeof globalThis.__t3tabHandlePanelRequest === 'function' && chrome.runtime.getManifest().name",
      ).catch(() => undefined);
      if (name === 'T3-Tab') return target.webSocketDebuggerUrl;
    }
    await sleep(100);
  }
  throw new Error('The T3-Tab service worker did not start');
}

async function evaluateOver(url, expression) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = () => reject(new Error(`Could not connect to ${url}`));
  });
  try {
    return await new Promise((resolve, reject) => {
      socket.onmessage = (message) => {
        const reply = JSON.parse(message.data);
        if (reply.id !== 1) return;
        if (reply.result?.exceptionDetails !== undefined) reject(new Error(reply.result.exceptionDetails.exception?.description ?? reply.result.exceptionDetails.text));
        else resolve(reply.result?.result?.value);
      };
      socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
    });
  } finally {
    socket.close();
  }
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

/**
 * The browsers the daemon has connected, each with its tab count, from the daemon's own `status` control request (made
 * with `daemon.json`'s token, as an MCP server connects). No MCP tool reports this: it is the test's view, not an agent's.
 */
export async function daemonBrowsers(home) {
  const { PROTOCOL_VERSION } = await import('../packages/protocol/dist/index.js');
  const state = JSON.parse(await readFile(home.statePath, 'utf8'));
  return await new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${state.port}/`, { headers: { authorization: `Bearer ${state.token}` } });
    const done = (error, browsers) => {
      clearTimeout(timer);
      socket.close();
      if (error === undefined) resolve(browsers);
      else reject(error);
    };
    const timer = setTimeout(() => done(new Error('The daemon did not answer status')), 5_000);
    socket.addEventListener('open', () => {
      socket.send(JSON.stringify({ type: 'control.request', protocolVersion: PROTOCOL_VERSION, requestId: 'e2e-status', method: 'status' }));
    });
    socket.addEventListener('message', (event) => {
      const response = JSON.parse(String(event.data));
      if (response.requestId !== 'e2e-status') return;
      if (response.ok === true) done(undefined, response.result.browsers);
      else done(new Error(`The daemon refused status: ${response.error}`));
    });
    socket.addEventListener('error', () => done(new Error('Could not reach the daemon')));
  });
}

/** Asks the daemon until exactly one browser with at least one tab is connected, and describes it. */
export async function waitForBrowser(home) {
  let seen = 'the daemon was not reached';
  for (let attempt = 0; attempt < 160; attempt += 1) {
    try {
      const browsers = await daemonBrowsers(home);
      seen = JSON.stringify(browsers);
      if (browsers.length === 1 && browsers[0].tabCount >= 1) return `Browsers: 1\n- ${browsers[0].name}: ${browsers[0].tabCount} tabs`;
    } catch (error) {
      seen = error.message;
    }
    await sleep(250);
  }
  throw new Error(`Expected one connected browser with at least one tab. Got: ${seen}`);
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
