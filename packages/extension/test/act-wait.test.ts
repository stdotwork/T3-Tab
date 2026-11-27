import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ActStep, PageActionResult } from '@t3-tab/protocol';

import { actOnPage } from '../src/actions';
import { documentEpoch, ensureAttached, initCdp } from '../src/cdp';
import type { StoredSession } from '../src/sessions';
import { FakeBrowser } from './fake-browser';

/**
 * Settling and sleeping are stand-ins that record what they were asked for, in order: `settle 500` for a settle that lasts
 * at least 500 ms, `sleep 500`. A settle runs `duringSettle` once, the place for the page to move while it watches.
 */
const timeline: string[] = [];
let duringSettle: (() => void) | undefined;
vi.mock('../src/settle', () => ({
  sleep: async (ms: number) => void timeline.push(`sleep ${ms}`),
  settlePage: async (_tab: number, minMs = 0) => {
    timeline.push(`settle ${minMs}`);
    const run = duringSettle;
    duringSettle = undefined;
    run?.();
    return { settled: true, timedOut: false, elapsedMs: minMs };
  },
}));
vi.mock('../src/page', () => ({
  readPage: async (_session: unknown, tab: number): Promise<PageActionResult> => {
    const current = await chrome.tabs.get(tab);
    return { tab, title: current.title ?? '', url: current.url ?? '', epoch: 0, nodes: [] };
  },
  rememberPageSecrets: async (): Promise<void> => undefined,
}));

const A = 'http://a.test';
const B = 'http://b.test';
const session: StoredSession = { id: 's1', name: 'Session', groupId: 5, sharedTabIds: [], approvedOrigins: {}, currentOrigins: {} };
const reload = async (): Promise<StoredSession> => session;

const browser = new FakeBrowser();
let tabId = 100;

beforeAll(() => {
  browser.install();
  initCdp();
});

beforeEach(() => {
  browser.reset();
  timeline.length = 0;
  duringSettle = undefined;
  tabId += 10;
  browser.addTab({ id: tabId, groupId: 5, url: `${A}/form`, title: 'Form' });
  // Input steps log themselves in the timeline, so it shows what ran between the settles.
  browser.beforeCommand = (id, method, params) => {
    if (id !== tabId) return;
    if (method === 'Input.dispatchMouseEvent' && params?.type === 'mousePressed') timeline.push('click');
    if (method === 'Input.dispatchKeyEvent' && params?.type !== 'keyUp') timeline.push(`press ${String(params?.key)}`);
    if (method === 'Input.insertText') timeline.push(`type ${String(params?.text)}`);
  };
});

async function run(steps: ActStep[]): Promise<PageActionResult> {
  await ensureAttached(tabId);
  // The top frame names its document, so a dialog from it is known to be the page's own.
  browser.reportMainDocument(tabId, `loader-${tabId}`);
  return await actOnPage(session, tabId, steps, steps.map(() => 7), documentEpoch(tabId), A, reload);
}

describe('a wait for a time', () => {
  it('is one settle that lasts the wait, with no settle of its own for the step before it', async () => {
    const result = await run([{ click: { ref: 'e1' } }, { wait: { ms: 500 } }, { press: { key: 'Enter' } }]);
    expect(result.failure).toBeUndefined();
    // Before: click, settle 0, sleep 500, settle 0, press, settle 0.
    expect(timeline).toEqual(['click', 'settle 500', 'press Enter', 'settle 0']);
  });

  it('takes over the settle that field changes before it would have had', async () => {
    const result = await run([{ type: { text: 'a' } }, { type: { text: 'b' } }, { wait: { ms: 300 } }]);
    expect(result.failure).toBeUndefined();
    // Before: type a, type b, settle 0, sleep 300, settle 0.
    expect(timeline).toEqual(['type a', 'type b', 'settle 300']);
  });

  it('of no time still settles once after the step before it', async () => {
    await run([{ press: { key: 'Tab' } }, { wait: { ms: 0 } }]);
    expect(timeline).toEqual(['press Tab', 'settle 0']);
  });

  it('after another wait waits again in full: a wait never leaves its time to the next one', async () => {
    await run([{ wait: { ms: 400 } }, { wait: { ms: 600 } }]);
    expect(timeline).toEqual(['settle 400', 'settle 600']);
  });

  it('for text keeps the settle before it', async () => {
    browser.tabs.get(tabId)!.text = 'Ready';
    await run([{ click: { ref: 'e1' } }, { wait: { for: 'Ready' } }]);
    expect(timeline).toEqual(['click', 'settle 0', 'settle 0']);
  });

  it('stops the batch at the step before it when a page from another origin came and went while it waited', async () => {
    duringSettle = () => {
      browser.navigate(tabId, `${B}/inbox`, '');
      browser.navigate(tabId, `${A}/form`, '');
    };
    const result = await run([{ click: { ref: 'e1' } }, { wait: { ms: 500 } }, { press: { key: 'Enter' } }]);
    expect(result.failure).toMatchObject({ step: 1, action: 'click' });
    expect(result.failure?.error).toMatch(/changed to http:\/\/b\.test during the click step/);
    expect(timeline).toEqual(['click', 'settle 500']);
  });

  it('names the field step before it that replaced the page, for a later step\'s stale ref', async () => {
    browser.beforeCommand = (id, method) => {
      if (id !== tabId || method !== 'Input.insertText') return;
      browser.beforeCommand = undefined;
      browser.navigate(id, `${A}/next`, '');
    };
    const result = await run([{ type: { text: 'x' } }, { wait: { ms: 200 } }, { type: { ref: 'e1', text: 'y' } }]);
    expect(result.failure).toMatchObject({ step: 3, action: 'type' });
    expect(result.failure?.error).toMatch(/e1 is no longer on the page; read again \(document epoch \d+ -> \d+; step 1 \(type\) replaced the page\)/);
  });

  it('while a dialog is open sleeps the wait and settles for no longer, as before', async () => {
    browser.beforeCommand = (id, method, params) => {
      if (id !== tabId || method !== 'Input.dispatchMouseEvent' || params?.type !== 'mouseReleased') return;
      browser.openDialog(tabId, 'Sure?');
    };
    const result = await run([{ click: { ref: 'e1' } }, { wait: { ms: 500 } }]);
    expect(result.failure).toBeUndefined();
    expect(result.dialog).toMatch(/waiting on a JavaScript alert: "Sure\?"/);
    expect(timeline).toEqual(['sleep 500', 'settle 0']);
  });
});
