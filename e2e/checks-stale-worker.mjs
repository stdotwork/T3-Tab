// An unpacked extension's panel files are read from disk each time the panel opens, but its service worker keeps the code
// it started with until the extension is reloaded. These checks swap the files on disk under a running browser and check
// that the panel notices, reloads the extension, and ends up connected, and that the helper row names the error the
// helper connection hit. Headless Chromium has no real side panel, so the panel page is opened in a tab and a bridge
// carries its requests to the worker, as in the other panel checks. Headless Chromium also cannot reload an extension
// that was loaded with --load-extension (it stays blocked after chrome.runtime.reload()), so the panel's call to
// chrome.runtime.reload() is recorded instead, and the harness does what a reload does: it restarts the browser on the
// same profile with its cached worker script removed, so the worker starts again from the files on disk and the panel's
// stored state survives.
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { assert, createHome, installNativeHost, launchBrowser, panelRequest, requireBuild, sleep, stopDaemon } from './harness.mjs';

const isWorker = (worker) => worker.url().startsWith('chrome-extension://');

/** Every .js file under a folder. */
async function scripts(dir) {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await scripts(path)));
    else if (entry.name.endsWith('.js')) found.push(path);
  }
  return found;
}

async function replaceInScripts(dir, from, to, only) {
  let count = 0;
  for (const file of await scripts(dir)) {
    if (only !== undefined && !file.endsWith(only)) continue;
    const source = await readFile(file, 'utf8');
    if (!source.includes(from)) continue;
    count += source.split(from).length - 1;
    await writeFile(file, source.replaceAll(from, to));
  }
  return count;
}

/**
 * The extension's service worker that is running now. After a reload the old worker may still be listed and fails to
 * answer; then a blank page is opened and closed to start the new one.
 */
async function currentWorker(context) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    for (const worker of context.serviceWorkers().filter(isWorker)) {
      if (await worker.evaluate(() => true).then(() => true, () => false)) return worker;
    }
    const wake = await context.newPage();
    await context.waitForEvent('serviceworker', { predicate: isWorker, timeout: 3_000 }).catch(() => undefined);
    await wake.close();
  }
  return undefined;
}

async function openPanel(context, extensionId) {
  const page = await context.newPage();
  await page.addInitScript(() => {
    chrome.runtime.reload = () => {
      window.__reloadRequested = (window.__reloadRequested ?? 0) + 1;
    };
  });
  await page.exposeFunction('__t3tabPanelBridge', async (request) => {
    try {
      const worker = await currentWorker(context);
      if (worker === undefined) return { ok: false, error: 'The extension has no running service worker' };
      // As the worker's own message listener answers: a refused request comes back as { ok: false, error }.
      return await worker.evaluate(async (message) => {
        try {
          return await globalThis.__t3tabHandlePanelRequest(message);
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
      }, request);
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
  await page.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  return page;
}

async function untilTrue(what, probe, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probe()) return;
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${what}`);
}

/** The new-thread screen's setup card, which says what the helper hit while it is not connected. */
const helperRow = (page) => page.locator('[data-setup-card]').filter({ hasText: 'T3-Tab helper' });

/** The helper is connected: the panel is on the new-thread screen and its setup card has gone by itself. */
async function helperConnected(page) {
  await page.locator('.composer-input').waitFor({ timeout: 25_000 });
  await page.locator('[data-setup-card]').waitFor({ state: 'detached', timeout: 25_000 });
}

const reloads = (page) => page.evaluate(() => window.__reloadRequested ?? 0);

async function withBrowser(extensionDir, body) {
  const home = await createHome();
  home.extensionDir = extensionDir;
  await requireBuild({ ...home, extensionDir });
  const browser = { context: undefined, extensionId: '', home };
  const start = async () => {
    browser.context = await launchBrowser(home);
    const worker = await currentWorker(browser.context);
    browser.extensionId = await worker.evaluate(() => chrome.runtime.id);
  };
  /** What a reload does to the worker: it starts again from the files on disk. The profile, and so the panel's storage, stays. */
  browser.reload = async () => {
    await browser.context.close();
    // A restarted browser would otherwise reuse the cached worker script; a real reload registers the worker again.
    await rm(join(home.profileDir, 'Default', 'Service Worker'), { recursive: true, force: true });
    await start();
  };
  try {
    await start();
    await body(browser);
  } finally {
    await browser.context?.close().catch(() => undefined);
    await stopDaemon(home.statePath);
    await rm(home.tempHome, { recursive: true, force: true });
  }
}

/** Opens the panel and waits until it has asked for the extension to be reloaded. */
async function openUntilReloadRequested(browser) {
  const page = await openPanel(browser.context, browser.extensionId);
  await untilTrue('the panel to ask for a reload', async () => (await reloads(page)) > 0);
  await page.getByText('Updating the extension').waitFor({ timeout: 5_000 });
  return page;
}

export async function checkStaleWorker(builtDir) {
  const scratch = await mkdtemp(join(tmpdir(), 't3-tab-stale-'));
  try {
    // 1. A worker of an older build: the files on disk are replaced by another build while the browser runs.
    const live = join(scratch, 'live');
    await cp(builtDir, live, { recursive: true });
    await withBrowser(live, async (browser) => {
      const { home, context } = browser;
      await installNativeHost(home);
      const before = (await panelRequest(await currentWorker(context), { type: 'panel.build' })).buildId;
      const next = join(scratch, 'next');
      await cp(builtDir, next, { recursive: true });
      assert((await replaceInScripts(next, before, `next-${before}`)) >= 2, 'The build ID was not found in the worker and the panel');
      await cp(next, live, { recursive: true, force: true });
      assert((await panelRequest(await currentWorker(context), { type: 'panel.build' })).buildId === before, 'The worker changed without a reload');

      await openUntilReloadRequested(browser);
      await browser.reload();
      const after = (await panelRequest(await currentWorker(browser.context), { type: 'panel.build' })).buildId;
      assert(after === `next-${before}`, `After the reload the worker is ${after}, not the new build`);
      const reopened = await openPanel(browser.context, browser.extensionId);
      await helperConnected(reopened);
      await sleep(4_500);
      assert((await reloads(reopened)) === 0, 'The panel asked for a second reload');
      console.log(`Stale worker: files swapped under a running browser (${before} to ${after}); the panel asked for the extension to be reloaded; after it, the reopened panel is on the new-thread screen with the setup card gone by itself, with no second reload`);
    });

    // 2. A worker that predates the build check cannot answer it, and counts as another build.
    const old = join(scratch, 'old');
    await cp(builtDir, old, { recursive: true });
    assert((await replaceInScripts(old, 'panel.build', 'panel.buildNotKnown', 'background.js')) >= 1, 'Could not make a worker that does not know panel.build');
    await withBrowser(old, async (browser) => {
      await installNativeHost(browser.home);
      await assertRejects(panelRequest(await currentWorker(browser.context), { type: 'panel.build' }), 'Invalid panel request');
      await cp(builtDir, old, { recursive: true, force: true });
      await openUntilReloadRequested(browser);
      await browser.reload();
      const reopened = await openPanel(browser.context, browser.extensionId);
      await helperConnected(reopened);
      console.log('Stale worker: a worker too old to answer the build question counts as another build; the panel asked for a reload and, after it, ends up connected');
    });

    // 3. A reload that does not fix it is not repeated: the panel says what to do instead.
    const stuck = join(scratch, 'stuck');
    await cp(old, stuck, { recursive: true });
    assert((await replaceInScripts(stuck, 'panel.build', 'panel.buildNotKnown', 'background.js')) >= 1, 'Could not make a worker that does not know panel.build');
    await withBrowser(stuck, async (browser) => {
      await installNativeHost(browser.home);
      await openUntilReloadRequested(browser);
      await browser.reload();
      const second = await openPanel(browser.context, browser.extensionId);
      await helperRow(second).getByText('still an old build').waitFor({ timeout: 25_000 });
      await sleep(4_500);
      assert((await reloads(second)) === 0, 'The panel asked for a second reload');
      console.log('Stale worker: when a reload leaves the worker old, the panel asks for one reload, then says to reload it on the extensions page and does not loop');
    });

    // 4. The new-thread screen's setup card names the error the connection hit.
    await withBrowser(builtDir, async ({ home, context, extensionId }) => {
      // No real helper is installed, so the worker's link never opens and every answer below is the stub's.
      const manifestPath = join(home.profileDir, 'NativeMessagingHosts', 'com.t3tab.native.json');
      await mkdir(join(home.profileDir, 'NativeMessagingHosts'), { recursive: true });
      const manifest = { name: 'com.t3tab.native', description: 'stub', path: '/nonexistent', type: 'stdio', allowed_origins: [`chrome-extension://${extensionId}/`] };
      const stub = join(scratch, 'stub-host.mjs');
      const launcher = join(scratch, 'stub-host');
      const useHost = async (reply) => {
        await writeFile(stub, `const body = Buffer.from(JSON.stringify(${JSON.stringify(reply)}));\nconst head = Buffer.alloc(4);\nhead.writeUInt32LE(body.length);\nprocess.stdout.write(Buffer.concat([head, body]));\nprocess.stdin.on('data', () => {});\nsetTimeout(() => process.exit(0), 300);\n`);
        await writeFile(launcher, `#!/bin/sh\nexec '${process.execPath}' '${stub}'\n`);
        await chmod(launcher, 0o755);
        await writeFile(manifestPath, JSON.stringify({ ...manifest, path: launcher }));
      };
      const panel = await openPanel(context, extensionId);
      // The browser has not been asked to start the real helper yet: the row says it is connecting, never "missing".
      await useHost({ type: 'native.error', protocolVersion: 5, error: 'The T3-Tab extension is older than the helper.' });
      await helperRow(panel).getByText('Reload T3-Tab on your browser').waitFor({ timeout: 25_000 });
      await helperRow(panel).getByText('The browser said: The T3-Tab extension is older than the helper.').waitFor();
      assert(!(await helperRow(panel).locator('.command-line').count()) && (await panel.locator('.command-line').count()) === 0, 'A behind extension should not be told to run the command');
      console.log('Setup card: a native.error from the host is shown in words, with the one action (reload the extension) and what the browser said');

      await useHost({ type: 'native.daemon', protocolVersion: 5, port: await closedPort(), token: 'x' });
      await helperRow(panel).getByText('could not connect to it').waitFor({ timeout: 25_000 });
      await helperRow(panel).getByText("The browser said: The browser could not connect to the helper's background program").waitFor();
      assert((await panel.locator('.command-line').count()) === 1, 'A refused connection should offer the command');
      if (process.env.T3_TAB_E2E_SHOTS !== undefined) {
        await panel.setViewportSize({ width: 400, height: 800 });
        for (const scheme of ['light', 'dark']) {
          await panel.emulateMedia({ colorScheme: scheme });
          await sleep(350);
          await panel.screenshot({ path: join(process.env.T3_TAB_E2E_SHOTS, `helper-connection-refused-${scheme}.png`) });
        }
      }
      console.log('Setup card: a refused WebSocket is shown with its code, and the command that restarts the helper');

      await writeFile(launcher, '#!/bin/sh\nexit 1\n');
      await helperRow(panel).getByText('started the helper and it stopped').waitFor({ timeout: 25_000 });
      console.log('Setup card: a native host that exits is shown as such, with the Node requirement');

      await writeFile(manifestPath, JSON.stringify({ ...manifest, allowed_origins: ['chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/'] }));
      await helperRow(panel).getByText('does not know this extension').waitFor({ timeout: 25_000 });
      await rm(manifestPath);
      await helperRow(panel).getByText('Run this in a terminal').waitFor({ timeout: 25_000 });
      console.log('Setup card: a manifest for another extension ID, and no manifest at all, are told apart');
    });
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

async function assertRejects(promise, message) {
  try {
    await promise;
  } catch (error) {
    assert(String(error.message).includes(message), `Expected "${message}", got "${error.message}"`);
    return;
  }
  throw new Error(`Expected a rejection with "${message}"`);
}

async function closedPort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}
