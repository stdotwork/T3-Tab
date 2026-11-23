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

import { createHome, extensionWorker, installNativeHost, launchBrowser, listen, panelRequest, requireBuild, sleep, stopDaemon } from './harness.mjs';

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
      // Long enough for colour transitions to finish.
      await sleep(320);
      await page.screenshot({ path: join(shotsDir, `${prefix}-${name}-${scheme}.png`) });
    }
    await page.emulateMedia({ colorScheme: 'light' });
  };
}

/** The panel's background as sRGB, whatever colour syntax the theme stored it in. */
async function canvasColor(page) {
  return await page.evaluate(() => {
    const paint = document.createElement('canvas').getContext('2d');
    paint.fillStyle = getComputedStyle(document.querySelector('.screen')).backgroundColor;
    paint.fillRect(0, 0, 1, 1);
    return [...paint.getImageData(0, 0, 1, 1).data].slice(0, 3).join(',');
  });
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
  const extraSites = [];
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
    await panelPage.locator('.work-entry').nth(1).waitFor({ timeout: 60_000 }).catch(() => undefined);
    await shot('07-thread-working');
    await finished(panelPage);
    const reply = await panelPage.locator('.assistant').last().innerText();
    check('T3 thread read the shared tab and replied', /bakery/i.test(reply), reply.slice(0, 120));
    await panelPage.locator('.work-head.toggle').last().click();
    const opened = await panelPage.locator('.timeline').innerText();
    await panelPage.locator('.work-head.toggle').last().click();
    check('no claim code shows in the thread, work log included', !/[A-Za-z0-9_-]{20,}/.test(opened.replace(/https?:\S+/g, '')), opened.match(/[A-Za-z0-9_-]{20,}/)?.[0]?.slice(0, 6) ?? '');
    await shot('08-thread-finished');
    await panelPage.locator('.work-head.toggle').last().click();
    await shot('09-thread-worklog');
    await panelPage.locator('.work-head.toggle').last().click();

    // 4. A Supervised thread: T3's approval card, a question, and a browser prompt in both places.
    await panelPage.getByRole('button', { name: 'New thread' }).click();
    await panelPage.locator('.runtime-btn').click();
    await panelPage.getByRole('menuitemradio', { name: /Supervised/ }).click();
    await pickModel(panelPage, MODEL);
    // No browser work here, so no tab goes with it and the agent has no claim to make.
    await panelPage.getByRole('button', { name: "Don't share this tab" }).click();
    await send(panelPage, 'Create a file named notes.txt in this folder containing exactly one line: hello. Then reply with the word done.');
    await panelPage.locator('.approval-card').waitFor({ timeout: 120_000 });
    await shot('10-approval');
    await panelPage.locator('.approval-card').getByRole('button', { name: 'Approve', exact: true }).click();
    await until('notes.txt', async () => (await readFile(join(projectDir, 'notes.txt'), 'utf8').catch(() => '')).includes('hello'), 120_000);
    check('approval answered from the panel reached the agent', true);
    await finished(panelPage);

    await panelPage.getByRole('button', { name: 'New thread' }).click();
    await pickModel(panelPage, MODEL);
    // No browser work here, so no tab goes with it and the agent has no claim to make.
    await panelPage.getByRole('button', { name: "Don't share this tab" }).click();
    await send(panelPage, 'Before anything else, use your AskUserQuestion tool to ask me one multiple-choice question with two options: bullets or prose. After my answer, reply with just the option I picked.');
    await panelPage.locator('.question-card').waitFor({ timeout: 120_000 });
    await shot('11-question');
    await panelPage.locator('.question-option').filter({ hasText: /prose/i }).click();
    await panelPage.locator('.question-card').getByRole('button', { name: 'Submit' }).click();
    await until('the answer', async () => /prose/i.test(await panelPage.locator('.assistant').last().innerText().catch(() => '')), 120_000);
    check('question answered from the panel reached the agent', true);
    await finished(panelPage);

    // A browser request shows in both places. The first answer counts, from either side.
    const siteB = await startSite();
    const siteC = await startSite();
    extraSites.push(siteB, siteC);
    await panelPage.getByRole('button', { name: 'New thread' }).click();
    await pickModel(panelPage, MODEL);
    await send(panelPage, `Use the t3-tab browser tools. Step 1: open ${siteB.url} in a new tab with the tabs tool and read it. Step 2: open ${siteC.url} in a new tab and read it. If a step is declined, stop. Finally reply with the word finished.`);
    await panelPage.locator('.user-bubble').filter({ hasText: 'Step 1' }).waitFor({ timeout: 30_000 });
    const threadId = await panelPage.locator('.screen[data-thread-id]').getAttribute('data-thread-id');
    const threadApproval = async () => await panelPage.evaluate(async (id) => await new Promise((resolve) => {
      let stop;
      stop = window.__t3tabT3.watchThread(id, (view) => { resolve(view.approval ?? null); setTimeout(() => stop?.(), 0); });
    }), threadId);
    /** Approves T3's ordinary tool cards until a browser request is waiting in the sidebar. */
    const untilBrowserRequest = async (seen) => await until('a browser request', async () => {
      const prompts = (await panelRequest(serviceWorker, { type: 'panel.state', tabId })).pending;
      const fresh = prompts.find((prompt) => !seen.has(prompt.id));
      if (fresh !== undefined) return fresh;
      const approval = await threadApproval();
      if (approval !== null && approval.kind !== 'mcp-elicitation') {
        await panelPage.evaluate(async ({ id, requestId }) => await window.__t3tabT3.respond(id, requestId, { decision: 'accept' }), { id: threadId, requestId: approval.requestId });
      }
      return undefined;
    }, 150_000);
    const seen = new Set();
    const first = await untilBrowserRequest(seen);
    seen.add(first.id);
    await panelPage.locator('.prompt-card').first().waitFor();
    check('browser request shows in the sidebar', true, `${first.tool} on ${first.origin}`);
    await shot('12-permission');
    const inThread = await until('the request in the T3 thread', async () => {
      const approval = await threadApproval();
      return approval?.kind === 'mcp-elicitation' ? approval : undefined;
    }, 20_000).catch(() => undefined);
    check('the same request is in the T3 thread as an approval', inThread !== undefined, inThread?.title ?? 'not seen');
    if (inThread !== undefined) {
      await panelPage.evaluate(async ({ id, requestId }) => await window.__t3tabT3.respond(id, requestId, { decision: 'accept' }), { id: threadId, requestId: inThread.requestId });
      await until('the sidebar card to clear', async () => !(await panelRequest(serviceWorker, { type: 'panel.state', tabId })).pending.some((prompt) => prompt.id === first.id), 15_000);
      check('answering in the T3 thread cleared the sidebar card', true);
    }
    const second = await untilBrowserRequest(seen);
    seen.add(second.id);
    await until('the second request in the thread', async () => (await threadApproval())?.kind === 'mcp-elicitation', 20_000).catch(() => undefined);
    await sleep(650);
    await panelPage.locator(`.prompt-card[data-prompt-id="${second.id}"] .prompt-btn.primary`).click();
    const cleared = await until('T3 to drop its approval', async () => (await threadApproval())?.requestId === undefined || (await threadApproval())?.kind !== 'mcp-elicitation', 20_000).catch(() => false);
    check('answering in the sidebar cleared the T3 approval', cleared !== false);
    for (let round = 0; round < 40; round += 1) {
      const done = await panelPage.evaluate(async (id) => await new Promise((resolve) => {
        let stop;
        stop = window.__t3tabT3.watchThread(id, (view) => { resolve(!view.running); setTimeout(() => stop?.(), 0); });
      }), threadId);
      if (done) break;
      const approval = await threadApproval();
      if (approval !== null) await panelPage.evaluate(async ({ id, requestId }) => await window.__t3tabT3.respond(id, requestId, { decision: 'accept' }), { id: threadId, requestId: approval.requestId }).catch(() => undefined);
      const waiting = (await panelRequest(serviceWorker, { type: 'panel.state', tabId })).pending[0];
      if (waiting !== undefined) await panelRequest(serviceWorker, { type: 'panel.decide', promptId: waiting.id, decision: 'allow-once' }).catch(() => undefined);
      await sleep(1500);
    }
    check('the agent finished after both answers', /finished/i.test(await panelPage.locator('.assistant').last().innerText().catch(() => '')));

    // Full access counts as yes: a site never approved opens with no prompt at all.
    const siteD = await startSite();
    extraSites.push(siteD);
    const before = ((await panelRequest(serviceWorker, { type: 'panel.state', tabId })).autoAllowed ?? []).length;
    await panelPage.getByRole('button', { name: 'New thread' }).click();
    await panelPage.locator('.runtime-btn').click();
    await panelPage.getByRole('menuitemradio', { name: /Full access/ }).click();
    await pickModel(panelPage, MODEL);
    await send(panelPage, `Use the t3-tab browser tools to open ${siteD.url} in a new tab and read it. Reply with the h1 text only.`);
    await finished(panelPage);
    const after = await panelRequest(serviceWorker, { type: 'panel.state', tabId });
    check('Full access answered yes for the browser', (after.autoAllowed ?? []).length > before && after.pending.length === 0, `${(after.autoAllowed ?? []).length - before} auto-allowed`);
    // Lowering the mode outside the panel's menu, as T3's own app would, ends the automatic yes.
    const fullThread = await panelPage.locator('.screen[data-thread-id]').getAttribute('data-thread-id');
    const grantFlags = async () => await serviceWorker.evaluate(async (key) => {
      const { claimGrants } = await chrome.storage.session.get('claimGrants');
      return Object.values(claimGrants ?? {}).filter((grant) => grant.conversationId === key).map((grant) => grant.fullAccess);
    }, `t3:${fullThread}`);
    const beforeLower = await until('the thread grant', async () => {
      const flags = await grantFlags();
      return flags.length > 0 ? flags : undefined;
    }, 5_000);
    await panelPage.evaluate(async (id) => await window.__t3tabT3.setRuntimeMode(id, 'approval-required'), fullThread);
    const lowered = await until('the grant to lose Full access', async () => (await grantFlags()).every((flag) => flag === false), 8_000).catch(() => false);
    check('lowering Full access in T3 ends the automatic yes', beforeLower.every(Boolean) && lowered === true, `${beforeLower.join(',')} -> ${(await grantFlags()).join(',')}`);

    await panelPage.getByRole('button', { name: 'New thread' }).click();
    await pickModel(panelPage, MODEL);
    await send(panelPage, 'Write a numbered list from 1 to 400, one number per line, with a short word after each number.');
    await panelPage.getByRole('button', { name: 'Stop', exact: true }).click({ timeout: 60_000 });
    await panelPage.getByRole('button', { name: 'Send', exact: true }).waitFor({ timeout: 30_000 });
    check('Stop ended the T3 run', true);

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
    await panelPage.locator('.sheet').getByRole('radio', { name: 'Dark' }).click();
    await sleep(320);
    const darkDraft = await panelPage.evaluate(() => {
      const paint = document.createElement('canvas').getContext('2d');
      paint.fillStyle = getComputedStyle(document.querySelector('.sheet')).backgroundColor;
      paint.fillRect(0, 0, 1, 1);
      return [...paint.getImageData(0, 0, 1, 1).data].slice(0, 3);
    });
    check('the theme editor previews a dark theme', darkDraft.every((channel) => channel < 60), darkDraft.join(','));
    await panelPage.screenshot({ path: join(shotsDir, 't3-15-theme-create-dark.png') });
    await panelPage.getByRole('button', { name: 'Close', exact: true }).click();
    await panelPage.getByRole('button', { name: 'Add theme' }).click();
    const themeFile = JSON.stringify({ version: 1, name: 'Flow Import', appearance: 'dark', colors: { canvas: '#101820', text: '#f2f7fa', accent: '#ff7a59', messageAction: '#ff7a59', messageActionForeground: '#101820' } });
    await panelPage.locator('.sheet textarea').fill(themeFile);
    await panelPage.locator('.sheet').getByRole('button', { name: 'Add theme' }).click();
    const canvas = await until('the imported theme to apply', async () => {
      const value = await canvasColor(panelPage);
      return value === '16,24,32' ? value : undefined;
    }, 5_000).catch(() => undefined);
    check('a T3 theme file imports and applies', canvas !== undefined, String(canvas));
    await shot('16-theme-imported');
    const hostile = JSON.stringify({ version: 1, name: 'Flow CSS', appearance: 'dark', colors: { canvas: '#203040' }, css: '@import url("https://example.invalid/a.css"); .screen { outline: 1px solid red; background-image: url("https://example.invalid/b.png"); }' });
    await panelPage.getByRole('button', { name: 'Add theme' }).click();
    await panelPage.locator('.sheet textarea').fill(hostile);
    await panelPage.locator('.sheet').getByRole('button', { name: 'Add theme' }).click();
    await until('the CSS theme', async () => (await canvasColor(panelPage)) === '32,48,64', 5_000);
    const adopted = await panelPage.evaluate(() => [...document.adoptedStyleSheets].flatMap((sheet) => [...sheet.cssRules].map((rule) => rule.cssText)).join(' '));
    check('custom CSS applied with its remote loads stripped', adopted.includes('outline') && !/url\(|@import/.test(adopted), adopted.slice(0, 90));
    await panelPage.getByRole('button', { name: /Follow T3 Code/ }).click();
    await new Promise((resolve, reject) => {
      const child = spawn('t3', ['theme', 'set', 'grove'], { env: home.childEnv, stdio: 'ignore' });
      child.once('error', reject);
      child.once('close', resolve);
    });
    const groveCanvas = await until('T3 theme to arrive', async () => {
      const value = await canvasColor(panelPage);
      return value !== '32,48,64' && (await panelPage.evaluate(() => window.__t3tabT3.snapshot().defaultTheme)) === 'grove' ? value : undefined;
    }, 8_000).catch(() => undefined);
    check('the panel follows the theme set in T3', groveCanvas !== undefined, String(groveCanvas));
    await shot('16b-theme-follows-t3');
    await panelPage.locator('.settings-tabs').getByRole('button', { name: 'Sites' }).click();
    await shot('17-settings-sites');
    await panelPage.locator('.settings-tabs').getByRole('button', { name: 'Connections' }).click();
    await shot('18-settings-connections');
    await panelPage.getByRole('button', { name: 'Disconnect from T3 Code' }).click();
    await panelPage.locator('.setup-row').filter({ hasText: 'T3 Code' }).getByRole('button', { name: 'Connect' }).waitFor({ timeout: 15_000 });
    check('disconnect ends the panel session', true);
  } catch (error) {
    for (const page of context.pages()) {
      if (!page.url().includes('sidepanel')) continue;
      await page.screenshot({ path: join(shotsDir, 'failure.png') }).catch(() => undefined);
      console.log('at failure:', (await page.locator('.timeline').innerText().catch(() => '')).slice(-900));
      console.log('prompts:', await page.locator('.prompt-card').count());
    }
    throw error;
  } finally {
    await context.close().catch(() => undefined);
    await stopDaemon(home.statePath).catch(() => undefined);
    await stopT3(t3);
    site.server.close();
    for (const extra of extraSites) extra.server.close();
    if (process.env.T3_TAB_FLOW_KEEP === undefined) await rm(home.tempHome, { recursive: true, force: true }).catch(() => undefined);
  }
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
  const extraSites = [];
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
    await panelPage.locator('.work-entry').first().waitFor({ timeout: 60_000 }).catch(() => undefined);
    await shot('04-thread-working');
    // The shared tab's origin is approved by the share, so a read runs without a prompt.
    await finished(panelPage);
    const reply = await panelPage.locator('.assistant').last().innerText();
    check('direct Claude Code run read the tab and replied', /bakery/i.test(reply), reply.slice(0, 120));
    await shot('05-thread-finished');
    await panelPage.locator('.work-head.toggle').last().click();
    await shot('06-thread-worklog');
    await panelPage.locator('.work-head.toggle').last().click();
    const siteB = await startSite();
    extraSites.push(siteB);
    await panelPage.getByRole('button', { name: 'New thread' }).click();
    await pickModel(panelPage, MODEL);
    await send(panelPage, `Use the t3-tab tabs tool to open ${siteB.url} in a new tab, read it, and reply with the h1 text only.`);
    await panelPage.locator('.prompt-card').first().waitFor({ timeout: 90_000 });
    check('a direct run asks in the sidebar', true);
    await shot('08-permission');
    await sleep(650);
    await panelPage.locator('.prompt-card .prompt-btn.primary').first().click();
    await until('the direct reply', async () => /Harbour/i.test(await panelPage.locator('.assistant').last().innerText().catch(() => '')), 90_000);
    check('the sidebar answer let the direct run continue', true);
    await finished(panelPage);
    await panelPage.getByRole('button', { name: 'New thread' }).click();
    await pickModel(panelPage, MODEL);
    await send(panelPage, 'Write a numbered list from 1 to 400, one number per line, with a short word after each number.');
    await panelPage.getByRole('button', { name: 'Stop', exact: true }).click({ timeout: 30_000 });
    await panelPage.getByText('Stopped.').first().waitFor({ timeout: 20_000 });
    check('Stop ended the direct run', true);
    await panelPage.locator('#btn-threads').click();
    await panelPage.locator('.thread-row').first().waitFor();
    await shot('07-thread-list');
  } finally {
    await context.close().catch(() => undefined);
    await stopDaemon(home.statePath).catch(() => undefined);
    site.server.close();
    for (const extra of extraSites) extra.server.close();
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
