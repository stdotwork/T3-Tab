import { createServer } from 'node:http';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const extensionDir =
  process.env.T3_TAB_E2E_EXTENSION_DIR ?? join(rootDir, 'packages/extension/.output/chrome-mv3');
const profileDir = await mkdtemp(join(tmpdir(), 't3-tab-e2e-'));
let browserContext;
let pageServer;

try {
  await stat(join(extensionDir, 'manifest.json'));

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

  browserContext = await chromium.launchPersistentContext(profileDir, {
    channel: 'chromium',
    headless: true,
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
} finally {
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
  await rm(profileDir, { recursive: true, force: true });
}
