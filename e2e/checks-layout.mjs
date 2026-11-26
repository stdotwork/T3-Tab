// The panel's layout as people see it: every check here measures visible ink (SVG strokes and fills, text glyphs from
// the font's own metrics, painted boxes; see ./ink.mjs), never padding boxes, on each screen at 320, 360 and 400 px in
// light and dark. It fails when
// - a bar's (or the composer row's) first and last controls sit at different ink distances from its edges,
// - the composer's send circle is not as far from the frame's foot as the row's controls are from its sides,
// - the composer's controls are not one size, or their ink (and the model chip's logo and words) is off one centre line,
// - the composer's text does not start on the first control's ink,
// - the new-thread hero's project line is off the heading's centre,
// - the icon glyphs of one bar, or of the composer row, are drawn at different sizes or stroke weights,
// - a screen's top bar is not the panel's one bar (`[data-bar]`, Bar in Frame.tsx), or the bars of the screens it walks
//   differ from each other at one width and scheme: in height, in where their first and last ink sit, in their icons'
//   size and stroke weight, in where the thread toggle's ink sits, or in where the breadcrumb's text sits,
// by more than 1 px (0.25 px for stroke weights); and when
// - an approval card (a browser prompt or a T3 approval) is more than 160 px tall, its answers are not on one row of
//   one-line buttons inside the card, or a card on the new-thread screen moves the hero or the composer or covers it.
import { dirname, join } from 'node:path';

import { assert, panelRequest, sleep } from './harness.mjs';
import { installInkSource } from './ink.mjs';

const WIDTHS = [320, 360, 400];
const SCHEMES = ['light', 'dark'];
const TOLERANCE = 1;
const CARD_MAX = 160;
const ANSWER_HEIGHT = 28;

/** Measures every bar, the composer and the hero on the page as it stands. */
async function measure(page) {
  await page.evaluate(installInkSource());
  return await page.evaluate(() => {
    const shown = (element) => element !== null && element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden';
    const controlsOf = (row) =>
      [...row.children]
        .filter((child) => shown(child) && !child.classList.contains('popover'))
        .map((child) => ({ element: child, ink: window.__ink(child) }))
        .filter((entry) => entry.ink !== null);
    const name = (element) => element.getAttribute('aria-label') ?? element.className ?? element.tagName;
    const result = { bars: [], composer: null, hero: null, approvals: [] };
    // Every approval card: its ink height, and whether its answers stand on one row of one-line buttons inside it.
    for (const card of document.querySelectorAll('.approval-card')) {
      if (!shown(card)) continue;
      const ink = window.__ink(card);
      const box = card.getBoundingClientRect();
      const row = card.querySelector('.approval-actions');
      const buttons = [...card.querySelectorAll('.answer-btn')].filter(shown).map((button) => button.getBoundingClientRect());
      result.approvals.push({
        kind: card.classList.contains('inline') ? 'inline' : 'dock',
        height: ink === null ? 0 : Math.round((ink.bottom - ink.top) * 10) / 10,
        buttons: buttons.length,
        tops: buttons.map((rect) => Math.round(rect.top * 10) / 10),
        heights: buttons.map((rect) => Math.round(rect.height * 10) / 10),
        // How much of the ask line (who, what and the site) is scrolled out of view.
        askHidden: (() => {
          const ask = card.querySelector('.approval-ask');
          return ask === null ? 0 : ask.scrollHeight - ask.clientHeight;
        })(),
        overflow: Math.max(row === null ? 0 : row.scrollWidth - row.clientWidth, buttons.length === 0 ? 0 : buttons.at(-1).right - (box.right - Number.parseFloat(getComputedStyle(card).paddingRight))),
      });
    }
    // Every header, so a screen that draws its own instead of the panel's one bar is caught.
    for (const bar of document.querySelectorAll('header, [data-bar]')) {
      if (!shown(bar) || bar.closest('.composer, .popover') !== null) continue;
      const frame = bar.getBoundingClientRect();
      const controls = controlsOf(bar);
      if (controls.length === 0) continue;
      const first = controls[0];
      const last = controls.at(-1);
      // The glyph of each icon a control carries directly (a button's or the search field's icon), at its drawn size and stroke.
      const svgs = controls.map(({ element }) => (element.matches('button, label') ? element.querySelector(':scope > svg') : null)).filter((svg) => svg !== null);
      const glyphs = svgs.map((svg) => {
        const rect = svg.getBoundingClientRect();
        return Math.round(Math.max(rect.width, rect.height) * 10) / 10;
      });
      const strokes = svgs
        .map((svg) => {
          const style = getComputedStyle(svg.querySelector('path, line, polyline, rect, circle') ?? svg);
          return style.stroke === 'none' ? null : Math.round(Number.parseFloat(style.strokeWidth) * (svg.getScreenCTM()?.a ?? 1) * 100) / 100;
        })
        .filter((stroke) => stroke !== null);
      const boxes = controls.filter(({ element }) => element.matches('button, label')).map(({ element }) => element.getBoundingClientRect());
      const toggle = bar.querySelector(':scope > #btn-threads');
      const crumbs = bar.querySelector(':scope > .crumbs');
      const toggleInk = toggle === null ? null : window.__ink(toggle.querySelector('svg') ?? toggle);
      const crumbInk = crumbs === null ? null : window.__ink(crumbs);
      result.bars.push({
        bar: bar.className || bar.tagName.toLowerCase(),
        unified: bar.hasAttribute('data-bar'),
        first: name(first.element),
        last: name(last.element),
        height: Math.round(frame.height * 10) / 10,
        left: first.ink.left - frame.left,
        right: frame.right - last.ink.right,
        glyphs,
        strokes,
        heights: boxes.map((rect) => Math.round(rect.height * 10) / 10),
        centres: boxes.map((rect) => Math.round((rect.top + rect.height / 2) * 10) / 10),
        toggle: toggleInk === null ? null : toggleInk.left - frame.left,
        crumbLeft: crumbInk === null ? null : crumbInk.left - frame.left,
        // The crumb's text stands on its baseline (the ink's foot, see ink.mjs), measured from the bar's top.
        crumbBaseline: crumbInk === null ? null : crumbInk.bottom - frame.top,
      });
    }
    const form = document.querySelector('.composer');
    const row = document.querySelector('.composer-row');
    if (shown(form) && shown(row)) {
      const frame = form.getBoundingClientRect();
      // A picker is measured by its chip: its menu, open or not, floats over the row and is not part of it.
      const sizer = (element) => element.querySelector(':scope > .model-chip') ?? element;
      const controls = controlsOf(row).map(({ element }) => ({ element, ink: window.__ink(sizer(element)) })).filter((entry) => entry.ink !== null);
      const input = form.querySelector('.composer-input');
      // Each control's own glyph, at its drawn size and stroke weight: the icons, the send arrow and the model's logo.
      const glyphs = controls
        .map(({ element }) => element.querySelector('svg'))
        .filter((svg) => svg !== null)
        .map((svg) => {
          const line = svg.querySelector('path[stroke], path, line, polyline');
          const stroke = getComputedStyle(line ?? svg).strokeWidth;
          const strokeOn = getComputedStyle(line ?? svg).stroke !== 'none';
          return {
            size: Math.round(svg.getBoundingClientRect().width * 10) / 10,
            stroke: strokeOn ? Math.round(Number.parseFloat(stroke) * (svg.getScreenCTM()?.a ?? 1) * 100) / 100 : null,
          };
        });
      // The chip's own parts (its logo and its words) on the row's line too.
      const chip = row.querySelector('.model-chip');
      const parts = chip === null ? [] : [...chip.children].filter(shown).map((part) => window.__ink(part)).filter((ink) => ink !== null);
      result.composer = {
        controls: controls.map(({ element }) => name(element)),
        left: controls[0].ink.left - frame.left,
        right: frame.right - controls.at(-1).ink.right,
        foot: frame.bottom - controls.at(-1).ink.bottom,
        centres: [...controls.map(({ ink }) => (ink.top + ink.bottom) / 2), ...parts.map((ink) => (ink.top + ink.bottom) / 2)].map((value) => Math.round(value * 10) / 10),
        heights: controls.map(({ element }) => Math.round(sizer(element).getBoundingClientRect().height * 10) / 10),
        text: input === null ? null : window.__ink(input)?.left - frame.left,
        glyphs: glyphs.map((glyph) => glyph.size),
        strokes: glyphs.map((glyph) => glyph.stroke).filter((stroke) => stroke !== null),
      };
    }
    const heading = document.querySelector('.hero h1');
    const line = document.querySelector('.hero .hero-picker > button');
    if (shown(heading) && shown(line)) {
      const a = window.__ink(heading);
      const b = window.__ink(line);
      result.hero = { heading: heading.textContent, line: line.textContent, headingCentre: (a.left + a.right) / 2, lineCentre: (b.left + b.right) / 2 };
    }
    return result;
  });
}

const fixed = (value) => (typeof value === 'number' ? value.toFixed(1) : String(value));
const spread = (values) => (values.length === 0 ? 0 : Math.max(...values) - Math.min(...values));

/** What is wrong on this screen, one line each. */
function problems(screen, found) {
  const out = [];
  for (const bar of found.bars) {
    const where = `${screen}: bar .${bar.bar.split(' ')[0]}`;
    if (!bar.unified) out.push(`${where}: a top bar that is not the panel's one bar ([data-bar])`);
    if (spread(bar.strokes) > 0.25) out.push(`${where}: icon strokes of ${bar.strokes.join(' / ')} px`);
    if (Math.abs(bar.left - bar.right) > TOLERANCE) out.push(`${where}: ink insets ${fixed(bar.left)} (${bar.first}) vs ${fixed(bar.right)} (${bar.last}) px`);
    if (spread(bar.glyphs) > TOLERANCE) out.push(`${where}: icon glyphs of ${bar.glyphs.join(' / ')} px`);
    if (spread(bar.heights) > TOLERANCE) out.push(`${where}: control heights ${bar.heights.join(' / ')} px`);
    if (spread(bar.centres) > TOLERANCE) out.push(`${where}: control centres ${bar.centres.join(' / ')}`);
  }
  if (found.composer !== null) {
    const { composer } = found;
    const where = `${screen}: composer`;
    if (Math.abs(composer.left - composer.right) > TOLERANCE) out.push(`${where}: ink insets ${fixed(composer.left)} (${composer.controls[0]}) vs ${fixed(composer.right)} (${composer.controls.at(-1)}) px`);
    if (Math.abs(composer.foot - composer.right) > TOLERANCE) out.push(`${where}: ${composer.controls.at(-1)} ${fixed(composer.foot)} px from the foot, ${fixed(composer.right)} px from the side`);
    if (spread(composer.centres) > TOLERANCE) out.push(`${where}: ink centres ${composer.centres.join(' / ')} (${composer.controls.join(', ')}, then the chip's logo and words)`);
    if (spread(composer.heights) > TOLERANCE) out.push(`${where}: control heights ${composer.heights.join(' / ')} px`);
    if (composer.text !== null && Math.abs(composer.text - composer.left) > TOLERANCE) out.push(`${where}: text starts at ${fixed(composer.text)} px, the first control's ink at ${fixed(composer.left)} px`);
    if (spread(composer.glyphs) > TOLERANCE) out.push(`${where}: glyphs of ${composer.glyphs.join(' / ')} px`);
    if (spread(composer.strokes) > 0.25) out.push(`${where}: glyph strokes of ${composer.strokes.join(' / ')} px`);
  }
  for (const [index, card] of found.approvals.entries()) {
    const where = `${screen}: ${card.kind} approval card ${index + 1}`;
    if (card.height > CARD_MAX) out.push(`${where}: ${fixed(card.height)} px tall, over ${CARD_MAX}`);
    if (card.buttons !== 3) out.push(`${where}: ${card.buttons} answer buttons, expected Decline, the primary answer and More`);
    if (spread(card.tops) > TOLERANCE) out.push(`${where}: answers on more than one row (tops ${card.tops.join(' / ')})`);
    if (card.heights.some((height) => Math.abs(height - ANSWER_HEIGHT) > TOLERANCE)) out.push(`${where}: answer heights ${card.heights.join(' / ')} px, a label wrapped`);
    if (card.overflow > 0.5) out.push(`${where}: answers run ${fixed(card.overflow)} px past the card`);
  }
  if (found.hero !== null && Math.abs(found.hero.headingCentre - found.hero.lineCentre) > TOLERANCE) {
    out.push(`${screen}: "${found.hero.line}" ink centre ${fixed(found.hero.lineCentre)} vs heading "${found.hero.heading}" ${fixed(found.hero.headingCentre)}`);
  }
  return out;
}

/** What is wrong with the page as it stands, at its current width and scheme. */
export async function layoutProblems(page, screen) {
  return problems(screen, await measure(page));
}

/**
 * The bars of every screen walked, at one width and scheme, against each other: one height, first and last ink at the
 * same insets, one icon size and stroke weight, the thread toggle's ink in one place, and the breadcrumb's text in one
 * place (its left edge after the toggle, or at the inset where a bar has none, and one baseline for all).
 */
function barProblems(where, bars) {
  const out = [];
  const across = (label, values, tolerance = TOLERANCE) => {
    const present = values.filter((entry) => entry.value !== null && entry.value !== undefined);
    if (spread(present.map((entry) => entry.value)) > tolerance) out.push(`${where}: bars differ in ${label}: ${present.map((entry) => `${entry.screen} ${fixed(entry.value)}`).join(', ')}`);
  };
  across('height', bars.map(({ screen, bar }) => ({ screen, value: bar.height })));
  across('first ink inset', bars.map(({ screen, bar }) => ({ screen, value: bar.left })));
  across('last ink inset', bars.map(({ screen, bar }) => ({ screen, value: bar.right })));
  across('icon size', bars.flatMap(({ screen, bar }) => bar.glyphs.map((value) => ({ screen, value }))));
  across('icon stroke', bars.flatMap(({ screen, bar }) => bar.strokes.map((value) => ({ screen, value }))), 0.25);
  across('thread toggle ink', bars.map(({ screen, bar }) => ({ screen, value: bar.toggle })));
  across('breadcrumb start after the toggle', bars.filter(({ bar }) => bar.toggle !== null).map(({ screen, bar }) => ({ screen, value: bar.crumbLeft })));
  across('breadcrumb start without a toggle', bars.filter(({ bar }) => bar.toggle === null).map(({ screen, bar }) => ({ screen, value: bar.crumbLeft })));
  across('breadcrumb baseline', bars.map(({ screen, bar }) => ({ screen, value: bar.crumbBaseline })));
  return out;
}

/** Measures one screen at every width and scheme; returns its problems, how many things it measured and its bars. */
async function checkScreen(page, screen, shotsDir, bars, expect) {
  const failures = [];
  let measured = 0;
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 760 });
    for (const scheme of SCHEMES) {
      await page.emulateMedia({ colorScheme: scheme });
      // Off every control, so no hover state is measured.
      await page.mouse.move(width - 1, 759);
      await sleep(250);
      const found = await measure(page);
      measured += found.bars.length + (found.composer === null ? 0 : 1) + (found.hero === null ? 0 : 1) + found.approvals.length;
      const key = `@${width} ${scheme}`;
      bars[key] ??= [];
      for (const bar of found.bars) bars[key].push({ screen, bar });
      failures.push(...problems(`${screen} @${width} ${scheme}`, found));
      if (expect?.approvals !== undefined && found.approvals.length !== expect.approvals) failures.push(`${screen} @${width} ${scheme}: ${found.approvals.length} approval cards, expected ${expect.approvals}`);
      // Which composer controls the screen draws: Stop in a running composer, the mic only where T3 can transcribe.
      for (const label of expect?.controls ?? []) if (!found.composer?.controls.includes(label)) failures.push(`${screen} @${width} ${scheme}: the composer has no "${label}" (it has ${found.composer?.controls.join(', ') ?? 'nothing'})`);
      for (const label of expect?.without ?? []) if (found.composer?.controls.some((control) => control.startsWith(label))) failures.push(`${screen} @${width} ${scheme}: the composer draws "${label}", which cannot work here`);
      if (shotsDir !== undefined) await page.screenshot({ path: join(shotsDir, `layout-${screen}-${width}-${scheme}.png`), animations: 'disabled' });
    }
  }
  return { failures, measured };
}

/**
 * Browser prompts on the new-thread screen, drawn from supplied state on the headless panel: an act prompt on this tab,
 * a JavaScript prompt (the longest once answer) on another tab, and a goto on another tab with a long address. Each card is
 * measured like every card; the hero and the composer must stay where they were without cards, and no card may cover
 * the composer.
 */
async function checkPromptOverlay(page, shotsDir) {
  const failures = [];
  let measured = 0;
  const session = { id: 'layout-session', name: 'Claude Code' };
  const tab = { id: 4242, title: 'Cable Shop – USB-C cables, braided and basic, every length in stock' };
  const pending = [
    { id: 'layout-act', origin: 'http://127.0.0.1:41889', tool: 'act', session, tab },
    { id: 'layout-js', origin: 'https://checkout.example-shop.test:8443', tool: 'run_js', session, tab: { id: 4343, title: 'Checkout' } },
    // A goto on another tab: the longest card, with the address, the tab it moves and Go to tab.
    { id: 'layout-goto', origin: 'https://docs.example.test', tool: 'open', session, tab: { id: 4545, title: 'Payments guide – retries and backoff for webhooks' }, url: 'https://docs.example.test/guides/payments/webhooks/retries?section=backoff&lang=en-GB#exponential' },
  ];
  const show = async (prompts) => await page.evaluate((next) => globalThis.__t3tabRenderPanelState(next), { currentTab: { id: 4242, title: tab.title, url: 'http://127.0.0.1:41889/' }, pending: prompts, sites: [] });
  const place = async () =>
    await page.evaluate(() => {
      const rect = (selector) => document.querySelector(selector)?.getBoundingClientRect() ?? null;
      const heading = rect('.hero h1');
      const composer = rect('.composer');
      const cards = [...document.querySelectorAll('.prompt-list .approval-card')].map((card) => card.getBoundingClientRect().bottom);
      return { heading: heading?.top ?? null, composer: composer?.top ?? null, lowestCard: cards.length === 0 ? null : Math.max(...cards) };
    });
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 760 });
    for (const scheme of SCHEMES) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.mouse.move(width - 1, 759);
      await show([]);
      await page.locator('.hero h1').waitFor();
      await sleep(250);
      const before = await place();
      await show(pending);
      await page.locator('.prompt-list .approval-card').first().waitFor();
      await sleep(600);
      const after = await place();
      const where = `prompts-new-thread @${width} ${scheme}`;
      if (before.heading === null || before.composer === null) failures.push(`${where}: the new-thread screen has no hero or composer`);
      else {
        if (Math.abs((after.heading ?? Number.NaN) - before.heading) > TOLERANCE || Number.isNaN(after.heading - before.heading)) failures.push(`${where}: the heading moved from ${fixed(before.heading)} to ${fixed(after.heading)}`);
        if (Math.abs((after.composer ?? Number.NaN) - before.composer) > TOLERANCE || Number.isNaN(after.composer - before.composer)) failures.push(`${where}: the composer moved from ${fixed(before.composer)} to ${fixed(after.composer)}`);
        if (after.lowestCard !== null && after.composer !== null && after.lowestCard > after.composer + 0.5) failures.push(`${where}: a card reaches ${fixed(after.lowestCard)}, over the composer at ${fixed(after.composer)}`);
      }
      const found = await measure(page);
      if (found.approvals.length !== pending.length) failures.push(`${where}: ${found.approvals.length} cards drawn, expected ${pending.length}`);
      measured += found.approvals.length;
      failures.push(...problems(where, { ...found, bars: [], composer: null, hero: null }));
      for (const [index, card] of found.approvals.entries()) if (card.askHidden > 1) failures.push(`${where}: card ${index + 1} hides ${card.askHidden} px of its ask line, the site among it`);
      if (shotsDir !== undefined) await page.screenshot({ path: join(shotsDir, `layout-prompts-new-thread-${width}-${scheme}.png`), animations: 'disabled' });
    }
  }
  await show([]);
  await page.setViewportSize({ width: 360, height: 800 });
  await page.emulateMedia({ colorScheme: 'light' });
  return { failures, measured };
}

/**
 * Walks the panel's screens on a live panel page and checks each. T3 is not signed in here, so its new-thread hero is
 * drawn from a T3 state handed to the panel's client, as the thread-list check hands it threads.
 */
export async function checkLayout({ livePanel, serviceWorker, panelPage, screenshotPath }) {
  const page = livePanel;
  const shotsDir = screenshotPath === undefined ? undefined : dirname(screenshotPath);
  const failures = [];
  const counts = {};
  const bars = {};
  const run = async (screen, expect) => {
    const { failures: found, measured } = await checkScreen(page, screen, shotsDir, bars, expect);
    counts[screen] = measured;
    failures.push(...found);
  };
  await page.keyboard.press('Escape');
  const home = async () => {
    if (await page.locator('#btn-new').isEnabled()) await page.locator('#btn-new').click();
    await page.locator('.hero h1').waitFor();
  };

  await home();
  // Without T3 the mic cannot record, so it is not drawn (as T3 Code's composer leaves it out), and the row is three controls.
  await run('home-direct', { controls: ['Attach files', 'Send'], without: ['Start voice input', 'Voice input'] });
  await page.locator('.model-chip').first().click();
  await page.locator('.model-popover').waitFor();
  await run('model-picker');
  await page.keyboard.press('Escape');

  // T3's hero: "No project" under the heading, then a project with the way back to no project.
  await page.evaluate(() => {
    const client = window.__t3tabT3;
    client.set({ status: 'ready' });
    client.onConfig({
      type: 'snapshot',
      config: {
        providers: [{ instanceId: 'claudeAgent', driver: 'claudeAgent', enabled: true, installed: true, status: 'ready', models: [{ slug: 'claude-opus-5-5', name: 'Claude Opus 5.5', isDefault: true }] }],
        scratchWorkspaceRoot: '/tmp/layout-scratch',
        settings: {},
        environment: { label: 'layout-machine', platform: { machine: 'desktop' }, capabilities: { voiceTranscription: true } },
      },
    });
    client.onShell({ kind: 'snapshot', snapshot: { threads: [], projects: [{ id: 'layout-project', title: 'virtus-umbrella', workspaceRoot: '/tmp/virtus-umbrella' }] } });
  });
  await page.locator('.hero .inline-picker, .hero .project-btn').filter({ hasText: 'No project' }).waitFor();
  // T3 can transcribe here, so the row has the mic as well: paperclip, model, mic and send on one centre line.
  await run('home-t3-no-project', { controls: ['Attach files', 'Start voice input', 'Send'] });
  await page.locator('.hero-picker > button').click();
  await page.locator('.project-popover').getByText('virtus-umbrella').click();
  await page.locator('.hero-picker > button').filter({ hasText: 'virtus-umbrella' }).waitFor();
  await run('home-t3-project');
  await page.locator('.hero-picker > button').click();
  await run('project-picker');
  await page.keyboard.press('Escape');

  // A T3 thread waiting on an approval: drawn at its row in the running work log, as T3 does, and above the composer when
  // that row is not shown. The thread is handed to the panel's T3 client as the thread-list check hands it threads.
  await page.evaluate(() => {
    const client = window.__t3tabT3;
    const at = new Date(Date.now() - 600_000).toISOString();
    client.onShell({
      kind: 'snapshot',
      snapshot: {
        threads: [{ id: 'layout-approval', projectId: 'layout-project', title: 'Pick a colour', status: 'running', interactionMode: 'default', createdAt: at, updatedAt: at, latestRunId: 'run-a', latestRunRequestedAt: at, latestRunStartedAt: at, latestRunCompletedAt: null, activeRunId: 'run-a', activityRunStatus: 'waiting', pendingRuntimeRequest: { id: 'r1', kind: 'approval', createdAt: at }, lineage: { relationshipToParent: null, parentThreadId: null }, archivedAt: null, settledOverride: null, settledAt: null }],
        projects: [{ id: 'layout-project', title: 'virtus-umbrella', workspaceRoot: '/tmp/virtus-umbrella' }],
      },
    });
    const command = 'pnpm exec vitest run --reporter=verbose packages/extension/test/panel-approval.test.ts && pnpm build';
    // The thread is drawn idle (running: false) so its composer shows send, as on every other measured screen; its work
    // row still runs, which is where the approval waits.
    window.__layoutApproval = (inline) => ({
      id: 'layout-approval', source: 't3', title: 'Pick a colour', running: false, failed: false, queued: [], activeRunId: 'run-a', runtimeMode: 'approval-required', projectId: 'layout-project',
      rows: [
        { kind: 'user', id: 'u1', text: 'Restyle the checkout button and check the build', at: Date.now() - 120_000 },
        { kind: 'work', id: 'w1', running: true, startedAt: Date.now() - 100_000, entries: [{ id: 'e1', icon: 'edit', label: 'Edited checkout.css', status: 'done' }, { id: 'e2', icon: 'approval', label: 'Waiting for approval', status: 'waiting' }] },
      ],
      approval: { requestId: 'r1', responseCapability: 'live', ...(inline ? { entryId: 'e2' } : {}), kind: 'command', title: command, detail: 'in /tmp/virtus-umbrella', options: [{ decision: 'decline', label: 'Decline' }, { decision: 'acceptForSession', label: 'Always allow this session' }, { decision: 'accept', label: 'Approve' }] },
    });
    client.watches.set('layout-approval', { listeners: new Set(), view: window.__layoutApproval(true), stop() {} });
  });
  await page.locator('#btn-threads').click();
  await page.locator('.thread-row').filter({ hasText: 'Pick a colour' }).first().click();
  await page.locator('.work-entries .approval-card.inline').waitFor();
  await run('approval-inline', { approvals: 1 });
  await page.evaluate(() => {
    const watch = window.__t3tabT3.watches.get('layout-approval');
    watch.view = window.__layoutApproval(false);
    for (const listener of watch.listeners) listener(watch.view);
  });
  await page.locator('.dock .approval-card.dock').waitFor();
  await run('approval-dock', { approvals: 1 });
  // A running thread: the composer's Stop stands where send does and is drawn at the other icons' size.
  await page.evaluate(() => {
    const watch = window.__t3tabT3.watches.get('layout-approval');
    watch.view = { ...window.__layoutApproval(false), running: true };
    delete watch.view.approval;
    for (const listener of watch.listeners) listener(watch.view);
  });
  await page.locator('.composer-row .send-btn.stop').waitFor();
  await run('thread-running', { controls: ['Attach files', 'Start voice input', 'Stop'], without: ['Send'] });
  await page.evaluate(() => {
    window.__t3tabT3.watches.delete('layout-approval');
    delete window.__layoutApproval;
  });
  await home();
  await page.evaluate(() => {
    const client = window.__t3tabT3;
    client.onShell({ kind: 'snapshot', snapshot: { threads: [], projects: [] } });
    client.onConfig({ type: 'snapshot', config: { providers: [], settings: {}, environment: { capabilities: {} } } });
    client.set({ status: 'off' });
  });
  await serviceWorker.evaluate(() => chrome.storage.local.remove(['composer.project']));

  await page.locator('#btn-threads').click();
  await page.locator('.list-search').waitFor();
  await run('threads');
  await page.keyboard.press('Escape');

  if ((await page.locator('#btn-threads').count()) > 0) {
    await page.locator('#btn-threads').click();
    const row = page.locator('.thread-row').first();
    if ((await row.count()) > 0) {
      await row.click();
      await page.locator('.screen[data-thread-id]').waitFor();
      await run('thread');
    } else await page.keyboard.press('Escape');
  }

  await page.locator('#btn-settings').click();
  await page.locator('.settings-tabs').waitFor();
  await run('settings');
  await page.locator('.settings-tabs button').filter({ hasText: 'Sites' }).click();
  await run('settings-sites');
  await page.locator('.settings-tabs button').filter({ hasText: 'General' }).click();
  await page.locator('.theme-trigger').click();
  const create = page.locator('.theme-popover').getByRole('button', { name: 'Create theme' });
  if ((await create.count()) > 0) {
    await create.click();
    await page.locator('.sheet [data-bar]').waitFor();
    await run('theme-sheet');
    await page.locator('.sheet [data-bar]').getByRole('button', { name: 'Close' }).click();
  }
  await page.locator('#btn-settings-back').click();
  await page.setViewportSize({ width: 360, height: 800 });
  await page.emulateMedia({ colorScheme: 'light' });

  // The prompt cards are drawn on the headless panel, which is not one of the screens walked above, so they are counted on
  // their own and the walked screens' one-bar check does not include it.
  let promptCards = 0;
  if (panelPage !== undefined) {
    const { failures: found, measured } = await checkPromptOverlay(panelPage, shotsDir);
    promptCards = measured;
    assert(measured > 0, 'The layout check measured no prompt cards on the new-thread screen');
    failures.push(...found);
    await panelPage.evaluate((next) => globalThis.__t3tabRenderPanelState(next), await panelRequest(serviceWorker, { type: 'panel.state' }));
  }

  const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
  for (const [screen, count] of Object.entries(counts)) assert(count > 0, `The layout check measured nothing on ${screen}`);
  // Every screen walked has the one bar, and the bars agree with each other at each width and scheme.
  for (const screen of Object.keys(counts)) {
    for (const [key, list] of Object.entries(bars)) {
      if (!list.some((entry) => entry.screen === screen && entry.bar.unified)) failures.push(`${screen} ${key}: no top bar ([data-bar])`);
    }
  }
  for (const [key, list] of Object.entries(bars)) failures.push(...barProblems(key, list));
  const barCount = Object.values(bars).reduce((sum, list) => sum + list.length, 0);
  assert(failures.length === 0, `Panel layout, measured on its ink (${failures.length} problems):\n${failures.join('\n')}`);
  console.log(`Panel layout: ${total} bars, composers, heroes and approval cards measured on ${Object.keys(counts).length} screens at ${WIDTHS.join('/')} px, light and dark (and ${promptCards} prompt cards on the headless new-thread screen); ink insets, centre lines, control sizes and glyph sizes within ${TOLERANCE} px; the ${barCount} top bars are the one bar and agree across screens in height, insets, icon size and stroke, toggle and breadcrumb position; approval cards at most ${CARD_MAX} px with one row of answers, and prompts on the new-thread screen move neither the hero nor the composer`);
}
