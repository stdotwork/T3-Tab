import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PageActionResult } from '@t3-tab/protocol';

import { actOnPage } from '../src/actions';
import { documentEpoch, ensureAttached, initCdp } from '../src/cdp';
import type { StoredSession } from '../src/sessions';
import { FakeBrowser } from './fake-browser';

/** Settling and the closing read are stand-ins: the first runs `duringSettle` once, the second echoes the tab. */
let duringSettle: (() => void) | undefined;
vi.mock('../src/settle', () => ({
  settlePage: async () => {
    const run = duringSettle;
    duringSettle = undefined;
    run?.();
    return { settled: true, timedOut: false, elapsedMs: 0 };
  },
}));
vi.mock('../src/page', () => ({
  readPage: async (_session: unknown, tab: number): Promise<PageActionResult> => {
    const current = await chrome.tabs.get(tab);
    return { tab, title: current.title ?? '', url: current.url ?? '', epoch: 0, nodes: [] };
  },
}));

const A = 'http://a.test';
const B = 'http://b.test';
const session: StoredSession = { id: 's1', name: 'Session', groupId: 5, sharedTabIds: [], approvedOrigins: {}, currentOrigins: {} };
const reload = async (): Promise<StoredSession> => session;
const press = [{ press: { key: 'Enter' } }, { press: { key: 'Tab' } }];

const browser = new FakeBrowser();
let tabId = 100;

beforeAll(() => {
  browser.install();
  initCdp();
});

beforeEach(() => {
  browser.reset();
  duringSettle = undefined;
  tabId += 10;
  browser.addTab({ id: tabId, groupId: 5, url: `${A}/form`, title: 'Form' });
});

/** The first input command of `kind` replaces the document before the browser handles it. */
function navigateBeforeInput(kind: 'Input.dispatchKeyEvent', url: string): void {
  browser.beforeCommand = (id, method) => {
    if (id !== tabId || method !== kind) return;
    browser.beforeCommand = undefined;
    browser.navigate(id, url, '');
  };
}

describe('act steps and document replacement', () => {
  it('goes on when a key press replaces the page with another one on the approved origin', async () => {
    navigateBeforeInput('Input.dispatchKeyEvent', `${A}/results`);
    const result = await actOnPage(session, tabId, press, [null, null], 0, A, reload);
    expect(result.failure).toBeUndefined();
    expect(result.url).toBe(`${A}/results`);
    expect(browser.commands.filter((command) => command.method === 'Input.dispatchKeyEvent')).toHaveLength(4);
  });

  it('stops when a page from another origin came and went during settling', async () => {
    duringSettle = () => {
      browser.navigate(tabId, `${B}/inbox`, '');
      browser.navigate(tabId, `${A}/form`, '');
    };
    const result = await actOnPage(session, tabId, press, [null, null], 0, A, reload);
    expect(result.failure).toMatchObject({ step: 1, action: 'press' });
    expect(result.failure?.error).toMatch(/changed to http:\/\/b\.test during the press step/);
    expect(browser.commands.filter((command) => command.method === 'Input.dispatchKeyEvent')).toHaveLength(2);
  });

  it('stops a step with a ref when another origin took the page before its input', async () => {
    // The agent's ref comes from a read of this document, after the debugger attached.
    await ensureAttached(tabId);
    const epoch = documentEpoch(tabId);
    browser.beforeCommand = (id, method) => {
      if (id !== tabId || method !== 'Input.insertText') return;
      browser.beforeCommand = undefined;
      browser.navigate(id, `${B}/inbox`, '');
      browser.navigate(id, `${A}/form`, '');
    };
    const steps = [{ type: { ref: 'e1', text: 'hello' } }, { type: { ref: 'e1', text: 'again' } }];
    const result = await actOnPage(session, tabId, steps, [7, 7], epoch, A, reload);
    expect(result.failure).toMatchObject({ step: 1, action: 'type' });
    expect(result.failure?.error).toMatch(/changed to http:\/\/b\.test during the type step/);
  });
});
