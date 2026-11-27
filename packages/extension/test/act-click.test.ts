import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ActStep, PageActionResult } from '@t3-tab/protocol';

import { actOnPage } from '../src/actions';
import { documentEpoch, ensureAttached, initCdp } from '../src/cdp';
import type { StoredSession } from '../src/sessions';
import { FakeBrowser } from './fake-browser';

vi.mock('../src/settle', () => ({
  sleep: async () => undefined,
  settlePage: async () => ({ settled: true, timedOut: false, elapsedMs: 0 }),
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
const click: ActStep = { click: { ref: 'e1' } };

const browser = new FakeBrowser();
let tabId = 100;

/** What reached the browser and what it answered, in order: `sent mousePressed`, `answered mouseMoved`, `focus on`. */
let log: string[] = [];
const never = new Promise<never>(() => undefined);

interface Page {
  /** The move's handler opens an alert: the move is never answered, and the input queued behind it waits. */
  moveOpensDialog?: boolean;
  releaseOpensDialog?: boolean;
  moveFails?: boolean;
  pressFails?: boolean;
  /** Runs when the press is dispatched, before it is answered. */
  onPress?: () => void;
}

/**
 * A hidden tab's input queue as Chromium runs it. The move waits for a frame the tab does not draw, so it is dispatched
 * only when a discrete event arrives behind it (or after 50 ms, standing in for the browser's own late tick). Each
 * event is answered once it is dispatched, in the order sent, and a dialog holds everything behind it.
 */
function hiddenTabInput(page: Page = {}): void {
  let flush = (): void => undefined;
  const frame = new Promise<void>((resolve) => {
    flush = resolve;
    setTimeout(resolve, 50);
  });
  let moveDone = (): void => undefined;
  const moved = new Promise<void>((resolve) => (moveDone = resolve));
  let pressDone = (): void => undefined;
  const pressed = new Promise<void>((resolve) => (pressDone = resolve));
  browser.beforeCommand = async (id, method, params) => {
    if (id !== tabId) return;
    if (method === 'Emulation.setFocusEmulationEnabled') log.push(params?.enabled === true ? 'focus on' : 'focus off');
    if (method !== 'Input.dispatchMouseEvent') return;
    const type = String(params?.type);
    log.push(`sent ${type}`);
    if (type === 'mouseMoved') {
      await frame;
      if (page.moveOpensDialog) {
        browser.openDialog(tabId, 'Hovered');
        await never;
      }
      moveDone();
      log.push('answered mouseMoved');
      if (page.moveFails) throw new Error('Input.dispatchMouseEvent: the move failed');
      return;
    }
    if (type === 'mousePressed') {
      flush();
      await moved;
      page.onPress?.();
      pressDone();
      log.push('answered mousePressed');
      if (page.pressFails) throw new Error('Input.dispatchMouseEvent: the press failed');
      return;
    }
    await pressed;
    if (page.releaseOpensDialog) {
      browser.openDialog(tabId, 'Clicked');
      await never;
    }
    log.push(`answered ${type}`);
  };
}

async function clickOnce(steps: ActStep[] = [click]): Promise<PageActionResult> {
  // The agent's ref comes from a read of this document, after the debugger attached.
  await ensureAttached(tabId);
  // The top frame names its document, so a dialog from it is known to be the page's own.
  browser.reportMainDocument(tabId, `loader-${tabId}`);
  return await actOnPage(session, tabId, steps, steps.map(() => 7), documentEpoch(tabId), A, reload);
}

beforeAll(() => {
  browser.install();
  initCdp();
});

beforeEach(() => {
  browser.reset();
  log = [];
  tabId += 10;
  browser.addTab({ id: tabId, groupId: 5, url: `${A}/form`, title: 'Form' });
});

describe('a click', () => {
  it('sends the press while the move is unanswered, and keeps the move, press and release in order inside the focus hold', async () => {
    hiddenTabInput();
    const result = await clickOnce();
    expect(result.failure).toBeUndefined();
    expect(log).toEqual([
      'focus on',
      'sent mouseMoved',
      'sent mousePressed',
      'answered mouseMoved',
      'answered mousePressed',
      'sent mouseReleased',
      'answered mouseReleased',
      'focus off',
    ]);
    const mouse = browser.commands.filter((command) => command.method === 'Input.dispatchMouseEvent').map((command) => command.params);
    expect(mouse).toEqual([
      { type: 'mouseMoved', x: 10, y: 5 },
      { type: 'mousePressed', x: 10, y: 5, button: 'left', clickCount: 1 },
      { type: 'mouseReleased', x: 10, y: 5, button: 'left', clickCount: 1 },
    ]);
  });

  it('fails with the move\'s error when the move failed after the press was sent', async () => {
    hiddenTabInput({ moveFails: true });
    const result = await clickOnce();
    expect(result.failure).toMatchObject({ step: 1, action: 'click' });
    expect(result.failure?.error).toMatch(/the move failed/);
  });

  it('fails with the move\'s error, not the press\'s, when both failed, and sends no release', async () => {
    hiddenTabInput({ moveFails: true, pressFails: true });
    const result = await clickOnce();
    expect(result.failure).toMatchObject({ step: 1, action: 'click' });
    expect(result.failure?.error).toMatch(/the move failed/);
    expect(log).not.toContain('sent mouseReleased');
  });

  it('that opens a dialog on its release counts as done, and the reply names the dialog', async () => {
    hiddenTabInput({ releaseOpensDialog: true });
    const result = await clickOnce();
    expect(result.failure).toBeUndefined();
    expect(result.dialog).toMatch(/waiting on a JavaScript alert: "Clicked"/);
    // Focus emulation stays on while the dialog holds the page.
    expect(log).not.toContain('focus off');
  });

  it('whose move opens a dialog counts as done; its press is already sent, its release is not', async () => {
    hiddenTabInput({ moveOpensDialog: true });
    const result = await clickOnce();
    expect(result.failure).toBeUndefined();
    expect(result.dialog).toMatch(/waiting on a JavaScript alert: "Hovered"/);
    // The browser queues the press behind the dialog: the page gets it once the dialog is answered.
    expect(log).toEqual(['focus on', 'sent mouseMoved', 'sent mousePressed']);
  });

  it('stops the batch when a page from another origin came and went while its input ran', async () => {
    hiddenTabInput({
      onPress: () => {
        browser.navigate(tabId, `${B}/inbox`, '');
        browser.navigate(tabId, `${A}/form`, '');
      },
    });
    const result = await clickOnce([click, { press: { key: 'Enter' } }]);
    expect(result.failure).toMatchObject({ step: 1, action: 'click' });
    expect(result.failure?.error).toMatch(/changed to http:\/\/b\.test during the click step/);
    expect(browser.commands.filter((command) => command.method === 'Input.dispatchKeyEvent')).toHaveLength(0);
  });
});
