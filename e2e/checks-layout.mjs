// The panel's layout as people see it: every check here measures visible ink (SVG strokes and fills, text glyphs from
// the font's own metrics, painted boxes; see ./ink.mjs), never padding boxes, on each screen at 320, 360 and 400 px in
// light and dark. It fails when
// - a bar's (or the composer row's) first and last controls sit at different ink distances from its edges,
// - the composer's bottom-row controls do not stand on one ink line, or its text does not start on the paperclip's,
// - the new-thread hero's project line is off the heading's centre,
// - the icon glyphs of one bar, or the bare icons of the composer row, are drawn at different sizes,
// by more than 1 px.
import { dirname, join } from 'node:path';

import { assert, sleep } from './harness.mjs';
import { installInkSource } from './ink.mjs';

const WIDTHS = [320, 360, 400];
const SCHEMES = ['light', 'dark'];
const TOLERANCE = 1;

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
    const result = { bars: [], composer: null, hero: null };
    for (const bar of document.querySelectorAll('.topbar, .sheet-head')) {
      if (!shown(bar)) continue;
      const frame = bar.getBoundingClientRect();
      const controls = controlsOf(bar);
      if (controls.length === 0) continue;
      const first = controls[0];
      const last = controls.at(-1);
      // The glyph of each icon a control carries directly (a button's or the search field's icon), at its drawn size.
      const glyphs = controls
        .map(({ element }) => (element.matches('button, label') ? element.querySelector(':scope > svg') : null))
        .filter((svg) => svg !== null)
        .map((svg) => {
          const rect = svg.getBoundingClientRect();
          return Math.round(Math.max(rect.width, rect.height) * 10) / 10;
        });
      const boxes = controls.filter(({ element }) => element.matches('button, label')).map(({ element }) => element.getBoundingClientRect());
      result.bars.push({
        bar: bar.className,
        first: name(first.element),
        last: name(last.element),
        left: first.ink.left - frame.left,
        right: frame.right - last.ink.right,
        glyphs,
        heights: boxes.map((rect) => Math.round(rect.height * 10) / 10),
        centres: boxes.map((rect) => Math.round((rect.top + rect.height / 2) * 10) / 10),
      });
    }
    const form = document.querySelector('.composer');
    const row = document.querySelector('.composer-row');
    if (shown(form) && shown(row)) {
      const frame = form.getBoundingClientRect();
      const controls = controlsOf(row);
      const input = form.querySelector('.composer-input');
      // A bare icon button: no painted background of its own (the send button's circle is its own ink).
      const unpainted = (element) => {
        const parts = getComputedStyle(element).backgroundColor.match(/rgba?\(([^)]+)\)/)?.[1].split(/[ ,/]+/).filter(Boolean) ?? [];
        return parts.length === 4 && Number(parts[3]) === 0;
      };
      const bare = controls
        .filter(({ element }) => element.matches('button') && unpainted(element))
        .map(({ element }) => element.querySelector(':scope > svg'))
        .filter((svg) => svg !== null)
        .map((svg) => Math.round(svg.getBoundingClientRect().width * 10) / 10);
      result.composer = {
        controls: controls.map(({ element }) => name(element)),
        left: controls[0].ink.left - frame.left,
        right: frame.right - controls.at(-1).ink.right,
        bottoms: controls.map(({ ink }) => Math.round(ink.bottom * 10) / 10),
        text: input === null ? null : window.__ink(input)?.left - frame.left,
        glyphs: bare,
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
    if (Math.abs(bar.left - bar.right) > TOLERANCE) out.push(`${where}: ink insets ${fixed(bar.left)} (${bar.first}) vs ${fixed(bar.right)} (${bar.last}) px`);
    if (spread(bar.glyphs) > TOLERANCE) out.push(`${where}: icon glyphs of ${bar.glyphs.join(' / ')} px`);
    if (spread(bar.heights) > TOLERANCE) out.push(`${where}: control heights ${bar.heights.join(' / ')} px`);
    if (spread(bar.centres) > TOLERANCE) out.push(`${where}: control centres ${bar.centres.join(' / ')}`);
  }
  if (found.composer !== null) {
    const { composer } = found;
    const where = `${screen}: composer`;
    if (Math.abs(composer.left - composer.right) > TOLERANCE) out.push(`${where}: ink insets ${fixed(composer.left)} (${composer.controls[0]}) vs ${fixed(composer.right)} (${composer.controls.at(-1)}) px`);
    if (spread(composer.bottoms) > TOLERANCE) out.push(`${where}: ink bottoms ${composer.bottoms.join(' / ')} (${composer.controls.join(', ')})`);
    if (composer.text !== null && Math.abs(composer.text - composer.left) > TOLERANCE) out.push(`${where}: text starts at ${fixed(composer.text)} px, the first control's ink at ${fixed(composer.left)} px`);
    if (spread(composer.glyphs) > TOLERANCE) out.push(`${where}: bare icon glyphs of ${composer.glyphs.join(' / ')} px`);
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

/** Measures one screen at every width and scheme; returns its problems and how many things it measured. */
async function checkScreen(page, screen, shotsDir) {
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
      measured += found.bars.length + (found.composer === null ? 0 : 1) + (found.hero === null ? 0 : 1);
      failures.push(...problems(`${screen} @${width} ${scheme}`, found));
      if (shotsDir !== undefined) await page.screenshot({ path: join(shotsDir, `layout-${screen}-${width}-${scheme}.png`), animations: 'disabled' });
    }
  }
  return { failures, measured };
}

/**
 * Walks the panel's screens on a live panel page and checks each. T3 is not signed in here, so its new-thread hero is
 * drawn from a T3 state handed to the panel's client, as the thread-list check hands it threads.
 */
export async function checkLayout({ livePanel, serviceWorker, screenshotPath }) {
  const page = livePanel;
  const shotsDir = screenshotPath === undefined ? undefined : dirname(screenshotPath);
  const failures = [];
  const counts = {};
  const run = async (screen) => {
    const { failures: found, measured } = await checkScreen(page, screen, shotsDir);
    counts[screen] = measured;
    failures.push(...found);
  };
  await page.keyboard.press('Escape');
  const home = async () => {
    if (await page.locator('#btn-new').isEnabled()) await page.locator('#btn-new').click();
    await page.locator('.hero h1').waitFor();
  };

  await home();
  await run('home-direct');
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
        environment: { label: 'layout-machine', platform: { machine: 'desktop' }, capabilities: {} },
      },
    });
    client.onShell({ kind: 'snapshot', snapshot: { threads: [], projects: [{ id: 'layout-project', title: 'virtus-umbrella', workspaceRoot: '/tmp/virtus-umbrella' }] } });
  });
  await page.locator('.hero .inline-picker, .hero .project-btn').filter({ hasText: 'No project' }).waitFor();
  await run('home-t3-no-project');
  await page.locator('.hero-picker > button').click();
  await page.locator('.project-popover').getByText('virtus-umbrella').click();
  await page.locator('.hero-picker > button').filter({ hasText: 'virtus-umbrella' }).waitFor();
  await run('home-t3-project');
  await page.locator('.hero-picker > button').click();
  await run('project-picker');
  await page.keyboard.press('Escape');
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
  const create = page.getByRole('button', { name: 'Create theme' });
  if ((await create.count()) > 0) {
    await create.click();
    await page.locator('.sheet-head').waitFor();
    await run('theme-sheet');
    await page.locator('.sheet-head').getByRole('button', { name: 'Close' }).click();
  }
  await page.locator('#btn-settings-back').click();
  await page.setViewportSize({ width: 360, height: 800 });
  await page.emulateMedia({ colorScheme: 'light' });

  const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
  for (const [screen, count] of Object.entries(counts)) assert(count > 0, `The layout check measured nothing on ${screen}`);
  assert(failures.length === 0, `Panel layout, measured on its ink (${failures.length} problems):\n${failures.join('\n')}`);
  console.log(`Panel layout: ${total} bars, composers and heroes measured on ${Object.keys(counts).length} screens at ${WIDTHS.join('/')} px, light and dark; ink insets, bottoms, centres and glyph sizes within ${TOLERANCE} px`);
}
