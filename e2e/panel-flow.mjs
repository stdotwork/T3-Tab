// Walks the side panel the way the owner would, against a real throwaway T3 Code and then with T3 absent, and saves a
// screenshot of each screen at sidebar width in light and dark. Needs a real agent login, so it is not part of
// `pnpm e2e`. Run it after `pnpm build`:
//
//   CLAUDE_CODE_OAUTH_TOKEN=... T3_TAB_FLOW_SHOTS=/some/folder node e2e/panel-flow.mjs [t3|direct|all]
//
// Everything runs under a temporary HOME; the browser is headless; the T3 server is started and stopped here.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';

import { createHome, extensionWorker, installNativeHost, launchBrowser, listen, panelRequest, requireBuild, sleep } from './harness.mjs';

const shotsDir = process.env.T3_TAB_FLOW_SHOTS;
if (shotsDir === undefined) throw new Error('Set T3_TAB_FLOW_SHOTS to the folder for screenshots');
const which = process.argv[2] ?? 'all';
const MODEL = 'Claude Haiku 5.5';
const results = [];

const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === '' ? '' : `: ${detail}`}`);
};

async function until(what, probe, timeoutMs = 60_000) {
  const start = Date.now();
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${what}`);
    await sleep(200);
  }
}

async function startSite() {
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'text/html');
    response.end(`<!doctype html><title>Flow test page</title><h1>Harbour Lights Bakery</h1><p>Open daily from 7am.</p><button>Order bread</button><a href="/menu">Menu</a>`);
  });
  await listen(server);
  return { server, url: `http://127.0.0.1:${server.address().port}/` };
}

async function startT3(home, projectDir) {
  const portServer = createServer();
  await listen(portServer);
  const { port } = portServer.address();
  await new Promise((resolve) => portServer.close(resolve));
  const child = spawn('t3', ['serve', '--host', '127.0.0.1', '--port', String(port), '--no-browser', projectDir], {
    env: home.childEnv,
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  await until('T3 to answer', async () => (await fetch(`http://127.0.0.1:${port}/`).catch(() => undefined))?.ok === true);
  return { child, port, origin: `http://127.0.0.1:${port}` };
}

async function stopT3(t3) {
  if (t3.child.exitCode !== null) return;
  t3.child.kill('SIGTERM');
  await Promise.race([once(t3.child, 'exit'), sleep(8_000)]);
  if (t3.child.exitCode === null) t3.child.kill('SIGKILL');
}

async function openPanel(context, serviceWorker, extensionId, tabId) {
  const page = await context.newPage();
  await page.setViewportSize({ width: 400, height: 800 });
  // A page in a tab is refused by the worker's sender check, so the harness carries the panel's requests.
  await page.exposeFunction('__t3tabPanelBridge', async (request) => {
    try {
      return await serviceWorker.evaluate(async (message) => await globalThis.__t3tabHandlePanelRequest(message), request);
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
  await page.goto(`chrome-extension://${extensionId}/sidepanel.html?tabId=${tabId}`);
  return page;
}

function shooter(page, prefix) {
  return async (name) => {
    for (const scheme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme: scheme });
      await sleep(120);
      await page.screenshot({ path: join(shotsDir, `${prefix}-${name}-${scheme}.png`) });
    }
    await page.emulateMedia({ colorScheme: 'light' });
  };
}

async function siteTabId(serviceWorker, url) {
  return await serviceWorker.evaluate(async (target) => (await chrome.tabs.query({})).find((tab) => tab.url === target)?.id, url);
}

async function pickModel(panelPage, name) {
  await panelPage.locator('.model-chip').first().click();
  await panelPage.locator('.model-row').filter({ hasText: name }).first().click();
  if (await panelPage.locator('.model-popover').isVisible()) await panelPage.keyboard.press('Escape');
}

async function send(panelPage, text) {
  await panelPage.getByLabel('Message').fill(text);
  await panelPage.getByRole('button', { name: 'Send', exact: true }).click();
}

const finished = (panelPage) => panelPage.locator('.work-head.toggle').last().waitFor({ timeout: 180_000 });

async function runT3Flow() {
  const home = await createHome();
  const projectDir = join(home.tempHome, 'demo-project');
  await mkdir(projectDir, { recursive: true });
  await writeFile(join(projectDir, 'README.md'), '# Demo project\n');
  Object.assign(home.childEnv, { T3CODE_HOME: join(home.tempHome, '.t3'), T3_TAB_T3: (await which3()) });
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN !== undefined) home.childEnv.CLAUDE_CODE_OAUTH_TOKEN = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  await requireBuild(home);
  const site = await startSite();
  const t3 = await startT3(home, projectDir);
  const context = await launchBrowser(home);
  try {
    const { serviceWorker, extensionId } = await extensionWorker(context);
    const tab = await context.newPage();
    await tab.goto(site.url);
    const tabId = await siteTabId(serviceWorker, site.url);
    const panelPage = await openPanel(context, serviceWorker, extensionId, tabId);
    const shot = shooter(panelPage, 't3');
    panelPage.on('pageerror', (error) => check('no page error', false, error.message));

    // 1. First open: the helper is not installed yet.
    await panelPage.getByText('Welcome to T3-Tab').waitFor();
    await panelPage.getByText('t3-tab native-host install').waitFor();
    check('first open shows the setup list with the one command', true);
    await shot('01-setup-no-helper');
    await installNativeHost(home);
    await panelPage.locator('.setup-row').filter({ hasText: 'T3-Tab helper' }).getByText('Ready').waitFor({ timeout: 60_000 });
    check('the helper row turned ready by itself', true);
    await panelPage.locator('.setup-row').filter({ hasText: 'T3 Code' }).getByRole('button', { name: 'Connect' }).waitFor({ timeout: 30_000 });
    await shot('02-setup-helper-ready');

    for (const name of ['Claude Code', 'Codex']) {
      const row = panelPage.locator('.setup-row').filter({ hasText: name });
      const add = row.getByRole('button', { name: 'Add' });
      if (await add.isVisible()) {
        await add.click();
        await row.getByText('Ready').waitFor({ timeout: 30_000 });
      }
      check(`browser tools added to ${name}`, await row.getByText('Ready').isVisible());
    }
    await panelPage.locator('.setup-row').filter({ hasText: 'T3 Code' }).getByRole('button', { name: 'Connect' }).click();
    await panelPage.locator('.setup-row').filter({ hasText: 'T3 Code' }).getByText('Connected').waitFor({ timeout: 30_000 });
    check('one click connected the panel to T3', true);
    await shot('03-setup-all-ready');
    await panelPage.getByRole('button', { name: 'Start', exact: true }).click();

    // 2. Home is a new thread.
    await panelPage.getByText('What should we build?').waitFor();
    await panelPage.reload();
    await panelPage.getByText('What should we build?').waitFor();
    check('setup does not come back after a reload', !(await panelPage.getByText('Welcome to T3-Tab').isVisible()));
    await panelPage.locator('.project-btn').click();
    await panelPage.getByRole('button', { name: 'Add a project' }).click();
    await panelPage.getByPlaceholder('/path/to/folder').fill(projectDir);
    await panelPage.getByRole('button', { name: 'Add', exact: true }).click();
    await panelPage.locator('.project-btn').filter({ hasText: 'demo-project' }).waitFor({ timeout: 15_000 });
    await panelPage.locator('.tab-chip').filter({ hasText: 'Flow test page' }).waitFor();
    await shot('04-home');
    await panelPage.locator('.project-btn').click();
    await shot('05-project-picker');
    await panelPage.keyboard.press('Escape');
    await panelPage.locator('.model-chip').first().click();
    await panelPage.locator('.model-popover').waitFor();
    await shot('06-model-picker');
    await panelPage.keyboard.press('Escape');
    await pickModel(panelPage, MODEL);

    // 3. A real thread in Full access, reading the shared tab with no prompt.
    await send(panelPage, 'Use the t3-tab browser tools to read the shared tab, then tell me in one sentence what business the page is for.');
    await panelPage.locator('.user-bubble').waitFor({ timeout: 30_000 });
    await panelPage.locator('.work-head').first().waitFor({ timeout: 60_000 });
    await shot('07-thread-working');
    await finished(panelPage);
    const reply = await panelPage.locator('.assistant').last().innerText();
    check('T3 thread read the shared tab and replied', /bakery/i.test(reply), reply.slice(0, 120));
    check('the claim line is hidden in the thread', !(await panelPage.locator('.timeline').innerText()).includes('claim'));
    const allowed = await panelRequest(serviceWorker, { type: 'panel.state', tabId });
    check('Full access answered yes for the browser', (allowed.autoAllowed ?? []).length > 0 && allowed.pending.length === 0, `${(allowed.autoAllowed ?? []).length} auto-allowed`);
    await shot('08-thread-finished');
    await panelPage.locator('.work-head.toggle').last().click();
    await shot('09-thread-worklog');
    await panelPage.locator('.work-head.toggle').last().click();

    // 4. A Supervised thread: T3's approval card, a question, and a browser prompt in both places.
    await panelPage.getByRole('button', { name: 'New thread' }).click();
    await panelPage.locator('.runtime-btn').click();
    await panelPage.getByRole('menuitemradio', { name: /Supervised/ }).click();
    await pickModel(panelPage, MODEL);
    await send(panelPage, 'Create a file named notes.txt in this folder containing exactly one line: hello. Then reply with the word done.');
    await panelPage.locator('.approval-card').waitFor({ timeout: 120_000 });
    await shot('10-approval');
    await panelPage.locator('.approval-card').getByRole('button', { name: 'Approve', exact: true }).click();
    await until('notes.txt', async () => (await readFile(join(projectDir, 'notes.txt'), 'utf8').catch(() => '')).includes('hello'), 120_000);
    check('approval answered from the panel reached the agent', true);
    await finished(panelPage);

    await panelPage.getByRole('button', { name: 'New thread' }).click();
    await pickModel(panelPage, MODEL);
    await send(panelPage, 'Before anything else, use your AskUserQuestion tool to ask me one multiple-choice question with two options: bullets or prose. After my answer, reply with just the option I picked.');
    await panelPage.locator('.question-card').waitFor({ timeout: 120_000 });
    await shot('11-question');
    await panelPage.locator('.question-option').filter({ hasText: /prose/i }).click();
    await panelPage.locator('.question-card').getByRole('button', { name: 'Submit' }).click();
    await until('the answer', async () => /prose/i.test(await panelPage.locator('.assistant').last().innerText().catch(() => '')), 120_000);
    check('question answered from the panel reached the agent', true);
    await finished(panelPage);

    await panelPage.getByRole('button', { name: 'New thread' }).click();
    await pickModel(panelPage, MODEL);
    await send(panelPage, 'Use the t3-tab browser tools: call tabs to open http://localhost:' + new URL(site.url).port + '/menu , then read it. Reply with the page title only.');
    await panelPage.locator('.prompt-card').first().waitFor({ timeout: 120_000 });
    check('browser request shows in the sidebar', true);
    await shot('12-permission');
    const inThread = await until('the request in the T3 thread', async () => {
      return await t3Threads(home, projectDir);
    }, 30_000).catch(() => undefined);
    check('browser request also reached the T3 thread as a pending approval', inThread === true);
    await sleep(600);
    await panelPage.locator('.prompt-card').first().locator('.prompt-btn.primary').click();
    await finished(panelPage).catch(() => undefined);
    check('first answer cleared the request', (await panelRequest(serviceWorker, { type: 'panel.state', tabId })).pending.length === 0);

    // 5. The thread list and settings sit behind icons.
    await panelPage.locator('#btn-threads').click();
    await panelPage.locator('.thread-row').first().waitFor();
    check('thread list lists the threads', (await panelPage.locator('.thread-row').count()) >= 4);
    await shot('13-thread-list');
    await panelPage.keyboard.press('Escape');
    await panelPage.locator('#btn-settings').click();
    await panelPage.getByText('Color scheme').waitFor();
    await shot('14-settings-appearance');
    await panelPage.getByRole('button', { name: 'Create theme' }).click();
    await shot('15-theme-create');
    await panelPage.getByRole('button', { name: 'Close', exact: true }).click();
    await panelPage.getByRole('button', { name: 'Add theme' }).click();
    const themeFile = JSON.stringify({ version: 1, name: 'Flow Import', appearance: 'dark', colors: { canvas: '#101820', text: '#f2f7fa', accent: '#ff7a59', messageAction: '#ff7a59', messageActionForeground: '#101820' } });
    await panelPage.locator('.sheet textarea').fill(themeFile);
    await panelPage.locator('.sheet').getByRole('button', { name: 'Add theme' }).click();
    const canvas = await until('the imported theme to apply', async () => {
      const value = await panelPage.evaluate(() => document.documentElement.style.getPropertyValue('--app-theme-canvas'));
      return value.includes('101820') || value === '#101820' ? value : undefined;
    }, 5_000).catch(() => undefined);
    check('a T3 theme file imports and applies', canvas !== undefined, String(canvas));
    await shot('16-theme-imported');
    await panelPage.getByRole('button', { name: /Follow T3 Code/ }).click();
    await panelPage.locator('.settings-tabs').getByRole('button', { name: 'Sites' }).click();
    await shot('17-settings-sites');
    await panelPage.locator('.settings-tabs').getByRole('button', { name: 'Connections' }).click();
    await shot('18-settings-connections');
    await panelPage.getByRole('button', { name: 'Disconnect from T3 Code' }).click();
    await panelPage.locator('.setup-row').filter({ hasText: 'T3 Code' }).getByRole('button', { name: 'Connect' }).waitFor({ timeout: 15_000 });
    check('disconnect ends the panel session', true);
  } finally {
    await context.close().catch(() => undefined);
    await stopT3(t3);
    site.server.close();
    if (process.env.T3_TAB_FLOW_KEEP === undefined) await rm(home.tempHome, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** True when the newest thread in the throwaway T3 is waiting on a request (read with T3's own CLI). */
async function t3Threads(home, projectDir) {
  const child = spawn('t3', ['thread', 'list', '--json', '--project', projectDir], { env: home.childEnv, stdio: ['ignore', 'pipe', 'ignore'] });
  let out = '';
  child.stdout.on('data', (chunk) => (out += chunk));
  await once(child, 'close');
  return /"waiting"|pendingRuntimeRequest"\s*:\s*\{|"pendingApproval"/.test(out);
}

async function which3() {
  const child = spawn('sh', ['-c', 'command -v t3'], { stdio: ['ignore', 'pipe', 'ignore'] });
  let out = '';
  child.stdout.on('data', (chunk) => (out += chunk));
  await once(child, 'close');
  return out.trim();
}

async function runDirectFlow() {
  const home = await createHome();
  Object.assign(home.childEnv, { T3CODE_HOME: join(home.tempHome, '.t3-none'), T3_TAB_T3: join(home.tempHome, 'no-t3-here') });
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN !== undefined) home.childEnv.CLAUDE_CODE_OAUTH_TOKEN = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  await requireBuild(home);
  const site = await startSite();
  await installNativeHost(home);
  const context = await launchBrowser(home);
  try {
    const { serviceWorker, extensionId } = await extensionWorker(context);
    const tab = await context.newPage();
    await tab.goto(site.url);
    const tabId = await siteTabId(serviceWorker, site.url);
    const panelPage = await openPanel(context, serviceWorker, extensionId, tabId);
    const shot = shooter(panelPage, 'direct');
    panelPage.on('pageerror', (error) => check('no page error', false, error.message));

    await panelPage.locator('.setup-row').filter({ hasText: 'T3-Tab helper' }).getByText('Ready').waitFor({ timeout: 60_000 });
    await panelPage.getByText(/Not installed\. Threads use Claude Code or Codex directly/).waitFor({ timeout: 30_000 });
    check('with T3 absent, setup says threads run directly', true);
    await shot('01-setup');
    const claudeRow = panelPage.locator('.setup-row').filter({ hasText: 'Claude Code' });
    const add = claudeRow.getByRole('button', { name: 'Add' });
    if (await add.isVisible()) await add.click();
    await claudeRow.getByText('Ready').waitFor({ timeout: 30_000 });
    await panelPage.getByRole('button', { name: 'Start', exact: true }).click();
    await panelPage.getByText('What should we build?').waitFor();
    await shot('02-home');
    await panelPage.locator('.model-chip').first().click();
    await panelPage.locator('.model-popover').waitFor();
    await shot('03-model-picker');
    await panelPage.keyboard.press('Escape');
    await pickModel(panelPage, MODEL);
    await send(panelPage, 'Use the t3-tab browser tools to read the shared tab, then tell me in one sentence what business the page is for.');
    await panelPage.locator('.user-bubble').waitFor({ timeout: 30_000 });
    await panelPage.locator('.work-head').first().waitFor({ timeout: 60_000 });
    await shot('04-thread-working');
    // The shared tab's origin is approved by the share, so a read runs without a prompt.
    await finished(panelPage);
    const reply = await panelPage.locator('.assistant').last().innerText();
    check('direct Claude Code run read the tab and replied', /bakery/i.test(reply), reply.slice(0, 120));
    await shot('05-thread-finished');
    await panelPage.locator('.work-head.toggle').last().click();
    await shot('06-thread-worklog');
    await panelPage.locator('#btn-threads').click();
    await panelPage.locator('.thread-row').first().waitFor();
    await shot('07-thread-list');
  } finally {
    await context.close().catch(() => undefined);
    site.server.close();
    if (process.env.T3_TAB_FLOW_KEEP === undefined) await rm(home.tempHome, { recursive: true, force: true }).catch(() => undefined);
  }
}

await mkdir(shotsDir, { recursive: true });
let failure;
try {
  if (which === 't3' || which === 'all') await runT3Flow();
  if (which === 'direct' || which === 'all') await runDirectFlow();
} catch (error) {
  failure = error;
  console.error(`FLOW STOPPED: ${error instanceof Error ? error.message : String(error)}`);
}
const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failure !== undefined || failed.length > 0 ? 1 : 0);
