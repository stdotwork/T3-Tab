import { randomBytes } from 'node:crypto';
import { createServer, request as httpRequest } from 'node:http';
import { readFile, rm } from 'node:fs/promises';

import {
  assert,
  closeServer,
  connectMcp,
  createHome,
  extensionWorker,
  installNativeHost,
  launchBrowser,
  listen,
  panelRequest,
  requireBuild,
  stopDaemon,
  waitForBrowser,
} from './harness.mjs';
import { checkInstallCommand } from './checks-install.mjs';
import { checkProductInstall } from './checks-product-install.mjs';
import { checkStaleWorker } from './checks-stale-worker.mjs';
import { checkRealUse } from './checks-real-use.mjs';
import { checkAgentTools } from './checks-agent-tools.mjs';
import { checkFrames, checkPermissions } from './checks-permissions.mjs';
import { checkActionTools, checkBrowserTools, checkKeepalive, rawCall, setAutoPrompt } from './checks-tools.mjs';
import { checkPanelSessions, installFakeAgents, startFakeT3Environment } from './panel-sessions.mjs';
import { SITE, SITE_NOT_FOUND } from './site.mjs';

const home = await createHome();
const { cliPath, tempHome, statePath, childEnv } = home;

let browserContext;
let mcpClient;
let mcpClientB;
let pageServer;
let pageServerB;
let panelPage;
let framesPage = () => '';
let fakeT3;

try {
  await requireBuild(home);
  await checkProductInstall();
  await checkStaleWorker(home.extensionDir);
  await checkRealUse();
  await checkAgentTools();
  await checkInstallCommand({ cliPath, tempHome, childEnv });
  // After the install check, which uses the real agent CLIs: from here on the daemon finds the fakes first.
  const fakes = await installFakeAgents(home);
  // A fake T3 environment (OAuth and /mcp) recorded under the temporary T3 home; the real T3 is never reached.
  fakeT3 = await startFakeT3Environment(home);
  // The install check's `mcp list` started a daemon without the fakes on its PATH; the next client starts another.
  await stopDaemon(statePath);

  const siteHandler = (request, response) => {
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    const body = path === '/frames' ? framesPage() : SITE[path];
    response.writeHead(body === undefined ? 404 : 200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(body ?? SITE_NOT_FOUND);
  };
  pageServer = createServer(siteHandler);
  pageServerB = createServer(siteHandler);
  await Promise.all([listen(pageServer), listen(pageServerB)]);

  const address = pageServer.address();
  const addressB = pageServerB.address();
  if (address === null || typeof address === 'string' || addressB === null || typeof addressB === 'string') {
    throw new Error('Test page servers did not bind to TCP addresses');
  }

  framesPage = () => `<!doctype html>
<html lang="en"><head><title>Frames</title></head><body><h1>Frames page</h1>
<iframe title="other origin" src="http://127.0.0.1:${addressB.port}/perm-b"></iframe>
<iframe title="same origin" src="/perm-a"></iframe></body></html>`;

  await installNativeHost(home);

  browserContext = await launchBrowser(home);

  const page = browserContext.pages()[0] ?? (await browserContext.newPage());
  await page.goto(`http://127.0.0.1:${address.port}`);
  await page.getByRole('heading', { name: 'T3-Tab E2E' }).waitFor();
  const siteUrl = `http://127.0.0.1:${address.port}`;
  const otherSiteUrl = `http://127.0.0.1:${addressB.port}`;

  const { serviceWorker, extensionId } = await extensionWorker(browserContext);
  console.log(`Extension ID: ${extensionId}`);

  ({ client: mcpClient } = await connectMcp(home, 't3-tab-e2e-a'));
  const statusText = await waitForBrowser(mcpClient);
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
  const posing = await upgradeStatus(state.port, state.token, `chrome-extension://${extensionId}`);
  assert(posing === 403, `The daemon.json token took the extension role: HTTP ${posing}`);
  console.log(`daemon.json token with the extension Origin: refused (HTTP ${posing}) while the real extension stays connected`);

  ({ client: mcpClientB } = await connectMcp(home, 't3-tab-e2e-b'));

  await rawCall(mcpClient, 'tabs', {});
  await rawCall(mcpClientB, 'tabs', {});

  panelPage = await browserContext.newPage();
  await panelPage.goto(`chrome-extension://${extensionId}/sidepanel.html?headless=1`);
  const senderGuard = await panelPage.evaluate(async () => await chrome.runtime.sendMessage({ type: 'panel.state' }));
  assert(senderGuard?.ok === false && senderGuard.error === 'Forbidden', `A tab-hosted panel message was not refused: ${JSON.stringify(senderGuard)}`);
  console.log('Panel message guard: extension page hosted in a tab was refused');

  const permission = await checkPermissions({
    mcpClient,
    mcpClientB,
    page,
    serviceWorker,
    panelPage,
    siteUrl,
    otherSiteUrl,
    browserContext,
  });
  setAutoPrompt(serviceWorker, permission.sessionA.id);
  await page.goto(siteUrl);
  await page.getByRole('heading', { name: 'T3-Tab E2E' }).waitFor();
  await page.bringToFront();
  await panelRequest(serviceWorker, { type: 'panel.shareTab', sessionId: permission.sessionA.id, tabId: permission.ownerTabId });

  console.log('Existing tool checks: site setting remains ask; the harness auto-answers each prompt with Allow once');
  await checkBrowserTools({ mcpClient, page, siteUrl });
  await checkFrames({ mcpClient, siteUrl, otherSiteUrl });
  const newCheckFailures = [];
  try {
    await checkActionTools({ mcpClient, page });
  } catch (error) {
    newCheckFailures.push(`act/run_js: ${error.message}`);
  }
  try {
    await checkKeepalive(mcpClient);
  } catch (error) {
    newCheckFailures.push(`keepalive: ${error.message}`);
  }
  if (newCheckFailures.length > 0) {
    throw new Error(`New slice 4 checks failed:\n${newCheckFailures.join('\n')}`);
  }
  await checkPanelSessions({
    browserContext,
    serviceWorker,
    panelPage,
    siteUrl,
    fakes,
    fakeT3,
    home,
    mcpClient,
    screenshotPath: process.env.T3_TAB_E2E_SCREENSHOT,
  });
} finally {
  if (mcpClient !== undefined) {
    await mcpClient.close().catch(() => undefined);
  }
  if (mcpClientB !== undefined) {
    await mcpClientB.close().catch(() => undefined);
  }
  if (browserContext !== undefined) {
    await browserContext.close();
  }
  if (fakeT3 !== undefined) await fakeT3.close();
  if (pageServer !== undefined) await closeServer(pageServer);
  if (pageServerB !== undefined) await closeServer(pageServerB);
  await stopDaemon(statePath);
  await rm(tempHome, { recursive: true, force: true });
}

/** The status a WebSocket upgrade gets with this token and Origin; 101 means the daemon accepted it. */
async function upgradeStatus(port, token, origin) {
  return await new Promise((resolve, reject) => {
    const request = httpRequest({
      host: '127.0.0.1',
      port,
      headers: {
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-version': '13',
        'sec-websocket-key': randomBytes(16).toString('base64'),
        authorization: `Bearer ${token}`,
        origin,
      },
    });
    request.on('upgrade', (response, socket) => {
      socket.destroy();
      resolve(response.statusCode);
    });
    request.on('response', (response) => {
      response.resume();
      resolve(response.statusCode);
    });
    request.on('error', reject);
    request.end();
  });
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
