// The panel capture set for design review: every view of the side panel at 400 x 800 in light and dark, from one
// believable scenario, then each image placed on the same neutral browser-window frame so it can sit beside other
// products' images in a blind set.
//
//   T3_TAB_CAPTURES_DIR=/some/folder pnpm captures      (after `pnpm build`)
//
// Writes into that folder
//   panel/         the panel alone, 400 x 800, as the browser draws it
//   framed/        the same images in the browser-window frame, the product's name and T3 Code's masked (for a blind set)
//   framed-named/  the same frame with the names left visible
//   welcome/       the welcome tab the extension opens on install, as a 1280 x 800 browser tab, not framed
//   manifest.json  every image with what was masked on it
//
// The scenario: someone on a headphone shop's page asks an agent to compare two products and add the better value one to the
// cart. The shop is served to the browser under a made-up address (https://soundhaus.example), the threads' titles, steps and
// replies come from that one conversation, and the install command is the product's (`npx t3-tab@latest setup`), not the
// prototype's test command: a copy of the built extension has that one string swapped, so no product code changes.
// Everything runs in a temporary HOME with the e2e fakes (`e2e/fakes`): no real model, no real T3, headless Chromium.
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  connectMcp,
  createHome,
  extensionWorker,
  installNativeHost,
  launchBrowser,
  panelRequest,
  refFor,
  requireBuild,
  sleep,
  stopDaemon,
  text as replyText,
  waitForBrowser,
} from './harness.mjs';
import { installFakeAgents, startFakeT3Environment } from './panel-sessions.mjs';

const OUT = process.env.T3_TAB_CAPTURES_DIR;
if (OUT === undefined || OUT === '') {
  console.error('Set T3_TAB_CAPTURES_DIR to the folder the captures go to, then run this again (after `pnpm build`).');
  process.exit(2);
}

const W = 400;
const H = 800;
const SCHEMES = ['light', 'dark'];
const SHOP = 'https://soundhaus.example';
const PRODUCT_COMMAND = 'npx t3-tab@latest setup';
const TEST_COMMAND_START = 'curl -fsSL https://raw.githubusercontent.com/';
/** Names the blind set must not show: the product's and its host's. */
const MASKED_NAMES = String.raw`t3[- ]?tab|t3 code`;

const SHOP_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Soundhaus – Compare headphones</title>
<style>
*{box-sizing:border-box}body{margin:0;font:15px/1.5 system-ui,sans-serif;color:#1d1d1f;background:#fafaf8}
header{display:flex;align-items:center;gap:28px;padding:16px 32px;border-bottom:1px solid #e4e4df;background:#fff}
header b{font-size:20px;letter-spacing:-.02em}header span{color:#6b6b66}
main{padding:28px 32px}h1{font-size:26px;margin:0 0 4px;letter-spacing:-.02em}.sub{color:#6b6b66;margin:0 0 24px}
.cards{display:grid;grid-template-columns:1fr 1fr;gap:20px}
.acc{margin-top:20px;display:flex;align-items:center;justify-content:space-between;gap:16px}.acc .price{margin:0}.acc .sub{margin:0}
.card{background:#fff;border:1px solid #e4e4df;border-radius:14px;padding:20px}
.pic{height:150px;border-radius:10px;margin-bottom:16px;background:linear-gradient(135deg,#d9dde3,#b9c0cc)}
.card:nth-child(2) .pic{background:linear-gradient(135deg,#3b3f47,#14161a)}
h2{margin:0;font-size:19px}.price{font-size:22px;font-weight:600;margin:4px 0 10px}
dl{margin:0 0 16px;display:grid;grid-template-columns:auto 1fr;gap:4px 14px}dt{color:#6b6b66}dd{margin:0}
button{font:inherit;font-weight:600;padding:9px 16px;border:0;border-radius:9px;background:#1d1d1f;color:#fff;cursor:pointer}
</style></head><body>
<header><b>Soundhaus</b><span>Headphones</span><span>Speakers</span><span>Deals</span></header>
<main><h1>Compare: Aria 40 and Bolt Pro</h1><p class="sub">Wireless noise-cancelling over-ear headphones</p>
<div class="cards">
<section class="card"><div class="pic"></div><h2>Aria 40</h2><div class="price">$149</div>
<dl><dt>Battery</dt><dd>40 hours</dd><dt>Noise cancelling</dt><dd>Yes</dd><dt>Weight</dt><dd>254 g</dd></dl><button>Add to cart</button></section>
<section class="card"><div class="pic"></div><h2>Bolt Pro</h2><div class="price">$219</div>
<dl><dt>Battery</dt><dd>30 hours</dd><dt>Noise cancelling</dt><dd>Yes</dd><dt>Weight</dt><dd>262 g</dd></dl><button>Add to cart</button></section>
</div><section class="card acc"><div><h2>Aria 40 Travel Case</h2><span class="sub">Hard shell, fits the Aria 40</span></div><div class="price">$24</div><button>Add to cart</button></section></main></body></html>`;

const CASE_MESSAGE = 'Find a hard case that fits the Aria 40 on this site and add it to my cart.';
const CASE_TITLE = 'Find a case for the Aria 40';
const MESSAGE = 'Compare the Aria 40 and the Bolt Pro on this page, then add the better value one to my cart.';
const TITLE = 'Compare Aria 40 and Bolt Pro';
const REPLY = [
  'The **Aria 40** is the better value for a commute, and it is in your cart.',
  '',
  '| | Aria 40 | Bolt Pro |',
  '| --- | --- | --- |',
  '| Price | $149 | $219 |',
  '| Battery | 40 hours | 30 hours |',
  '| Noise cancelling | Yes | Yes |',
  '| Weight | 254 g | 262 g |',
  '',
  'Both cancel noise, and the Aria 40 costs $70 less and lasts 10 hours longer.',
].join('\n');
const STREAMING = 'The **Aria 40 Travel Case** is $24 and fits the Aria 40 exactly. I am adding it to your cart now and will check the cart total once the page updates';

await rm(OUT, { recursive: true, force: true });
for (const sub of ['panel', 'framed', 'framed-named']) await mkdir(join(OUT, sub), { recursive: true });

const home = await createHome();
// A copy of the built extension with the product's install command in place of the prototype's test command.
const extensionCopy = join(home.tempHome, 'extension');
await cp(home.extensionDir, extensionCopy, { recursive: true });
let swapped = 0;
for (const file of await readdir(join(extensionCopy, 'chunks'))) {
  const path = join(extensionCopy, 'chunks', file);
  const source = await readFile(path, 'utf8');
  const start = source.indexOf(TEST_COMMAND_START);
  if (start === -1) continue;
  const end = source.indexOf('| sh', start) + '| sh'.length;
  await writeFile(path, source.slice(0, start) + PRODUCT_COMMAND + source.slice(end));
  swapped += 1;
}
if (swapped === 0) throw new Error('The built panel does not hold the test install command any more; update e2e/captures.mjs where it swaps it for the product command.');
home.extensionDir = extensionCopy;
await requireBuild(home);
const fakes = await installFakeAgents(home);
const fakeT3 = await startFakeT3Environment(home);
await writeFile(join(fakes.fakeDir, 't3-mode'), 'stopped'); // first run: no T3, the direct route

let context;
let mcp;
const manifest = [];
try {
  context = await launchBrowser(home);
  await context.route(`${SHOP}/**`, (route) => {
    if (route.request().url().endsWith('/favicon.ico')) return route.fulfill({ status: 204 });
    return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: SHOP_PAGE });
  });
  const owner = context.pages()[0] ?? (await context.newPage());
  await owner.goto(`${SHOP}/compare`);
  const { serviceWorker, extensionId } = await extensionWorker(context);
  const tabId = await serviceWorker.evaluate(async () => (await chrome.tabs.query({})).find((tab) => tab.url?.startsWith('https://soundhaus.example'))?.id);
  if (tabId === undefined) throw new Error('The shop tab was not found');

  const open = async () => {
    const page = await context.newPage();
    await page.setViewportSize({ width: W, height: H });
    await page.exposeFunction('__t3tabPanelBridge', async (request) => {
      try {
        return await serviceWorker.evaluate(async (message) => await globalThis.__t3tabHandlePanelRequest(message), request);
      } catch (error) {
        return { ok: false, error: String(error) };
      }
    });
    await page.goto(`chrome-extension://${extensionId}/sidepanel.html?tabId=${tabId}`);
    await page.bringToFront();
    return page;
  };

  /** The boxes of the product's and its host's names on the page, in screenshot pixels, each with the colour behind it. */
  const nameBoxes = async (page) =>
    await page.evaluate((pattern) => {
      const names = new RegExp(pattern, 'gi');
      const boxes = [];
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      const behind = (element) => {
        for (let node = element; node !== null; node = node.parentElement) {
          const colour = getComputedStyle(node).backgroundColor;
          if (colour !== 'rgba(0, 0, 0, 0)' && colour !== 'transparent') return colour;
        }
        return getComputedStyle(document.body).backgroundColor;
      };
      for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
        const parent = node.parentElement;
        if (parent === null || parent.closest('script, style') !== null) continue;
        for (const match of node.data.matchAll(names)) {
          const range = document.createRange();
          range.setStart(node, match.index);
          range.setEnd(node, match.index + match[0].length);
          for (const rect of range.getClientRects()) {
            // Only text that is drawn: not in a hidden, clipped or covered element.
            const top = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
            if (top === null || !(parent.contains(top) || top.contains(parent))) continue;
            if (rect.width > 0 && rect.height > 0) boxes.push({ x: rect.x, y: rect.y, w: rect.width, h: rect.height, colour: behind(parent) });
          }
        }
      }
      return boxes;
    }, MASKED_NAMES);

  /** One view, in both colour schemes: the panel's own image and where the names are on it. */
  const shoot = async (page, name, beforeEach) => {
    for (const scheme of SCHEMES) {
      await page.emulateMedia({ colorScheme: scheme });
      await beforeEach?.(scheme);
      await page.mouse.move(W - 1, H - 1);
      await sleep(400);
      const file = `${name}-${scheme}.png`;
      const masks = await nameBoxes(page);
      await page.screenshot({ path: join(OUT, 'panel', file), animations: 'disabled' });
      manifest.push({ name, scheme, file, masks });
    }
    await page.emulateMedia({ colorScheme: 'light' });
    console.log(`captured ${name}`);
  };

  // ---- First run ---------------------------------------------------------------------------------------------------
  // The welcome tab the extension opens on install, as a browser tab, not framed: its one button opens the panel there.
  const welcome = context.pages().find((page) => page.url().endsWith('/welcome.html'));
  if (welcome === undefined) throw new Error('The extension opened no welcome tab');
  await mkdir(join(OUT, 'welcome'), { recursive: true });
  await welcome.setViewportSize({ width: 1280, height: 800 });
  await welcome.getByRole('button', { name: 'Copy the command and open T3-Tab' }).waitFor();
  for (const scheme of SCHEMES) {
    await welcome.emulateMedia({ colorScheme: scheme });
    await sleep(300);
    await welcome.screenshot({ path: join(OUT, 'welcome', `00-welcome-tab-${scheme}.png`), animations: 'disabled' });
  }
  await welcome.close();
  console.log('captured 00-welcome-tab');

  // The panel opens on the new-thread screen; until the helper connects, one setup card sits over a usable composer.
  const panel = await open();
  await panel.locator('[data-setup-card]').getByText('Run this in a terminal').waitFor({ timeout: 20_000 });
  await shoot(panel, '01-first-run-helper-missing');
  await panel.locator('.composer-input').fill(MESSAGE);
  await shoot(panel, '02-first-run-task-typed');

  await installNativeHost(home); // what `t3-tab setup` does for the panel: registers the native host
  await panel.locator('[data-setup-card]').waitFor({ state: 'detached', timeout: 40_000 });
  await panel.locator('.send-btn:not([disabled])').waitFor({ timeout: 20_000 });
  await sleep(500);
  await shoot(panel, '05-new-thread-direct-typed');
  await panel.locator('.composer-input').fill('');
  await shoot(panel, '03-new-thread-direct');
  await panel.locator('.model-chip').first().click();
  await panel.locator('.model-popover').waitFor();
  await shoot(panel, '04-model-picker-direct');
  await panel.keyboard.press('Escape');

  // ---- T3 running, not connected: the new-thread screen's one Connect row ---------------------------------------------
  await writeFile(join(fakes.fakeDir, 't3-mode'), 'running');
  await panel.reload(); // a fresh panel asks the helper about T3 at once
  await panel.locator('.setup-card.connect-row').getByRole('button', { name: 'Connect' }).waitFor({ timeout: 30_000 });
  await shoot(panel, '05b-new-thread-t3-connect');

  // ---- T3 connected: hero, project picker, model picker with the access footer ----------------------------------------
  const injectT3 = async (page, threads = []) =>
    await page.evaluate(
      ([list, now]) => {
        const at = (n) => new Date(now + n * 60_000).toISOString();
        const client = window.__t3tabT3;
        client.set({ status: 'ready' });
        client.onConfig({
          type: 'snapshot',
          config: {
            providers: [
              {
                instanceId: 'claudeAgent', driver: 'claudeAgent', enabled: true, installed: true, status: 'ready',
                supportedRuntimeModes: ['approval-required', 'auto-accept-edits', 'full-access'],
                models: [
                  { slug: 'claude-opus-5-5', name: 'Claude Opus 5.5', shortName: 'Opus 5.5', isDefault: true, capabilities: { optionDescriptors: [{ id: 'effort', label: 'Effort', type: 'select', role: 'reasoning', currentValue: 'high', options: [{ id: 'medium', label: 'Medium' }, { id: 'high', label: 'High' }] }] } },
                  { slug: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', shortName: 'Sonnet 5.5' },
                  { slug: 'claude-haiku-5-5', name: 'Claude Haiku 5.5', shortName: 'Haiku 5.5' },
                ],
              },
              {
                instanceId: 'codex', driver: 'codex', enabled: true, installed: true, status: 'ready',
                supportedRuntimeModes: ['approval-required', 'auto-accept-edits', 'full-access'],
                models: [{ slug: 'gpt-5.5-codex', name: 'GPT-5.5 Codex', shortName: '5.5 Codex', isDefault: true }],
              },
            ],
            scratchWorkspaceRoot: '/home/dev/scratch',
            settings: {},
            environment: { label: 'desktop', platform: { machine: 'desktop' }, capabilities: { threadStop: true, voiceTranscription: true } },
          },
        });
        const shell = (id, title, projectId, extra) => ({
          id, projectId, title, status: 'completed', interactionMode: 'default', createdAt: at(-600), updatedAt: at(-60),
          latestRunId: `run-${id}`, latestRunRequestedAt: at(-90), latestRunStartedAt: at(-89), latestRunCompletedAt: at(-60),
          activeRunId: null, activityRunStatus: null, pendingRuntimeRequest: null, lineage: { relationshipToParent: null, parentThreadId: null },
          archivedAt: null, settledOverride: null, settledAt: null,
          ...Object.fromEntries(Object.entries(extra).map(([key, value]) => [key, typeof value === 'number' ? at(value) : value])),
        });
        client.onShell({
          kind: 'snapshot',
          snapshot: {
            threads: list.map(([id, title, projectId, extra]) => shell(id, title, projectId, extra)),
            projects: [
              { id: 'p0', title: 'Scratch', workspaceRoot: '/home/dev/scratch' },
              { id: 'p1', title: 'budget-tracker', workspaceRoot: '/home/dev/budget-tracker' },
              { id: 'p2', title: 'dotfiles', workspaceRoot: '/home/dev/dotfiles' },
            ],
          },
        });
      },
      [threads, Date.now()],
    );
  await injectT3(panel);
  await panel.evaluate(() => chrome.storage.local.remove(['composer.project']));
  await panel.locator('#btn-new').click().catch(() => undefined);
  await panel.locator('.hero h1').filter({ hasText: 'What should we work on?' }).waitFor({ timeout: 10_000 });
  await shoot(panel, '06-new-thread-t3');
  await panel.locator('.hero-picker > button').click();
  await panel.locator('.project-popover').waitFor();
  await shoot(panel, '07-project-picker');
  await panel.locator('.project-popover').getByText('budget-tracker').click();
  await sleep(300);
  await panel.locator('.model-chip').first().click();
  await panel.locator('.model-popover').waitFor();
  await shoot(panel, '08-model-picker-t3');
  await panel.keyboard.press('Escape');
  await panel.locator('.hero-picker > button').click();
  await panel.locator('.project-popover').getByText('No project').click().catch(() => undefined);
  await sleep(300);
  await panel.locator('.composer-input').fill(MESSAGE);
  await shoot(panel, '09-new-thread-t3-typed');
  await panel.locator('.composer-input').fill('');

  // ---- A real browser permission prompt from a connected agent session -----------------------------------------------
  ({ client: mcp } = await connectMcp(home, 'claude-code'));
  await waitForBrowser(home);
  await mcp.callTool({ name: 'tabs', arguments: {} });
  const { sessions } = await panelRequest(serviceWorker, { type: 'panel.state', tabId });
  const session = sessions.at(-1);
  await panelRequest(serviceWorker, { type: 'panel.shareTab', sessionId: session.id, tabId });
  const readResult = await mcp.callTool({ name: 'read', arguments: {} });
  const ref = refFor(replyText(readResult), 'Add to cart');
  if (ref === undefined) throw new Error(`no "Add to cart" ref in read: ${replyText(readResult)}`);
  const pendingClick = mcp.callTool({ name: 'act', arguments: { steps: [{ action: 'click', ref }] } });
  pendingClick.catch(() => undefined); // answered below; if the run fails first, its own error is the one to show
  await panel.locator('.prompt-list').waitFor({ timeout: 20_000 });
  await sleep(800); // the card's buttons are locked for 500 ms
  await shoot(panel, '10-permission-card-new-thread');

  // ---- Threads, as T3 reports them -----------------------------------------------------------------------------------
  // Each carries the model it runs on, as T3's shell always does; one runs on Codex.
  const claude = { modelSelection: { instanceId: 'claudeAgent', model: 'claude-opus-5-5' } };
  const codex = { modelSelection: { instanceId: 'codex', model: 'gpt-5.5-codex' } };
  const rows = [
    ['busy', CASE_TITLE, 'p0', { ...claude, status: 'running', activityRunStatus: 'running', activeRunId: 'run-busy', latestRunCompletedAt: null, latestUserAuthoredMessageAt: -2 }],
    ['done', TITLE, 'p0', { ...claude, latestRunCompletedAt: -3, lastVisitedAt: -10 }],
    ['asks', 'Add a monthly summary to the budget view', 'p1', { ...claude, status: 'waiting', activityRunStatus: 'waiting', activeRunId: 'run-asks', latestRunCompletedAt: null, pendingRuntimeRequest: { id: 'q1', kind: 'approval', createdAt: -1 } }],
    ['older', 'Fix the failing import test', 'p1', { ...codex, latestRunCompletedAt: -300 }],
    ['snz', 'Check if the Bolt Pro is back in stock', 'p0', { ...claude, snoozedAt: -5, snoozedUntil: 90 }],
    ['old', 'Set up the new terminal prompt', 'p2', { ...codex, settledOverride: 'settled', settledAt: -30 }],
  ];
  const seed = async (page, id, view) =>
    await page.evaluate(([threadId, value]) => {
      window.__t3tabT3.watches.set(threadId, { listeners: new Set(), view: value, stop() {} });
    }, [id, view]);
  const now = Date.now();
  const steps = (running) => [
    { id: 'e1', icon: 'browser', label: 'Took the shared tabs', status: 'done' },
    { id: 'e2', icon: 'browser', label: 'Read soundhaus.example', status: 'done' },
    { id: 'e3', icon: 'browser', label: 'Clicked on soundhaus.example', status: running ? 'running' : 'done' },
  ];
  const shared = { source: 't3', failed: false, queued: [], runtimeMode: 'full-access', provider: 'claudeAgent', model: 'claude-opus-5-5', modelOptions: { effort: 'high' }, projectId: 'p0' };
  const running = {
    ...shared, id: 'busy', title: CASE_TITLE, running: true, activeRunId: 'run-busy',
    rows: [
      { kind: 'user', id: 'u1', text: CASE_MESSAGE, at: now - 40_000 },
      { kind: 'work', id: 'w1', running: true, startedAt: now - 32_000, entries: steps(true) },
      { kind: 'assistant', id: 'a1', streaming: true, text: STREAMING },
    ],
  };
  const finished = {
    ...shared, id: 'done', title: TITLE, running: false,
    rows: [
      { kind: 'user', id: 'u1', text: MESSAGE, at: now - 600_000 },
      { kind: 'work', id: 'w1', running: false, startedAt: now - 590_000, endedAt: now - 556_000, entries: steps(false) },
      { kind: 'assistant', id: 'a1', streaming: false, at: now - 555_000, text: REPLY },
    ],
  };
  const asks = {
    ...shared, id: 'asks', title: 'Add a monthly summary to the budget view', running: true, activeRunId: 'run-asks', runtimeMode: 'approval-required', projectId: 'p1',
    rows: [
      { kind: 'user', id: 'u1', text: 'Add a monthly summary to the budget view and run the tests.', at: now - 120_000 },
      { kind: 'work', id: 'w1', running: true, startedAt: now - 100_000, entries: [{ id: 'e1', icon: 'edit', label: 'Changed MonthlySummary.tsx +42 −0', status: 'done' }, { id: 'e2', icon: 'approval', label: 'Waiting for approval', status: 'waiting' }] },
    ],
    approval: { requestId: 'r1', responseCapability: 'live', entryId: 'e2', kind: 'command', title: 'pnpm test', detail: 'in /home/dev/budget-tracker', options: [{ decision: 'decline', label: 'Decline' }, { decision: 'acceptForSession', label: 'Always allow this session' }, { decision: 'accept', label: 'Approve' }] },
  };
  await injectT3(panel, rows);
  await seed(panel, 'busy', running);
  await seed(panel, 'done', finished);
  await seed(panel, 'asks', asks);

  await panel.locator('#btn-threads').click();
  await panel.locator('.thread-row').first().waitFor();
  await sleep(400);
  await shoot(panel, '11-thread-list');
  for (const shelf of ['working', 'snoozed', 'settled']) await panel.locator(`.shelf[data-shelf="${shelf}"]`).click().catch(() => undefined);
  await shoot(panel, '12-thread-list-shelves-open');

  await panel.locator('.thread-row').filter({ hasText: CASE_TITLE }).first().click();
  await panel.locator('.screen[data-thread-id]').waitFor();
  await sleep(1500);
  await shoot(panel, '13-thread-running-permission-card');
  await panel.getByRole('button', { name: 'Allow acting once' }).click();
  await pendingClick;
  await sleep(600);
  await shoot(panel, '14-thread-running');

  await panel.locator('#btn-threads').click();
  await panel.locator('.thread-row').filter({ hasText: 'Add a monthly summary' }).click();
  await panel.locator('.approval-card').waitFor();
  await sleep(500);
  await shoot(panel, '15-thread-approval-card');

  await panel.locator('#btn-threads').click();
  await panel.locator('.thread-row').filter({ hasText: TITLE }).first().click();
  await panel.locator('article.assistant').waitFor();
  await sleep(600);
  await shoot(panel, '16-thread-finished');
  await panel.locator('.work-head.toggle').click();
  await shoot(panel, '17-thread-finished-steps-open');

  // ---- Settings ------------------------------------------------------------------------------------------------------
  for (const [origin, setting] of [['https://en.wikipedia.org', 'read'], ['https://soundhaus.example', 'allow'], ['https://news.ycombinator.com', 'ask']]) {
    await panelRequest(serviceWorker, { type: 'panel.setSite', origin, setting });
  }
  await panel.locator('#btn-settings').click();
  await panel.locator('.settings-tabs').waitFor();
  await sleep(500);
  await shoot(panel, '18-settings-general');
  await panel.locator('.settings-tabs button').filter({ hasText: 'Sites' }).click();
  await sleep(500);
  await shoot(panel, '19-settings-sites');
  await panel.locator('.settings-tabs button').filter({ hasText: 'General' }).click();
  await panel.locator('.theme-trigger').click();
  await sleep(300);
  await shoot(panel, '20-settings-theme-menu');
  await panel.locator('.theme-popover').getByRole('button', { name: 'Create theme' }).click();
  await panel.locator('.sheet [data-bar]').waitFor();
  await sleep(400);
  // The sheet edits one mode at a time and shows that mode's colours whatever the browser's scheme is, so each capture
  // opens the tab for its own scheme.
  await shoot(panel, '21-theme-sheet', async (scheme) => {
    await panel.getByRole('radiogroup', { name: 'Appearance' }).getByRole('radio', { name: scheme === 'dark' ? 'Dark' : 'Light' }).click();
  });

  // ---- Framing -------------------------------------------------------------------------------------------------------
  // One neutral browser window, the same size for every image: tab strip, address bar, the shop's page at the left and the
  // panel at its right at its own 1:1 size. The page behind is the shop as it was captured, the same in every image.
  const shopShot = await (async () => {
    const page = await context.newPage();
    await page.setViewportSize({ width: 800, height: H });
    await page.goto(`${SHOP}/compare`);
    await page.waitForLoadState('load');
    const png = await page.screenshot();
    await page.close();
    return png.toString('base64');
  })();
  const WINDOW_W = 800 + W;
  const TOP = 88;
  const PAD = 32;
  const frameHtml = (scheme, panelPng, masks) => {
    const dark = scheme === 'dark';
    const c = dark
      ? { desk: '#17171a', strip: '#26262b', bar: '#303036', tab: '#303036', field: '#1d1d21', ink: '#d9d9de', dim: '#8d8d96', line: '#3b3b42' }
      : { desk: '#e4e4e8', strip: '#d4d4da', bar: '#f4f4f6', tab: '#f4f4f6', field: '#e6e6ea', ink: '#26262b', dim: '#6f6f78', line: '#c4c4cb' };
    const boxes = masks
      .map((m) => `<i style="left:${m.x - 1}px;top:${m.y - 1}px;width:${m.w + 2}px;height:${m.h + 2}px;background:${m.colour}"><u></u></i>`)
      .join('');
    return `<!doctype html><meta charset="utf-8"><style>
*{box-sizing:border-box}body{margin:0;width:${WINDOW_W + PAD * 2}px;height:${TOP + H + PAD * 2}px;background:${c.desk};padding:${PAD}px;font:13px system-ui,sans-serif;color:${c.ink}}
.win{width:${WINDOW_W}px;height:${TOP + H}px;border-radius:12px;overflow:hidden;background:${c.bar};box-shadow:0 12px 40px rgba(0,0,0,${dark ? 0.55 : 0.22}),0 0 0 1px ${c.line};position:relative}
.strip{height:40px;background:${c.strip};display:flex;align-items:flex-end;padding:0 12px;gap:8px}
.dots{display:flex;gap:8px;align-self:center;margin-right:12px}.dots b{width:12px;height:12px;border-radius:50%;background:${c.dim};opacity:.55}
.tab{height:32px;width:280px;background:${c.tab};border-radius:9px 9px 0 0;display:flex;align-items:center;gap:8px;padding:0 12px;white-space:nowrap;overflow:hidden}
.tab span.g{width:14px;height:14px;border-radius:4px;background:#8d96a6;flex:none}
.tools{height:48px;background:${c.bar};display:flex;align-items:center;gap:14px;padding:0 14px;border-bottom:1px solid ${c.line}}
.tools .ic{width:18px;height:18px;border:2px solid ${c.dim};border-radius:50%;opacity:.6}
.url{flex:1;height:30px;border-radius:15px;background:${c.field};display:flex;align-items:center;padding:0 14px;color:${c.dim}}.url b{color:${c.ink};font-weight:400}
.body{position:absolute;left:0;top:${TOP}px;width:${WINDOW_W}px;height:${H}px}
.page{position:absolute;left:0;top:0;width:800px;height:${H}px}
.panel{position:absolute;left:800px;top:0;width:${W}px;height:${H}px;border-left:1px solid ${c.line}}
.panel img,.page img{display:block;width:100%;height:100%}.panel i{position:absolute;display:block}.panel i u{position:absolute;inset:3px 0;border-radius:4px;background:${c.dim};opacity:.3}
</style><div class="win">
<div class="strip"><div class="dots"><b></b><b></b><b></b></div><div class="tab"><span class="g"></span>Soundhaus – Compare headphones</div></div>
<div class="tools"><span class="ic"></span><span class="ic"></span><span class="ic"></span><div class="url">soundhaus.example<b>/compare</b></div><span class="ic" style="border-radius:4px"></span></div>
<div class="body"><div class="page"><img src="data:image/png;base64,${shopShot}"></div>
<div class="panel"><img src="data:image/png;base64,${panelPng}">${boxes}</div></div></div>`;
  };
  const framer = await context.newPage();
  await framer.setViewportSize({ width: WINDOW_W + PAD * 2, height: TOP + H + PAD * 2 });
  for (const entry of manifest) {
    const panelPng = (await readFile(join(OUT, 'panel', entry.file))).toString('base64');
    for (const [folder, masks] of [['framed', entry.masks], ['framed-named', []]]) {
      await framer.setContent(frameHtml(entry.scheme, panelPng, masks));
      await framer.screenshot({ path: join(OUT, folder, entry.file) });
    }
  }
  await framer.close();

  await writeFile(join(OUT, 'manifest.json'), `${JSON.stringify(manifest, null, 1)}\n`);
  console.log(`done: ${manifest.length} images in ${OUT} (panel/, framed/, framed-named/); names masked on ${manifest.filter((entry) => entry.masks.length > 0).length}`);
} finally {
  await mcp?.close().catch(() => undefined);
  await context?.close().catch(() => undefined);
  await fakeT3.close();
  await stopDaemon(home.statePath);
  await rm(home.tempHome, { recursive: true, force: true });
}
