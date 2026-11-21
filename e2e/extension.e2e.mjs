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

const SITE_NOT_FOUND = '<!doctype html><html lang="en"><head><title>Not found</title></head><body><h1>Not found</h1></body></html>';

const SITE = {
  '/': `<!doctype html>
<html lang="en">
  <head><meta charset="UTF-8" /><title>T3-Tab E2E</title></head>
  <body>
    <h1>T3-Tab E2E</h1>
    <nav aria-label="Main">
      <a href="/">Home</a> <a href="/about">About</a> <a href="/docs">Docs</a> <a href="/contact">Contact</a>
    </nav>
    <main>
      <h2>Sign up</h2>
      <form id="signup" aria-label="Sign up">
        <label>Name <input name="name" type="text" required></label>
        <label>Email <input name="email" type="email"></label>
        <label>Password <input name="password" type="password"></label>
        <label>Country
          <select name="country"><option>Australia</option><option>Brazil</option><option>Canada</option></select>
        </label>
        <fieldset>
          <legend>Plan</legend>
          <label><input type="radio" name="plan" value="free" checked> Free</label>
          <label><input type="radio" name="plan" value="pro"> Pro</label>
        </fieldset>
        <label><input type="checkbox" name="terms"> I agree to the terms</label>
        <label>Notes <textarea name="notes"></textarea></label>
        <button type="submit">Create account</button>
        <button type="reset">Reset</button>
      </form>
      <h2>Details</h2>
      <button id="toggle" aria-expanded="false">Show details</button>
      <section id="details" hidden>
        <p>Release 1.2 notes are here.</p>
        <a href="/notes">Release notes</a>
      </section>
    </main>
    <script>
      const toggle = document.getElementById('toggle');
      const details = document.getElementById('details');
      toggle.addEventListener('click', () => {
        const open = details.hidden;
        details.hidden = !open;
        toggle.textContent = open ? 'Hide details' : 'Show details';
        toggle.setAttribute('aria-expanded', String(open));
      });
      document.getElementById('signup').addEventListener('submit', (event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        const result = document.createElement('a');
        result.id = 'signup-result';
        result.href = '/success';
        result.textContent = 'Welcome ' + data.get('name') + ' (' + data.get('email') + ')';
        document.querySelector('main').append(result);
      });
    </script>
  </body>
</html>`,
  '/perm-a': `<!doctype html>
<html lang="en"><head><title>Permission A</title></head><body><h1>Permission A</h1><button id="act-a">Action A</button><p id="result-a">Ready</p><script>document.getElementById('act-a').addEventListener('click', () => { document.getElementById('act-a').textContent = 'Action A completed'; document.getElementById('result-a').textContent = 'Done'; });</script></body></html>`,
  '/perm-b': `<!doctype html>
<html lang="en"><head><title>Permission B</title></head><body><h1>Permission B</h1><p>Session B private tab.</p></body></html>`,
  '/regex': `<!doctype html>
<html lang="en"><head><title>Regex timeout</title></head><body><h1>Regex timeout</h1><p>${'a'.repeat(350)}!</p></body></html>`,
  '/about': `<!doctype html>
<html lang="en">
  <head><meta charset="UTF-8" /><title>About</title></head>
  <body>
    <h1>About</h1>
    <p>A page to open and read next to the main one.</p>
    <a href="/">Back home</a>
  </body>
</html>`,
};

let browserContext;
let mcpClient;
let mcpTransport;
let mcpClientB;
let mcpTransportB;
let pageServer;
let pageServerB;
let autoPromptSessionId;
let permissionServiceWorker;
let panelPage;

try {
  await stat(join(extensionDir, 'manifest.json'));
  await mkdir(profileDir, { recursive: true });

  const siteHandler = (request, response) => {
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    const body = SITE[path];
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

  await execFileAsync(
    process.execPath,
    [cliPath, 'native-host', 'install', '--browser', 'chromium'],
    { env: childEnv },
  );

  browserContext = await chromium.launchPersistentContext(profileDir, {
    channel: 'chromium',
    headless: true,
    // No viewport emulation: the window is wider than 1280, so a screenshot has to be scaled down.
    viewport: null,
    env: childEnv,
    args: [
      '--window-size=1600,1000',
      `--disable-extensions-except=${extensionDir}`,
      `--load-extension=${extensionDir}`,
    ],
  });

  const page = browserContext.pages()[0] ?? (await browserContext.newPage());
  await page.goto(`http://127.0.0.1:${address.port}`);
  await page.getByRole('heading', { name: 'T3-Tab E2E' }).waitFor();
  const siteUrl = `http://127.0.0.1:${address.port}`;
  const otherSiteUrl = `http://127.0.0.1:${addressB.port}`;

  const isExtensionWorker = (worker) => worker.url().startsWith('chrome-extension://');
  let serviceWorker = browserContext.serviceWorkers().find(isExtensionWorker);
  if (serviceWorker === undefined) {
    serviceWorker = await browserContext.waitForEvent('serviceworker', {
      predicate: isExtensionWorker,
      timeout: 15_000,
    });
  }

  permissionServiceWorker = serviceWorker;
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
  mcpClient = new Client({ name: 't3-tab-e2e-a', version: '1.0.0' });
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

  mcpTransportB = new StdioClientTransport({
    command: process.execPath,
    args: [cliPath, 'mcp'],
    env: childEnv,
    stderr: 'pipe',
  });
  mcpTransportB.stderr?.on('data', (chunk) => process.stderr.write(chunk));
  mcpClientB = new Client({ name: 't3-tab-e2e-b', version: '1.0.0' });
  await mcpClientB.connect(mcpTransportB);

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
  });
  autoPromptSessionId = permission.sessionA.id;
  await page.goto(siteUrl);
  await page.getByRole('heading', { name: 'T3-Tab E2E' }).waitFor();
  await page.bringToFront();
  await panelRequest(serviceWorker, { type: 'panel.shareTab', sessionId: permission.sessionA.id, tabId: permission.ownerTabId });

  console.log('Existing tool checks: site setting remains ask; the harness auto-answers each prompt with Allow once');
  await checkBrowserTools({ mcpClient, page, siteUrl });
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
  if (pageServer !== undefined) await closeServer(pageServer);
  if (pageServerB !== undefined) await closeServer(pageServerB);
  await stopDaemon();
  await rm(tempHome, { recursive: true, force: true });
}

async function checkPermissions({ mcpClient, mcpClientB, page, serviceWorker, panelPage, siteUrl, otherSiteUrl }) {
  const sessions = await waitForSessions(serviceWorker, 2);
  const sessionA = sessions.find((session) => session.name.startsWith('t3-tab-e2e-a ·'));
  const sessionB = sessions.find((session) => session.name.startsWith('t3-tab-e2e-b ·'));
  assert(sessionA && sessionB, `Both MCP sessions are not listed:\n${JSON.stringify(sessions, null, 2)}`);
  assert(sessionA.name.endsWith(sessionA.id.slice(0, 8)), `Session A name lacks its short id: ${sessionA.name}`);
  console.log('Panel UI: headless harness uses the side panel handler directly; sender validation is unit-tested.');
  console.log(`Permission sessions: ${sessionA.name}; ${sessionB.name}`);

  await setSite(serviceWorker, siteUrl, 'ask');
  await setSite(serviceWorker, otherSiteUrl, 'ask');

  const openA = rawCall(mcpClient, 'tabs', { action: 'open', url: `${siteUrl}/perm-a` });
  const openPromptA = await waitForPrompt(serviceWorker, (prompt) => prompt.session.id === sessionA.id && prompt.tool === 'open');
  assertPromptTab(openPromptA, 'Permission A');
  await assertPromptMetadata(serviceWorker, openPromptA);
  await assertPromptUi(panelPage, serviceWorker, openPromptA);
  const badgeWhilePending = await serviceWorker.evaluate(() => chrome.action.getBadgeText({}));
  assert(badgeWhilePending === '1', `The action badge does not show the pending prompt: ${badgeWhilePending}`);
  console.log(`Permission badge while waiting: ${badgeWhilePending}`);
  await decidePrompt(serviceWorker, openPromptA.id, 'allow-once');
  const openedA = await openA;
  assert(openedA.isError !== true, `Session A could not open its tab: ${text(openedA)}`);
  const tabA = Number(/^Opened tab (\d+)/.exec(text(openedA))?.[1]);
  assert(Number.isInteger(tabA), `Session A open reply has no tab id: ${text(openedA)}`);
  assert(openPromptA.tab.id === tabA, `The open prompt named tab ${openPromptA.tab.id}, opened ${tabA}`);
  const badgeAfterDecision = await serviceWorker.evaluate(() => chrome.action.getBadgeText({}));
  assert(badgeAfterDecision === '', `The action badge was not cleared: ${badgeAfterDecision}`);
  console.log(`Open approval named tab ${openPromptA.tab.id} "${openPromptA.tab.title}" at ${openPromptA.origin}`);

  const openB = rawCall(mcpClientB, 'tabs', { action: 'open', url: `${otherSiteUrl}/perm-b` });
  const openPromptB = await waitForPrompt(serviceWorker, (prompt) => prompt.session.id === sessionB.id && prompt.tool === 'open');
  assertPromptTab(openPromptB, 'Permission B');
  await decidePrompt(serviceWorker, openPromptB.id, 'allow-once');
  const openedB = await openB;
  assert(openedB.isError !== true, `Session B could not open its tab: ${text(openedB)}`);
  const tabB = Number(/^Opened tab (\d+)/.exec(text(openedB))?.[1]);
  assert(Number.isInteger(tabB), `Session B open reply has no tab id: ${text(openedB)}`);

  const groupA = await tabGroup(serviceWorker, tabA);
  const groupB = await tabGroup(serviceWorker, tabB);
  assert(groupA.groupId >= 0 && groupB.groupId >= 0, `Opened tabs are not grouped: A ${JSON.stringify(groupA)}, B ${JSON.stringify(groupB)}`);
  assert(groupA.groupId !== groupB.groupId, `Both sessions use group ${groupA.groupId}`);
  assert(groupA.title === sessionA.name && groupB.title === sessionB.name, `Group titles do not name their sessions: ${JSON.stringify({ groupA, groupB })}`);
  console.log(`Tab groups: A ${groupA.groupId} "${groupA.title}", B ${groupB.groupId} "${groupB.title}"`);

  const ownerTabs = await serviceWorker.evaluate(async () => (await chrome.tabs.query({})).map((tab) => ({ id: tab.id, url: tab.url, title: tab.title })));
  const ownerTab = ownerTabs.find((tab) => tab.url === `${siteUrl}/`);
  assert(ownerTab?.id !== undefined, `The owner's ungrouped tab is missing: ${JSON.stringify(ownerTabs)}`);

  const listA = await rawCall(mcpClient, 'tabs', {});
  assert(!listsTab(listA, tabB), `Session A can list session B's tab:\n${text(listA)}`);
  assert(!listsTab(listA, ownerTab.id), `Session A can list the unshared owner tab:\n${text(listA)}`);

  const crossSessionCalls = [
    ['read B', rawCall(mcpClient, 'read', { tab: tabB })],
    ['act B', rawCall(mcpClient, 'act', { tab: tabB, steps: [{ scroll: { dy: 1 } }] })],
    ['run_js B', rawCall(mcpClient, 'run_js', { tab: tabB, expression: '1' })],
    ['read owner', rawCall(mcpClient, 'read', { tab: ownerTab.id })],
    ['act owner', rawCall(mcpClient, 'act', { tab: ownerTab.id, steps: [{ scroll: { dy: 1 } }] })],
    ['run_js owner', rawCall(mcpClient, 'run_js', { tab: ownerTab.id, expression: '1' })],
  ];
  for (const [label, pending] of crossSessionCalls) {
    const refused = await pending;
    assert(refused.isError === true && /not available to this session/.test(text(refused)), `${label} was not refused: ${text(refused)}`);
  }
  const refusedAFromB = await rawCall(mcpClientB, 'read', { tab: tabA });
  assert(refusedAFromB.isError === true && /not available to this session/.test(text(refusedAFromB)), `Session B was not refused A's tab: ${text(refusedAFromB)}`);
  console.log("Membership refusals: A cannot use B's tab or the unshared owner tab; B cannot use A's tab");

  await panelRequest(serviceWorker, { type: 'panel.shareTab', sessionId: sessionA.id, tabId: ownerTab.id });
  const sharedRead = await rawCall(mcpClient, 'read', { tab: ownerTab.id });
  assert(sharedRead.isError !== true && text(sharedRead).includes('# T3-Tab E2E'), `Session A cannot read the shared owner tab: ${text(sharedRead)}`);
  const sharedList = await rawCall(mcpClient, 'tabs', {});
  assert(listsTab(sharedList, ownerTab.id), `The shared owner tab is not listed:\n${text(sharedList)}`);

  await page.goto(otherSiteUrl);
  await page.getByRole('heading', { name: 'T3-Tab E2E' }).waitFor();
  await page.bringToFront();
  const movedShareRead = rawCall(mcpClient, 'read', { tab: ownerTab.id });
  const movedSharePrompt = await waitForPrompt(serviceWorker, (prompt) => prompt.session.id === sessionA.id && prompt.tool === 'read' && prompt.tab.id === ownerTab.id);
  assert(movedSharePrompt.origin === otherSiteUrl, `The shared tab's new origin was not prompted: ${movedSharePrompt.origin}`);
  await decidePrompt(serviceWorker, movedSharePrompt.id, 'decline');
  const movedShareResult = await movedShareRead;
  assert(movedShareResult.isError === true && /Permission declined/.test(text(movedShareResult)), `A share covered a different origin: ${text(movedShareResult)}`);
  console.log(`Share no longer covered tab ${ownerTab.id} after it moved to ${otherSiteUrl}`);
  await page.goto(siteUrl);
  await page.getByRole('heading', { name: 'T3-Tab E2E' }).waitFor();
  await page.bringToFront();

  await panelRequest(serviceWorker, { type: 'panel.unshareTab', sessionId: sessionA.id, tabId: ownerTab.id });
  const unsharedRead = await rawCall(mcpClient, 'read', { tab: ownerTab.id });
  assert(unsharedRead.isError === true && /not available to this session/.test(text(unsharedRead)), `Session A can read the unshared owner tab: ${text(unsharedRead)}`);
  console.log(`Share covers the origin shown when shared: tab ${ownerTab.id} readable at ${siteUrl}, then refused after unshare`);

  const pageA = await rawCall(mcpClient, 'read', { tab: tabA, full: true });
  const actionRef = refFor(text(pageA), 'button "Action A"');
  assert(actionRef, `Session A's action page has no button ref:\n${text(pageA)}`);

  const firstAct = rawCall(mcpClient, 'act', { tab: tabA, steps: [{ click: { ref: actionRef } }] });
  const actPrompt = await waitForPrompt(serviceWorker, (prompt) => prompt.session.id === sessionA.id && prompt.tool === 'act');
  assertPromptTab(actPrompt, 'Permission A');
  await decidePrompt(serviceWorker, actPrompt.id, 'allow-once');
  const allowedAct = await firstAct;
  assert(allowedAct.isError !== true && text(allowedAct).includes('Action A completed'), `Allow once did not run the act: ${text(allowedAct)}`);
  console.log(`Ask origin, Allow once: act succeeded on tab ${actPrompt.tab.id} "${actPrompt.tab.title}"`);

  const secondAct = rawCall(mcpClient, 'act', { tab: tabA, steps: [{ click: { ref: actionRef } }] });
  const declinePrompt = await waitForPrompt(serviceWorker, (prompt) => prompt.session.id === sessionA.id && prompt.tool === 'act');
  await decidePrompt(serviceWorker, declinePrompt.id, 'decline');
  const declinedAct = await secondAct;
  assert(declinedAct.isError === true && /Permission declined/.test(text(declinedAct)), `Decline did not refuse the act: ${text(declinedAct)}`);
  console.log('Ask origin, Decline: act refused');

  const alwaysAct = rawCall(mcpClient, 'act', { tab: tabA, steps: [{ click: { ref: actionRef } }] });
  const alwaysPrompt = await waitForPrompt(serviceWorker, (prompt) => prompt.session.id === sessionA.id && prompt.tool === 'act');
  await decidePrompt(serviceWorker, alwaysPrompt.id, 'always-allow');
  const alwaysResult = await alwaysAct;
  assert(alwaysResult.isError !== true, `Always allow did not run the first act: ${text(alwaysResult)}`);
  const noPromptAct = await withDeadline(
    rawCall(mcpClient, 'act', { tab: tabA, steps: [{ click: { ref: actionRef } }] }),
    2_000,
    'second act after Always allow',
  );
  assert(noPromptAct.isError !== true, `The second act after Always allow failed: ${text(noPromptAct)}`);
  assert((await pendingPrompts(serviceWorker)).length === 0, 'Always allow left a prompt waiting');
  await setSite(serviceWorker, siteUrl, 'ask');
  console.log('Always allow: the second act ran without a prompt');

  await serviceWorker.evaluate(() => chrome.storage.local.set({ permissionTimeoutMs: 1_200 }));
  const timeoutStarted = Date.now();
  const timedOutAct = await rawCall(mcpClient, 'act', { tab: tabA, steps: [{ click: { ref: actionRef } }] });
  const timeoutElapsed = Date.now() - timeoutStarted;
  assert(timedOutAct.isError === true && /timed out and was declined/.test(text(timedOutAct)), `The prompt timeout did not decline: ${text(timedOutAct)}`);
  assert(timeoutElapsed >= 900 && timeoutElapsed < 4_000, `The configured timeout took ${timeoutElapsed} ms`);
  await serviceWorker.evaluate(() => chrome.storage.local.remove('permissionTimeoutMs'));
  console.log(`Prompt timeout: declined after ${timeoutElapsed} ms`);

  await panelRequest(serviceWorker, { type: 'panel.shareTab', sessionId: sessionA.id, tabId: ownerTab.id });
  const unsharedWhileWaiting = rawCall(mcpClient, 'act', { tab: ownerTab.id, steps: [{ scroll: { dy: 1 } }] });
  const unsharePrompt = await waitForPrompt(serviceWorker, (prompt) => prompt.session.id === sessionA.id && prompt.tool === 'act');
  assertPromptTab(unsharePrompt, 'T3-Tab E2E');
  await panelRequest(serviceWorker, { type: 'panel.unshareTab', sessionId: sessionA.id, tabId: ownerTab.id });
  await decidePrompt(serviceWorker, unsharePrompt.id, 'allow-once');
  const unsharedAct = await unsharedWhileWaiting;
  assert(unsharedAct.isError === true && /not available to this session/.test(text(unsharedAct)), `Allow after unshare still acted: ${text(unsharedAct)}`);
  console.log(`Unshared while waiting: Allow once still refused tab ${ownerTab.id}`);

  const runJsOnX = rawCall(mcpClient, 'run_js', { tab: tabA, expression: 'document.title' });
  const runJsPrompt = await waitForPrompt(serviceWorker, (prompt) => prompt.session.id === sessionA.id && prompt.tool === 'run_js');
  await decidePrompt(serviceWorker, runJsPrompt.id, 'allow-once');
  const runJsResult = await runJsOnX;
  assert(runJsResult.isError !== true && text(runJsResult) === '"Permission A"', `Approved run_js failed: ${text(runJsResult)}`);
  console.log(`Approved run_js on ${siteUrl}: ${text(runJsResult)}`);

  const navigate = rawCall(mcpClient, 'run_js', {
    tab: tabA,
    expression: `const target = ${JSON.stringify(`${otherSiteUrl}/perm-b`)}; setTimeout(() => { location.href = target; }, 0); return 'navigating';`,
  });
  const navigationPrompt = await waitForPrompt(serviceWorker, (prompt) => prompt.session.id === sessionA.id && prompt.tool === 'run_js');
  await decidePrompt(serviceWorker, navigationPrompt.id, 'allow-once');
  const navigateResult = await navigate;
  assert(navigateResult.isError !== true, `Navigation run_js failed before moving: ${text(navigateResult)}`);
  await waitForTabUrl(serviceWorker, tabA, `${otherSiteUrl}/perm-b`);
  console.log(`Tab ${tabA} navigated from ${siteUrl} to ${otherSiteUrl}`);

  const pendingRead = rawCall(mcpClient, 'read', { tab: tabA });
  const crossOriginPrompt = await waitForPrompt(serviceWorker, (prompt) => prompt.session.id === sessionA.id && prompt.tool === 'read');
  assertPromptTab(crossOriginPrompt, 'Permission B');
  assert(crossOriginPrompt.origin === otherSiteUrl, `Read prompt used origin ${crossOriginPrompt.origin}`);
  await decidePrompt(serviceWorker, crossOriginPrompt.id, 'decline');
  const crossOriginRead = await pendingRead;
  assert(crossOriginRead.isError === true && /Permission declined/.test(text(crossOriginRead)), `Cross-origin read was answered without approval: ${text(crossOriginRead)}`);
  console.log(`Cross-origin read on tab ${crossOriginPrompt.tab.id} "${crossOriginPrompt.tab.title}" prompted (kind ${crossOriginPrompt.tool}) at ${otherSiteUrl} and was declined`);

  const screenshotOnY = rawCall(mcpClient, 'screenshot', { tab: tabA, maxEdge: 320 });
  const screenshotPrompt = await waitForPrompt(serviceWorker, (prompt) => prompt.session.id === sessionA.id && prompt.tool === 'read');
  await decidePrompt(serviceWorker, screenshotPrompt.id, 'allow-once');
  const screenshotResult = await screenshotOnY;
  assert(screenshotResult.isError !== true && screenshotResult.content.some((item) => item.type === 'image'), `Screenshot did not get read approval: ${text(screenshotResult)}`);
  console.log('Screenshot used a read prompt, then returned an image after Allow once');

  const beforePopup = new Set(await serviceWorker.evaluate(async () => (await chrome.tabs.query({})).map((tab) => tab.id)));
  const popupCall = rawCall(mcpClient, 'run_js', {
    tab: tabA,
    expression: `const opened = window.open(${JSON.stringify(`${siteUrl}/perm-a`)}, '_blank'); return 'opened';`,
  });
  const popupPrompt = await waitForPrompt(serviceWorker, (prompt) => prompt.session.id === sessionA.id && prompt.tool === 'run_js');
  await decidePrompt(serviceWorker, popupPrompt.id, 'allow-once');
  const popupResult = await popupCall;
  assert(popupResult.isError !== true, `window.open run_js failed: ${text(popupResult)}`);
  const popupTab = await waitForNewTab(serviceWorker, beforePopup, `${siteUrl}/perm-a`);
  const popupGroup = await tabGroup(serviceWorker, popupTab.id);
  assert(popupGroup.groupId === groupA.groupId, `window.open tab ${popupTab.id} is in group ${popupGroup.groupId}, expected ${groupA.groupId}`);
  const popupRead = rawCall(mcpClient, 'read', { tab: popupTab.id });
  const popupReadPrompt = await waitForPrompt(serviceWorker, (prompt) => prompt.session.id === sessionA.id && prompt.tool === 'read' && prompt.tab.id === popupTab.id);
  await decidePrompt(serviceWorker, popupReadPrompt.id, 'decline');
  const popupReadResult = await popupRead;
  assert(popupReadResult.isError === true && /Permission declined/.test(text(popupReadResult)), `window.open tab was readable without approval: ${text(popupReadResult)}`);
  console.log(`window.open created grouped tab ${popupTab.id} "${popupTab.title}"; read prompt (kind ${popupReadPrompt.tool}) was declined`);

  const restricted = await browserContext.newPage();
  await restricted.goto('chrome://version');
  const restrictedId = await serviceWorker.evaluate(async () => (await chrome.tabs.query({})).find((tab) => tab.url?.startsWith('chrome://version'))?.id);
  assert(Number.isInteger(restrictedId), 'The harness could not find its chrome://version tab');
  await panelRequest(serviceWorker, { type: 'panel.shareTab', sessionId: sessionA.id, tabId: restrictedId });
  const restrictedRead = await rawCall(mcpClient, 'read', { tab: restrictedId });
  assert(restrictedRead.isError === true && /T3-Tab cannot access this page/.test(text(restrictedRead)), `chrome://version was not refused by T3-Tab policy: ${text(restrictedRead)}`);
  console.log(`Restricted page refused by T3-Tab policy: ${text(restrictedRead)}`);
  await restricted.close();


  await page.goto(`${siteUrl}/regex`);
  await page.getByRole('heading', { name: 'Regex timeout' }).waitFor();
  await page.bringToFront();
  await panelRequest(serviceWorker, { type: 'panel.shareTab', sessionId: sessionA.id, tabId: ownerTab.id });
  const started = Date.now();
  const heavy = await rawCall(mcpClient, 'read', { tab: ownerTab.id, find: '(a+)+$', regex: true });
  const elapsed = Date.now() - started;
  assert(heavy.isError === true && /Find regex timed out/.test(text(heavy)), `Regex-heavy find did not time out: ${text(heavy)}`);
  assert(elapsed < 3_000, `Regex-heavy find took ${elapsed} ms`);
  console.log(`Regex-heavy find declined promptly: ${elapsed} ms`);

  assert((await pendingPrompts(serviceWorker)).length === 0, 'Permission checks left a prompt waiting');
  console.log('Permissions: all checks passed');
  return { sessionA, sessionB, tabA, tabB, ownerTabId: ownerTab.id };
}

async function assertPromptMetadata(serviceWorker, prompt) {
  const pending = await pendingPrompts(serviceWorker);
  assert(pending[0]?.id === prompt.id, 'The newest prompt is not first in arrival order');
  assertPromptTab(prompt, 'Permission A');
}

async function assertPromptUi(panelPage, serviceWorker, prompt) {
  const state = await panelRequest(serviceWorker, { type: 'panel.state' });
  await renderPanelState(panelPage, state);
  const description = `tab ${prompt.tab.id} "${prompt.tab.title}"`;
  await panelPage.getByText(new RegExp(description.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).waitFor();
  const allow = panelPage.getByRole('button', { name: 'Allow once' });
  await allow.waitFor();
  assert(await allow.isDisabled(), 'New prompt buttons were enabled immediately');
  const handle = await allow.elementHandle();
  assert(handle !== null, 'Could not hold the prompt button');
  await handle.evaluate((element) => {
    element.dataset.stabilityCheck = 'kept';
  });
  await sleep(650);
  assert(!(await allow.isDisabled()), 'Prompt buttons did not enable after the short delay');
  await renderPanelState(panelPage, state);
  assert(
    await handle.evaluate((element) => element.isConnected && element.dataset.stabilityCheck === 'kept'),
    'A rendered prompt item was rebuilt instead of kept',
  );
  console.log(`Prompt UI: tab ${prompt.tab.id} "${prompt.tab.title}", buttons delayed, item kept across rerender`);
}

async function renderPanelState(panelPage, state) {
  await panelPage.evaluate((next) => {
    const render = globalThis.__t3tabRenderPanelState;
    if (typeof render !== 'function') throw new Error('Panel renderer is unavailable');
    render(next);
  }, state);
}

function assertPromptTab(prompt, expectedTitle) {
  assert(Number.isInteger(prompt.tab?.id) && prompt.tab.id >= 0, `Prompt has no tab id: ${JSON.stringify(prompt)}`);
  assert(typeof prompt.tab.title === 'string' && prompt.tab.title.length > 0, `Prompt has no tab title: ${JSON.stringify(prompt)}`);
  assert(prompt.tab.title.includes(expectedTitle), `Prompt named "${prompt.tab.title}", expected "${expectedTitle}"`);
}

async function waitForSessions(serviceWorker, minimum) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const state = await panelRequest(serviceWorker, { type: 'panel.state' });
    if (state.sessions?.length >= minimum) return state.sessions;
    await sleep(100);
  }
  throw new Error(`The panel did not list ${minimum} MCP sessions`);
}

async function waitForPrompt(serviceWorker, match) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const prompt = (await pendingPrompts(serviceWorker)).find(match);
    if (prompt !== undefined) return prompt;
    await sleep(100);
  }
  throw new Error('The side panel did not show the expected permission request');
}

async function pendingPrompts(serviceWorker) {
  const state = await panelRequest(serviceWorker, { type: 'panel.state' });
  return state.pending ?? [];
}

async function decidePrompt(serviceWorker, promptId, decision) {
  await panelRequest(serviceWorker, { type: 'panel.decide', promptId, decision });
}

async function setSite(serviceWorker, origin, setting) {
  await panelRequest(serviceWorker, { type: 'panel.setSite', origin, setting });
}

async function panelRequest(serviceWorker, request) {
  const response = await serviceWorker.evaluate(async (message) => {
    const handle = globalThis.__t3tabHandlePanelRequest;
    if (typeof handle !== 'function') throw new Error('Panel handler is unavailable');
    return await handle(message);
  }, request);
  if (response === undefined) throw new Error(`The extension did not answer ${request.type}`);
  if (response?.ok === false) throw new Error(`${request.type}: ${response.error}`);
  return response;
}

async function tabGroup(serviceWorker, tabId) {
  return await serviceWorker.evaluate(async (id) => {
    const tab = await chrome.tabs.get(id);
    if (tab.groupId < 0) return { groupId: tab.groupId, title: '' };
    const group = await chrome.tabGroups.get(tab.groupId);
    return { groupId: tab.groupId, title: group.title ?? '' };
  }, tabId);
}

async function waitForTabUrl(serviceWorker, tabId, expectedUrl) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const tab = await serviceWorker.evaluate(async (id) => await chrome.tabs.get(id), tabId);
    if (tab.url === expectedUrl) return tab;
    await sleep(100);
  }
  throw new Error(`Tab ${tabId} did not navigate to ${expectedUrl}`);
}

async function waitForNewTab(serviceWorker, before, expectedUrl) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const tabs = await serviceWorker.evaluate(async () => (await chrome.tabs.query({})).map((tab) => ({ id: tab.id, url: tab.url, title: tab.title })));
    const found = tabs.find((tab) => tab.id !== undefined && !before.has(tab.id) && tab.url === expectedUrl);
    if (found !== undefined) return found;
    await sleep(100);
  }
  throw new Error(`No new tab committed to ${expectedUrl}`);
}

async function withDeadline(promise, milliseconds, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} did not finish within ${milliseconds} ms`)), milliseconds);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function checkBrowserTools({ mcpClient, page, siteUrl }) {
  const { tools } = await mcpClient.listTools();
  const names = tools.map((tool) => tool.name).sort();
  assert(JSON.stringify(names) === JSON.stringify(['act', 'read', 'run_js', 'screenshot', 'status', 'tabs']), `Unexpected tools: ${names}`);
  const sizes = tools.map((tool) => `${tool.name} ${JSON.stringify(tool).length}`);
  const definitionChars = JSON.stringify(tools).length;
  console.log(
    `Tool definitions: ${definitionChars} characters, about ${Math.round(definitionChars / 4)} tokens (${sizes.join(', ')})`,
  );

  // tabs: list, open, switch, close.
  const listed = await call(mcpClient, 'tabs', {});
  show('tabs list', listed);
  assert(/^\d+ \[front\] T3-Tab E2E — http:\/\/127\.0\.0\.1:\d+\/?$/m.test(text(listed)), `tabs list does not show the front test tab:\n${text(listed)}`);
  const frontId = Number(/^(\d+) \[front\]/m.exec(text(listed))?.[1]);

  const opened = await call(mcpClient, 'tabs', { action: 'open', url: `${siteUrl}/about` });
  show('tabs open', opened);
  assert(/^Opened tab \d+ \[front\] About — /.test(text(opened)), `tabs open: ${text(opened)}`);
  const aboutId = Number(/^Opened tab (\d+)/.exec(text(opened))?.[1]);
  const refusedOpen = await call(mcpClient, 'tabs', { action: 'open', url: 'chrome://settings' });
  assert(refusedOpen.isError === true && /restricted/.test(text(refusedOpen)), `tabs open chrome://: ${text(refusedOpen)}`);
  const switched = await call(mcpClient, 'tabs', { action: 'switch', tab: frontId });
  show('tabs switch', switched);
  assert(text(switched).startsWith(`Switched to tab ${frontId} [front] T3-Tab E2E`), `tabs switch: ${text(switched)}`);
  const closed = await call(mcpClient, 'tabs', { action: 'close', tab: aboutId });
  show('tabs close', closed);
  assert(text(closed) === `Closed tab ${aboutId}.`, `tabs close: ${text(closed)}`);
  assert(!new RegExp(`^${aboutId}\\b`, 'm').test(text(await call(mcpClient, 'tabs', {}))), 'The closed tab is still listed');
  const missingTab = await call(mcpClient, 'tabs', { action: 'close', tab: aboutId });
  assert(missingTab.isError === true && /No tab with id/.test(text(missingTab)), `closing a closed tab: ${text(missingTab)}`);

  // read: the first read of the page is the full text, with refs.
  const first = await call(mcpClient, 'read', {});
  show('read (first)', first);
  const firstText = text(first);
  for (const expected of [
    '# T3-Tab E2E',
    '## Sign up',
    'link "About"',
    'form "Sign up"',
    'textbox "Name"',
    'textbox "Email"',
    'textbox "Password"',
    'combobox "Country"',
    'radio "Free" [checked]',
    'radio "Pro"',
    'checkbox "I agree to the terms"',
    'textbox "Notes"',
    'button "Create account"',
    'button "Show details" [collapsed]',
  ]) {
    assert(firstText.includes(expected), `First read lacks ${expected}:\n${firstText}`);
  }
  assert(/^\s*e\d+ button "Create account"$/m.test(firstText), 'Interactive elements carry a ref');
  assert(!firstText.includes('Release 1.2 notes'), 'The hidden details are not in the first read');
  const refOf = (label) => /^\s*(e\d+) /.exec(firstText.split('\n').find((line) => line.includes(label)) ?? '')?.[1];
  const formRef = refOf('form "Sign up"');
  assert(formRef !== undefined, 'The form has a ref');

  // The page changes: a click reveals a section. The next read is only the difference.
  await page.getByRole('button', { name: 'Show details' }).click();
  const second = await call(mcpClient, 'read', {});
  show('read (after the page changed)', second);
  const secondText = text(second);
  assert(secondText.includes('Changed since the last read:'), `Second read is not a diff:\n${secondText}`);
  assert(secondText.includes('button "Hide details" [expanded]'), 'The diff shows the button now says Hide details');
  assert(secondText.includes('link "Release notes"'), 'The diff shows the new link');
  assert(!secondText.includes('textbox "Name"'), 'The diff leaves out what did not change');
  assert(secondText.length < firstText.length / 2, `The diff (${secondText.length}) is not much shorter than the page (${firstText.length})`);
  const unchanged = await call(mcpClient, 'read', {});
  assert(text(unchanged).endsWith('No changes since the last read.'), `A third read: ${text(unchanged)}`);
  const whole = await call(mcpClient, 'read', { full: true });
  assert(text(whole).includes('textbox "Name"') && text(whole).includes('link "Release notes"'), 'full: true returns the whole page');

  // Typing is a change too, and a password must not come back in clear.
  await page.getByLabel('Name').fill('Ada Lovelace');
  await page.getByLabel('Password').fill('hunter2-secret');
  const typed = await call(mcpClient, 'read', {});
  show('read (after typing)', typed);
  assert(text(typed).includes('value="Ada Lovelace"'), `The typed name is shown:\n${text(typed)}`);
  assert(!text(typed).includes('hunter2'), `The password came back in clear:\n${text(typed)}`);
  assert(!text(typed).includes('•'), `The password length is visible as bullets:\n${text(typed)}`);
  assert(firstText.includes('textbox "Password" value=<redacted>'), 'The password field is not marked redacted');
  const everything = await call(mcpClient, 'read', { all: true });
  assert(!text(everything).includes('hunter2'), 'The password came back in clear in all mode');
  assert(text(everything).includes('textbox "Password" value=<redacted>'), 'The password is not masked in all mode');
  assert(text(everything).includes('Release 1.2 notes are here.'), 'all mode includes the page text');

  // find: only the matching lines.
  const found = await call(mcpClient, 'read', { find: 'password' });
  show('read (find "password")', found);
  assert(/textbox "Password"/.test(text(found)), 'find shows the password field');
  assert(!text(found).includes('link "Contact"'), 'find leaves out the rest of the page');
  assert(text(found).length < firstText.length / 3, `find (${text(found).length}) is not much shorter than the page (${firstText.length})`);
  const foundRegex = await call(mcpClient, 'read', { find: 'link "(about|home)"', regex: true });
  assert(text(foundRegex).includes('link "About"') && text(foundRegex).includes('link "Home"') && !text(foundRegex).includes('link "Contact"'), `find with a regex:\n${text(foundRegex)}`);
  const notFound = await call(mcpClient, 'read', { find: 'no such thing' });
  assert(text(notFound).includes('No matches for "no such thing"'), 'find reports no match');

  // A subtree by ref, with a depth.
  const subtree = await call(mcpClient, 'read', { ref: formRef });
  show(`read (ref ${formRef})`, subtree);
  assert(text(subtree).includes('textbox "Email"') && !text(subtree).includes('link "About"'), 'A ref reads only that element');
  const shallow = await call(mcpClient, 'read', { ref: formRef, depth: 0 });
  assert(text(shallow).split('\n').length === 2, `depth 0 shows only the element:\n${text(shallow)}`);

  // Navigation: the refs held for the page are void, and the next read is the whole new page.
  await page.goto(`${siteUrl}/about`);
  await page.getByRole('heading', { name: 'About' }).waitFor();
  const stale = await call(mcpClient, 'read', { ref: formRef });
  assert(stale.isError === true && /Unknown ref/.test(text(stale)), `A ref from before the navigation: ${text(stale)}`);
  const afterNavigation = await call(mcpClient, 'read', {});
  show('read (after navigation)', afterNavigation);
  assert(!text(afterNavigation).includes('Changed since') && text(afterNavigation).includes('# About'), 'A new page is read in full');
  assert(/^\s*e1 /m.test(text(afterNavigation)), 'Refs start again on a new page');
  await page.goto(siteUrl);
  await page.getByRole('heading', { name: 'T3-Tab E2E' }).waitFor();

  // screenshot: a JPEG whose long edge is at most 1280, in the viewport's proportions.
  const viewportBefore = await settledViewport(page);
  assert(viewportBefore[0] > 1280, `The test window is not wider than 1280: ${viewportBefore}`);
  const shot = await call(mcpClient, 'screenshot', {});
  const image = shot.content.find((item) => item.type === 'image');
  assert(image?.mimeType === 'image/jpeg', 'The screenshot is a JPEG image');
  const size = jpegSize(Buffer.from(image.data, 'base64'));
  assert(size !== undefined, 'The screenshot decodes as a JPEG');
  console.log(
    `--- screenshot (${replySize(shot)}) ---\n${text(shot)}\nimage/jpeg ${size.width}x${size.height}, ${Buffer.from(image.data, 'base64').length} bytes`,
  );
  assert(Math.max(size.width, size.height) <= 1280, `Screenshot is ${size.width}x${size.height}`);
  assert(size.width >= 1270, `A ${viewportBefore[0]} pixel wide viewport is not scaled to about 1280: ${size.width}x${size.height}`);
  assert(
    Math.abs(size.width / size.height - viewportBefore[0] / viewportBefore[1]) < 0.02,
    `The screenshot ${size.width}x${size.height} does not keep the viewport's proportions ${viewportBefore}`,
  );
  assert(text(shot).includes(`viewport ${viewportBefore[0]}x${viewportBefore[1]}`), `The reply names the viewport: ${text(shot)}`);
  const small = await call(mcpClient, 'screenshot', { maxEdge: 640 });
  const smallImage = small.content.find((item) => item.type === 'image');
  const smallSize = jpegSize(Buffer.from(smallImage.data, 'base64'));
  console.log(`--- screenshot maxEdge 640 (${replySize(small)}) ---\n${text(small)}\nimage/jpeg ${smallSize.width}x${smallSize.height}`);
  assert(Math.max(smallSize.width, smallSize.height) <= 640 && smallSize.width >= 630, `maxEdge 640 gave ${smallSize.width}x${smallSize.height}`);
  console.log('Browser tools: all checks passed');
}

async function checkActionTools({ mcpClient, page }) {
  await page.getByRole('heading', { name: 'T3-Tab E2E' }).waitFor();
  await page.getByLabel('Name').fill('Old Name');
  const before = await call(mcpClient, 'read', { full: true });
  show('read before act', before);
  const beforeText = text(before);
  assert(beforeText.includes('textbox "Name" value="Old Name" [required]'), `The prefilled name is missing:\n${beforeText}`);
  const nameRef = refFor(beforeText, 'textbox "Name"');
  const emailRef = refFor(beforeText, 'textbox "Email"');
  const submitRef = refFor(beforeText, 'button "Create account"');
  assert(nameRef && emailRef && submitRef, `The form refs are missing:\n${beforeText}`);

  const acted = await call(mcpClient, 'act', {
    steps: [
      { fill: { ref: nameRef, value: 'Ada Lovelace' } },
      { fill: { ref: emailRef, value: 'ada@example.com' } },
      { click: { ref: submitRef } },
    ],
  });
  show('act (fill, fill, click)', acted);
  assert(acted.isError !== true, `act failed: ${text(acted)}`);
  assert(/Changed since the last read:/.test(text(acted)), `act did not return a diff:\n${text(acted)}`);
  assert(text(acted).includes('Welcome Ada Lovelace (ada@example.com)'), `act did not show the form result:\n${text(acted)}`);

  const title = await call(mcpClient, 'run_js', { expression: 'document.title' });
  show('run_js document.title', title);
  assert(title.isError !== true && text(title) === '"T3-Tab E2E"', `run_js returned: ${text(title)}`);
  const bodyTitle = await call(mcpClient, 'run_js', { expression: 'return document.title;' });
  show('run_js async body', bodyTitle);
  assert(bodyTitle.isError !== true && text(bodyTitle) === '"T3-Tab E2E"', `run_js body returned: ${text(bodyTitle)}`);

  const fresh = await call(mcpClient, 'read', { full: true });
  const freshText = text(fresh);
  const aboutRef = refFor(freshText, 'link "About"');
  const staleRef = refFor(freshText, 'textbox "Name"');
  assert(aboutRef && staleRef, `Navigation refs are missing:\n${freshText}`);
  const stale = await call(mcpClient, 'act', {
    steps: [{ click: { ref: aboutRef } }, { click: { ref: staleRef } }],
  });
  show('act (click navigation, then stale ref)', stale);
  assert(stale.isError === true, `A ref from before navigation was accepted: ${text(stale)}`);
  assert(
    new RegExp(`${staleRef} is no longer on the page; read again`).test(text(stale)),
    `The stale-ref error is unclear: ${text(stale)}`,
  );
  assert(text(stale).includes('# About'), `The failed act has no page diff after navigation: ${text(stale)}`);
  console.log('Act, stale ref and run_js: all checks passed');
}

async function checkKeepalive(mcpClient) {
  console.log('Keepalive: waiting 36 seconds past the service worker idle timeout...');
  await new Promise((resolve) => setTimeout(resolve, 36_000));
  const result = await call(mcpClient, 'status', {});
  show('status after 36s idle', result);
  assert(/^Browsers: 1$/m.test(text(result)), `The extension did not stay connected: ${text(result)}`);
  assert(parseStatusTabCount(text(result)) >= 1, `The kept-alive browser reported no tabs: ${text(result)}`);
  console.log('Keepalive after 36s: passed');
}

function listsTab(result, tabId) {
  return text(result)
    .split('\n')
    .some((line) => line.startsWith(`${tabId} `));
}

function refFor(readText, label) {
  return /^\s*(e\d+) /.exec(readText.split('\n').find((line) => line.includes(label)) ?? '')?.[1];
}

/** The page's viewport once it stops changing: attaching the debugger makes the browser show a banner, which resizes it. */
async function settledViewport(page) {
  let previous = '';
  let steady = 0;
  for (let attempt = 0; attempt < 40 && steady < 4; attempt += 1) {
    const size = await page.evaluate(() => [innerWidth, innerHeight]);
    steady = JSON.stringify(size) === previous ? steady + 1 : 0;
    previous = JSON.stringify(size);
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  assert(steady >= 4, `The viewport kept changing: ${previous}`);
  return JSON.parse(previous);
}

async function rawCall(client, name, args) {
  return await client.callTool({ name, arguments: args });
}

async function call(client, name, args) {
  if (autoPromptSessionId === undefined) return await rawCall(client, name, args);
  const result = rawCall(client, name, args);
  let settled = false;
  void result.then(
    () => { settled = true; },
    () => { settled = true; },
  );
  const decided = new Set();
  while (!settled) {
    const prompts = await pendingPrompts(permissionServiceWorker).catch(() => []);
    for (const prompt of prompts) {
      if (prompt.session.id !== autoPromptSessionId || decided.has(prompt.id)) continue;
      decided.add(prompt.id);
      await decidePrompt(permissionServiceWorker, prompt.id, 'allow-once');
    }
    if (!settled) await sleep(75);
  }
  return await result;
}

function text(result) {
  return result.content
    .filter((item) => item.type === 'text')
    .map((item) => item.text)
    .join('\n');
}

function replySize(result) {
  const characters = result.content.reduce((total, item) => total + (item.type === 'text' ? item.text.length : item.data.length), 0);
  return `${characters} characters${result.isError === true ? ', error' : ''}`;
}

function show(label, result) {
  console.log(`--- ${label} (${replySize(result)}) ---\n${text(result)}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

/** Pixel size of a JPEG, from its start-of-frame marker. */
function jpegSize(bytes) {
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

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
}

async function closeServer(server) {
  if (server.listening !== true) return;
  await new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
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
