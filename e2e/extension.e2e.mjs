import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { chromium } from 'playwright';

const execFileAsync = promisify(execFile);
const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const extensionDir =
  process.env.T3_TAB_E2E_EXTENSION_DIR ?? join(rootDir, 'packages/extension/.output/chrome-mv3');
const cliPath = join(rootDir, 'packages/server/dist/cli.js');
const tempHome = await mkdtemp(join(tmpdir(), 't3-tab-e2e-'));
const profileDir = join(tempHome, '.config', 'chromium');
const stateDir = join(tempHome, '.local', 'state', 't3-tab');
const statePath = join(stateDir, 'daemon.json');
const childEnv = cleanEnv({
  ...process.env,
  HOME: tempHome,
  XDG_STATE_HOME: join(tempHome, '.local', 'state'),
  XDG_CONFIG_HOME: join(tempHome, '.config'),
  XDG_CACHE_HOME: join(tempHome, '.cache'),
  XDG_DATA_HOME: join(tempHome, '.local', 'share'),
});

let browserContext;
let mcpClient;
let mcpTransport;
let pageServer;

try {
  await stat(join(extensionDir, 'manifest.json'));
  await mkdir(profileDir, { recursive: true });

  pageServer = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html>
      <html lang="en">
        <head><meta charset="UTF-8" /><title>T3-Tab E2E</title></head>
        <body><h1>T3-Tab E2E</h1></body>
      </html>`);
  });

  await new Promise((resolve, reject) => {
    pageServer.once('error', reject);
    pageServer.listen(0, '127.0.0.1', resolve);
  });

  const address = pageServer.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Test page server did not bind to a TCP address');
  }

  await execFileAsync(
    process.execPath,
    [cliPath, 'native-host', 'install', '--browser', 'chromium'],
    { env: childEnv },
  );

  browserContext = await chromium.launchPersistentContext(profileDir, {
    channel: 'chromium',
    headless: true,
    env: childEnv,
    args: [
      `--disable-extensions-except=${extensionDir}`,
      `--load-extension=${extensionDir}`,
    ],
  });

  const page = browserContext.pages()[0] ?? (await browserContext.newPage());
  await page.goto(`http://127.0.0.1:${address.port}`);
  await page.getByRole('heading', { name: 'T3-Tab E2E' }).waitFor();

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
  console.log(`Extension ID: ${extensionId}`);

  mcpTransport = new StdioClientTransport({
    command: process.execPath,
    args: [cliPath, 'mcp'],
    env: childEnv,
    stderr: 'pipe',
  });
  mcpTransport.stderr?.on('data', (chunk) => process.stderr.write(chunk));
  mcpClient = new Client({ name: 't3-tab-e2e', version: '1.0.0' });
  await mcpClient.connect(mcpTransport);

  let statusText = '';
  let tabCount = 0;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const result = await mcpClient.callTool({ name: 'status', arguments: {} });
    statusText = result.content
      .filter((item) => item.type === 'text')
      .map((item) => item.text)
      .join('\n');
    tabCount = parseStatusTabCount(statusText);
    if (/^Browsers: 1$/m.test(statusText) && tabCount >= 1) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  if (!/^Browsers: 1$/m.test(statusText) || tabCount < 1) {
    throw new Error(`Expected one connected browser with at least one tab. Got:\n${statusText}`);
  }
  console.log(`MCP status result:\n${statusText}`);

  const state = JSON.parse(await readFile(statePath, 'utf8'));
  if (typeof state.port !== 'number') {
    throw new Error(`Daemon state has no port: ${JSON.stringify(state)}`);
  }
  const refused = await wrongTokenIsRefused(state.port);
  if (!refused) {
    throw new Error('A control connection with the wrong token was accepted');
  }
  console.log('Wrong-token control connection: refused');
} finally {
  if (mcpClient !== undefined) {
    await mcpClient.close().catch(() => undefined);
  }
  if (browserContext !== undefined) {
    await browserContext.close();
  }
  if (pageServer !== undefined) {
    await new Promise((resolve, reject) => {
      pageServer.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }
  await stopDaemon();
  await rm(tempHome, { recursive: true, force: true });
}

function cleanEnv(env) {
  return Object.fromEntries(Object.entries(env).filter((entry) => entry[1] !== undefined));
}

function parseStatusTabCount(text) {
  const match = /^- .*: (\d+) tabs?$/m.exec(text);
  return match === null ? 0 : Number(match[1]);
}

async function wrongTokenIsRefused(port) {
  return await new Promise((resolve) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/?token=wrong-token`);
    const timer = setTimeout(() => {
      socket.close();
      resolve(false);
    }, 3_000);
    socket.addEventListener('open', () => {
      clearTimeout(timer);
      socket.close();
      resolve(false);
    });
    socket.addEventListener('error', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

async function stopDaemon() {
  try {
    const state = JSON.parse(await readFile(statePath, 'utf8'));
    if (typeof state.pid === 'number') {
      process.kill(state.pid, 'SIGTERM');
      for (let attempt = 0; attempt < 40; attempt += 1) {
        if (!processIsAlive(state.pid)) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
  } catch {
    // The daemon never started, or it exited before cleanup.
  }
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
