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
// - the theme sheet does not open on the colour scheme in force, in the panel's own palette (see `themeSheetProblems`), or
// - an approval card (a browser prompt or a T3 approval) is more than 160 px tall, its answers are not on one row of
//   one-line buttons inside the card, or a card on the new-thread screen moves the hero or the composer or covers it.
// - the new-thread screen's setup card (helper missing) or Connect row (T3 Code running, not connected) is not in the
//   composer's column above it and below the heading, cuts off any of its content, is over 260 px tall, or, for the
//   Connect row, is more than one line or 42 px;
// - the new-thread heading sits at different heights on the states it walks at one width and scheme (direct, a draft
//   that wraps, the setup card with and without a draft, the Connect row, T3 with no project, with a project, with its
//   picker open and reconnecting with the banner) by more than 1 px, or asks anything but T3's two questions: "What
//   should we build?" in a project and "What should we work on?" everywhere else.
import { dirname, join } from 'node:path';

import { assert, panelRequest, sleep } from './harness.mjs';
import { installInkSource } from './ink.mjs';

const WIDTHS = [320, 360, 400];
const SCHEMES = ['light', 'dark'];
const TOLERANCE = 1;
const CARD_MAX = 160;
const ANSWER_HEIGHT = 28;
/**
 * The tallest the new-thread screen's setup card may be, and the Connect row. The card is tallest at 320 px with the test
 * build's install command, which wraps to five lines there (246 px measured); the product's command is one line.
 */
const SETUP_CARD_MAX = 260;
const CONNECT_ROW_MAX = 42;

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
    const result = { bars: [], composer: null, hero: null, heading: null, approvals: [] };
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
    if (shown(heading)) result.heading = { text: heading.textContent, top: heading.getBoundingClientRect().top };
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

/** The roles the panel draws its surfaces, lines and text with; a sheet that opens in another palette has changed one. */
const SHEET_ROLES = ['--app-theme-canvas', '--app-theme-surface', '--app-theme-surface-raised', '--app-theme-border', '--app-theme-text', '--app-theme-muted-foreground', '--app-theme-message-action'];

/**
 * The theme sheet, opened in each colour scheme from Settings: it opens on that scheme (its Light or Dark tab is the one
 * picked, and the page is drawn in that scheme), and it opens in the panel's own palette, so none of the panel's roles
 * differ from a moment before and its fields are painted with the panel's surface and border, not a tint of their own.
 * Picking the other scheme's tab then draws that scheme, which is the preview, and picking the first again restores it.
 */
async function themeSheetProblems(page) {
  const out = [];
  const roles = async () =>
    await page.evaluate((names) => {
      const probe = document.createElement('div');
      document.body.append(probe);
      const resolve = (css) => {
        probe.style.background = css;
        return getComputedStyle(probe).backgroundColor;
      };
      const values = Object.fromEntries(names.map((name) => [name, resolve(`var(${name})`)]));
      probe.remove();
      return { values, dark: document.documentElement.classList.contains('dark') };
    }, SHEET_ROLES);
  await page.setViewportSize({ width: 360, height: 800 });
  for (const scheme of SCHEMES) {
    const where = `theme sheet in ${scheme}`;
    await page.emulateMedia({ colorScheme: scheme });
    await sleep(200);
    const before = await roles();
    await page.locator('.theme-trigger').click();
    await page.locator('.theme-popover').getByRole('button', { name: 'Create theme' }).click();
    await page.locator('.sheet [data-bar]').waitFor();
    await sleep(200);
    const label = scheme === 'dark' ? 'Dark' : 'Light';
    const checked = await page.locator('.sheet [role="radio"][aria-checked="true"]').allInnerTexts();
    if (checked.length !== 1 || checked[0].trim() !== label) out.push(`${where}: opens on the ${checked.join('/') || 'no'} tab, expected ${label}`);
    const opened = await roles();
    if (opened.dark !== (scheme === 'dark')) out.push(`${where}: the page is drawn ${opened.dark ? 'dark' : 'light'}`);
    for (const name of SHEET_ROLES) if (opened.values[name] !== before.values[name]) out.push(`${where}: ${name} ${before.values[name]} before, ${opened.values[name]} once it opens`);
    // Its fields and its page use the panel's own roles: the field's fill is the surface, its edge the border, the sheet the canvas.
    const painted = await page.evaluate(() => {
      const probe = document.createElement('div');
      document.body.append(probe);
      const resolve = (css) => {
        probe.style.background = css;
        return getComputedStyle(probe).backgroundColor;
      };
      const field = getComputedStyle(document.querySelector('.sheet .field input'));
      const result = { field: field.backgroundColor, fieldWant: resolve('var(--surface)'), edge: field.borderTopColor, edgeWant: resolve('var(--line)'), sheet: getComputedStyle(document.querySelector('.sheet')).backgroundColor, sheetWant: resolve('var(--bg)') };
      probe.remove();
      return result;
    });
    if (painted.field !== painted.fieldWant) out.push(`${where}: its fields are ${painted.field}, not the panel's surface ${painted.fieldWant}`);
    if (painted.edge !== painted.edgeWant) out.push(`${where}: its fields' edge is ${painted.edge}, not the panel's border ${painted.edgeWant}`);
    if (painted.sheet !== painted.sheetWant) out.push(`${where}: the sheet is ${painted.sheet}, not the panel's canvas ${painted.sheetWant}`);
    // The other tab previews the other scheme, and the first tab brings this one back.
    const other = scheme === 'dark' ? 'Light' : 'Dark';
    await page.locator('.sheet [role="radio"]').filter({ hasText: other }).click();
    await sleep(150);
    if ((await roles()).dark !== (scheme !== 'dark')) out.push(`${where}: the ${other} tab does not draw ${other.toLowerCase()}`);
    await page.locator('.sheet [role="radio"]').filter({ hasText: label }).click();
    await sleep(150);
    const back = await roles();
    for (const name of SHEET_ROLES) if (back.values[name] !== before.values[name]) out.push(`${where}: back on the ${label} tab ${name} is ${back.values[name]}, not ${before.values[name]}`);
    await page.locator('.sheet [data-bar]').getByRole('button', { name: 'Close' }).click();
    await sleep(150);
    const after = await roles();
    for (const name of SHEET_ROLES) if (after.values[name] !== before.values[name]) out.push(`${where}: after closing, ${name} is ${after.values[name]}, not ${before.values[name]}`);
  }
  return out;
}

/**
 * The new-thread screen's setup card and Connect row: the kinds expected and no others, each in the composer's column and
 * above it, clear of the heading, nothing in it cut off or scrolled sideways; the card at most SETUP_CARD_MAX px tall, and
 * the Connect row one line of text with its button on that line, at most CONNECT_ROW_MAX px.
 */
async function setupCardProblems(page, where, kinds) {
  const out = [];
  const found = await page.evaluate(() => {
    const rect = (element) => {
      const box = element?.getBoundingClientRect();
      return box === undefined ? null : { top: box.top, bottom: box.bottom, left: box.left, right: box.right, height: box.height };
    };
    const composer = rect(document.querySelector('.composer'));
    const heading = rect(document.querySelector('.hero h1'));
    const cards = [...document.querySelectorAll('.setup-card')].map((card) => {
      const line = card.querySelector('.setup-card-line');
      const button = card.querySelector('button');
      return {
        kind: card.classList.contains('connect-row') ? 'connect' : 'helper',
        box: rect(card),
        cut: [card, ...card.querySelectorAll('*')].some((element) => element.scrollWidth > element.clientWidth + 1 && getComputedStyle(element).overflowX !== 'visible' && element !== line),
        lineRects: line === null ? 0 : line.getClientRects().length,
        lineCut: line === null ? false : line.scrollWidth > line.clientWidth + 1,
        button: rect(button),
        lineBox: rect(line),
      };
    });
    return { composer, heading, cards };
  });
  const got = found.cards.map((card) => card.kind);
  if (JSON.stringify(got) !== JSON.stringify(kinds)) out.push(`${where}: setup cards ${got.join(', ') || 'none'}, expected ${kinds.join(', ')}`);
  for (const card of found.cards) {
    const name = `${where}: the ${card.kind === 'connect' ? 'Connect row' : 'setup card'}`;
    if (found.composer !== null) {
      if (Math.abs(card.box.left - found.composer.left) > TOLERANCE || Math.abs(card.box.right - found.composer.right) > TOLERANCE) out.push(`${name} spans ${fixed(card.box.left)}–${fixed(card.box.right)}, the composer ${fixed(found.composer.left)}–${fixed(found.composer.right)}`);
      if (card.box.bottom > found.composer.top + 0.5) out.push(`${name} reaches ${fixed(card.box.bottom)}, over the composer at ${fixed(found.composer.top)}`);
    }
    if (found.heading !== null && card.box.top < found.heading.bottom - 0.5) out.push(`${name} starts at ${fixed(card.box.top)}, over the heading that ends at ${fixed(found.heading.bottom)}`);
    if (card.cut) out.push(`${name} cuts off or scrolls some of its content sideways`);
    if (card.kind === 'helper' && card.box.height > SETUP_CARD_MAX) out.push(`${name} is ${fixed(card.box.height)} px tall, over ${SETUP_CARD_MAX}`);
    if (card.kind === 'connect') {
      if (card.box.height > CONNECT_ROW_MAX) out.push(`${name} is ${fixed(card.box.height)} px tall, over ${CONNECT_ROW_MAX}`);
      if (card.lineRects !== 1 || card.lineCut) out.push(`${name}'s text is not one whole line`);
      if (card.button === null || card.lineBox === null || card.button.top > card.lineBox.bottom || card.button.bottom < card.lineBox.top) out.push(`${name}'s Connect is not on the line of its text`);
    }
  }
  return out;
}

/**
 * The new-thread heading as it stood on each walked screen, per width and scheme: every one must be at one height, and ask
 * the question for its state (`expect.heading`).
 */
function headingProblems(headings) {
  const out = [];
  for (const [key, list] of Object.entries(headings)) {
    const tops = list.map((entry) => entry.top);
    if (spread(tops) > TOLERANCE) out.push(`new-thread heading ${key}: at ${list.map((entry) => `${fixed(entry.top)} (${entry.screen})`).join(', ')}`);
    for (const entry of list) if (entry.expected !== undefined && entry.text !== entry.expected) out.push(`new-thread heading ${key} on ${entry.screen}: "${entry.text}", expected "${entry.expected}"`);
  }
  return out;
}

/**
 * An open popover or menu must be opaque and above everything it covers: its background has alpha 1, and the element
 * at a grid of points inside its painted box (kept off the rounded corners) is the popover or one of its own children.
 * Returns the problems and how many popovers it checked. (The hero's lines are moved with `translate`, which makes each a
 * stacking context: this is what catches one of them painting over an open list.)
 */
async function popoverProblems(page, where) {
  const found = await page.evaluate(() => {
    const surfaces = '.popover, [role="menu"], [role="listbox"], [role="dialog"]:not(.sheet)';
    const out = [];
    for (const popover of document.querySelectorAll(surfaces)) {
      // A list inside a popover (the project list) is part of it; only the outermost surface is checked.
      if (popover.parentElement?.closest(surfaces) != null) continue;
      const box = popover.getBoundingClientRect();
      const style = getComputedStyle(popover);
      if (box.width === 0 || box.height === 0 || style.visibility === 'hidden' || style.display === 'none') continue;
      const name = popover.getAttribute('aria-label') ?? popover.className ?? popover.getAttribute('role');
      // Colours come back as rgb(...) / rgba(...) or color(srgb ...): alpha is the part after the slash or the fourth value.
      const alpha = /\/\s*([\d.]+%?)\s*\)/.exec(style.backgroundColor) ?? /rgba\([^)]*,\s*([\d.]+)\s*\)/.exec(style.backgroundColor);
      const value = alpha === null ? 1 : alpha[1].endsWith('%') ? Number.parseFloat(alpha[1]) / 100 : Number.parseFloat(alpha[1]);
      const covered = [];
      const inset = 14;
      const steps = 5;
      for (let row = 0; row < steps; row += 1) {
        for (let column = 0; column < steps; column += 1) {
          const x = box.left + inset + ((box.width - 2 * inset) * column) / (steps - 1);
          const y = box.top + inset + ((box.height - 2 * inset) * row) / (steps - 1);
          if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) continue;
          const top = document.elementFromPoint(x, y);
          if (top !== null && !popover.contains(top)) covered.push(`${top.tagName.toLowerCase()}.${String(top.className).trim().split(/\s+/)[0]}`);
        }
      }
      out.push({ name: String(name), alpha: value, covered: [...new Set(covered)] });
    }
    return out;
  });
  const out = [];
  for (const popover of found) {
    if (popover.alpha < 1) out.push(`${where}: the popover "${popover.name}" has a translucent background (alpha ${popover.alpha})`);
    if (popover.covered.length > 0) out.push(`${where}: the popover "${popover.name}" is painted over by ${popover.covered.join(', ')}`);
  }
  return { out, count: found.length };
}

/** Measures one screen at every width and scheme; returns its problems, how many things it measured and its bars. */
async function checkScreen(page, screen, shotsDir, bars, expect, headings) {
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
      if (expect?.heading !== undefined) {
        if (found.heading === null) failures.push(`${screen} ${key}: no new-thread heading`);
        else {
          (headings[key] ??= []).push({ screen, top: found.heading.top, text: found.heading.text, expected: expect.heading });
          measured += 1;
        }
      }
      failures.push(...problems(`${screen} @${width} ${scheme}`, found));
      if (expect?.approvals !== undefined && found.approvals.length !== expect.approvals) failures.push(`${screen} @${width} ${scheme}: ${found.approvals.length} approval cards, expected ${expect.approvals}`);
      // Which composer controls the screen draws: Stop in a running composer, the mic only where T3 can transcribe.
      for (const label of expect?.controls ?? []) if (!found.composer?.controls.includes(label)) failures.push(`${screen} @${width} ${scheme}: the composer has no "${label}" (it has ${found.composer?.controls.join(', ') ?? 'nothing'})`);
      for (const label of expect?.without ?? []) if (found.composer?.controls.some((control) => control.startsWith(label))) failures.push(`${screen} @${width} ${scheme}: the composer draws "${label}", which cannot work here`);
      const popovers = await popoverProblems(page, `${screen} @${width} ${scheme}`);
      failures.push(...popovers.out);
      measured += popovers.count;
      if (expect?.popover === true && popovers.count === 0) failures.push(`${screen} @${width} ${scheme}: no open popover was found to check`);
      if (expect?.setupCards !== undefined) {
        failures.push(...(await setupCardProblems(page, `${screen} @${width} ${scheme}`, expect.setupCards)));
        measured += expect.setupCards.length;
      }
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
    // An act that names a long batch: the ask line must still show it, the site among it, within the card.
    {
      id: 'layout-act', origin: 'http://127.0.0.1:41889', tool: 'act', session, tab,
      steps: [
        { action: 'fill', target: { role: 'textbox', name: 'Shipping address, the line that holds the street' } },
        { action: 'fill', target: { role: 'textbox', name: 'Shipping address, the line that holds the suburb' } },
        { action: 'click', target: { role: 'button', name: 'Continue to payment and review the order' } },
      ],
    },
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
  const headings = {};
  const WORK_ON = 'What should we work on?';
  const BUILD = 'What should we build?';
  // Long enough to wrap the composer's text to three lines at 400 px.
  const DRAFT = 'Compare the two headphones on this page by battery, weight and price, then add the better value one to my cart and tell me the total.';
  const run = async (screen, expect) => {
    const { failures: found, measured } = await checkScreen(page, screen, shotsDir, bars, expect, headings);
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
  await run('home-direct', { controls: ['Attach files', 'Send'], without: ['Start voice input', 'Voice input'], heading: WORK_ON });
  // A draft that wraps grows the composer upwards; the heading stays.
  await page.locator('.composer-input').fill(DRAFT);
  await run('home-direct-draft', { heading: WORK_ON });
  await page.locator('.composer-input').fill('');
  await page.locator('.model-chip').first().click();
  await page.locator('.model-popover').waitFor();
  await run('model-picker', { popover: true });
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
  await run('home-t3-no-project', { controls: ['Attach files', 'Start voice input', 'Send'], heading: WORK_ON });
  await page.locator('.hero-picker > button').click();
  await page.locator('.project-popover').getByText('virtus-umbrella').click();
  await page.locator('.hero-picker > button').filter({ hasText: 'virtus-umbrella' }).waitFor();
  // A third line, "or start without a project", grows the hero downwards.
  await run('home-t3-project', { heading: BUILD });
  await page.locator('.hero-picker > button').click();
  // With a project chosen the hero also draws "or start without a project" right under the picker: it must not paint through the list.
  await run('project-picker', { popover: true, heading: BUILD });
  await page.keyboard.press('Escape');
  // T3's link dropped: the banner floats under the bar, and until T3 is back threads would run directly, so the hero asks
  // the direct question.
  await page.evaluate(() => window.__t3tabT3.set({ status: 'lost' }));
  await page.locator('.banner').filter({ hasText: 'Reconnecting to T3 Code' }).waitFor();
  await run('home-t3-reconnecting', { heading: WORK_ON });
  await page.evaluate(() => window.__t3tabT3.set({ status: 'ready' }));
  await page.locator('.banner').waitFor({ state: 'detached' });

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
  // Turned off, the current tab's chip is a button that looks like one: the chip's outline, not a line of grey text.
  const shareChip = page.locator('.composer-chips .tab-chip').first();
  if ((await shareChip.count()) > 0 && !(await shareChip.evaluate((chip) => chip.classList.contains('off')))) await shareChip.getByRole('button').click();
  const offChip = page.locator('.composer-chips button.tab-chip.off');
  await offChip.waitFor();
  const outline = await offChip.evaluate((chip) => getComputedStyle(chip).boxShadow);
  assert(outline !== 'none' && /inset/.test(outline), `"Share this tab" has no outline: ${outline}`);
  await offChip.click();
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
    failures.push(...(await themeSheetProblems(page)));
  }
  await page.locator('#btn-settings-back').click();
  await page.setViewportSize({ width: 360, height: 800 });
  await page.emulateMedia({ colorScheme: 'light' });

  // First run on the headless panel, from supplied state: the setup card while the helper is missing, then, with the helper
  // there and T3 Code running but not connected, the one Connect row. Both are walked screens with the one bar.
  if (panelPage !== undefined) {
    const render = async (state) => await panelPage.evaluate((next) => globalThis.__t3tabRenderPanelState(next), { ...(await panelRequest(serviceWorker, { type: 'panel.state' })), ...state });
    await render({ helper: { connected: false, problem: 'missing' }, setup: null });
    await panelPage.locator('[data-setup-card] .command-line').waitFor();
    const runOn = async (screen, expect) => {
      const { failures: found, measured } = await checkScreen(panelPage, screen, shotsDir, bars, expect, headings);
      counts[screen] = measured;
      failures.push(...found);
    };
    await runOn('home-setup-card', { setupCards: ['helper'], heading: WORK_ON });
    await panelPage.locator('.composer-input').fill(DRAFT);
    await runOn('home-setup-card-draft', { setupCards: ['helper'], heading: WORK_ON });
    await panelPage.locator('.composer-input').fill('');
    await render({ helper: { connected: true }, setup: { agents: [{ id: 'claude', found: true, registered: false }], t3: { state: 'running' } } });
    await panelPage.locator('.setup-card.connect-row').waitFor();
    // The panel's own attempt to connect failed here (the fake T3 cannot pair): the row is the plain one, no error text.
    const connectButton = panelPage.locator('.setup-card.connect-row').getByRole('button', { name: 'Connect' });
    await connectButton.waitFor();
    await sleep(1500);
    assert(await connectButton.isEnabled(), 'The Connect row is still busy after the automatic attempt');
    assert((await panelPage.locator('.setup-card.connect-row .problem').count()) === 0, 'A failed automatic attempt put an error on the Connect row');
    await runOn('home-connect-t3', { setupCards: ['connect'], heading: WORK_ON });
    // A click is the owner's own: its failure shows the error.
    await connectButton.click();
    await panelPage.locator('.setup-card.connect-row .problem').waitFor();
    await render({ helper: { connected: true }, setup: null });
  }

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
  failures.push(...headingProblems(headings));
  assert(Object.values(headings).every((list) => list.length >= 9), 'The layout check compared the new-thread heading on too few states');
  const barCount = Object.values(bars).reduce((sum, list) => sum + list.length, 0);
  assert(failures.length === 0, `Panel layout, measured on its ink (${failures.length} problems):\n${failures.join('\n')}`);
  console.log(`Panel layout: ${total} bars, composers, heroes and approval cards measured on ${Object.keys(counts).length} screens at ${WIDTHS.join('/')} px, light and dark (and ${promptCards} prompt cards on the headless new-thread screen); ink insets, centre lines, control sizes and glyph sizes within ${TOLERANCE} px; the ${barCount} top bars are the one bar and agree across screens in height, insets, icon size and stroke, toggle and breadcrumb position; the new-thread heading at one height and with T3's two questions on ${Object.values(headings)[0]?.length ?? 0} states, approval cards at most ${CARD_MAX} px with one row of answers, the setup card at most ${SETUP_CARD_MAX} px and the Connect row one line in the composer's column, and prompts on the new-thread screen move neither the hero nor the composer`);
}
