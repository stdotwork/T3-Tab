import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { actOnPage } from '../src/actions';
import { ensureAttached, initCdp } from '../src/cdp';
import { rememberSecrets } from '../src/secret-text';
import type { StoredSession } from '../src/sessions';
import { goToHistoryEntry, HTTPS_UPGRADE_FAILED, loadAddress, loadFailure, reloadTab } from '../src/tabs';
import { FakeBrowser } from './fake-browser';

vi.mock('../src/settle', () => ({
  sleep: async () => undefined,
  settlePage: async () => ({ settled: true, timedOut: false, elapsedMs: 0 }),
}));
vi.mock('../src/page', () => ({
  readPage: async (_session: unknown, tab: number) => ({ tab, title: '', url: '', epoch: 0, nodes: [] }),
  rememberPageSecrets: async (): Promise<void> => undefined,
}));

const BLOCKED = 'net::ERR_BLOCKED_BY_CLIENT';
const A = 'http://a.test';
const B = 'http://b.test/page';
const UPGRADE = `Could not load ${B}: ${HTTPS_UPGRADE_FAILED}.`;
const session: StoredSession = { id: 's1', name: 'Session', groupId: 5, sharedTabIds: [], approvedOrigins: {}, currentOrigins: {} };
const reload = async (): Promise<StoredSession> => session;

const browser = new FakeBrowser();
let tab = 200;

beforeAll(() => {
  browser.install();
  initCdp();
});

beforeEach(async () => {
  browser.reset();
  tab += 10;
  browser.addTab({ id: tab, groupId: 5, url: `${A}/start`, title: 'Start' });
  await ensureAttached(tab);
});

describe('what a failed load says', () => {
  it('says the browser upgraded an http address to https and the site did not answer, not that something blocked it', () => {
    expect(loadFailure(B, BLOCKED)).toBe(UPGRADE);
    expect(loadFailure('HTTP://B.TEST/page', BLOCKED)).toContain(HTTPS_UPGRADE_FAILED);
    expect(UPGRADE).not.toMatch(/block/i);
  });

  it('keeps the browser\'s own error for any other failure, and for an https address that was blocked', () => {
    expect(loadFailure('https://b.test/', BLOCKED)).toBe(`Could not load https://b.test/: ${BLOCKED}`);
    expect(loadFailure(B, 'net::ERR_NAME_NOT_RESOLVED')).toBe(`Could not load ${B}: net::ERR_NAME_NOT_RESOLVED`);
    expect(loadFailure('not an address', BLOCKED)).toBe(`Could not load not an address: ${BLOCKED}`);
  });
});

describe('a load of an http address the browser upgraded and could not finish', () => {
  it('fails an open or goto with that sentence', async () => {
    browser.loadErrors.set(B, BLOCKED);
    await expect(loadAddress(tab, B)).rejects.toThrow(UPGRADE);
  });

  it('keeps the browser\'s error for another failure', async () => {
    browser.loadErrors.set(B, 'net::ERR_CONNECTION_REFUSED');
    await expect(loadAddress(tab, B)).rejects.toThrow(`Could not load ${B}: net::ERR_CONNECTION_REFUSED`);
  });

  it('fails a step through history that ends on the error page, which the browser answers with no error of its own', async () => {
    browser.beforeCommand = (id, method) => {
      if (id === tab && method === 'Page.navigateToHistoryEntry') browser.failLoad(id, B, BLOCKED);
    };
    await expect(goToHistoryEntry(tab, 3)).rejects.toThrow(UPGRADE);
  });

  it('fails a reload that ends on the error page', async () => {
    browser.beforeCommand = (id, method) => {
      if (id === tab && method === 'Runtime.evaluate') {
        browser.beforeCommand = undefined;
        browser.failLoad(id, B, BLOCKED);
      }
    };
    await expect(reloadTab(tab, B)).rejects.toThrow(UPGRADE);
  });

  it('is not fooled by a frame that was blocked while the page itself loaded', async () => {
    browser.beforeCommand = (id, method) => {
      if (id !== tab || method !== 'Page.navigateToHistoryEntry') return;
      browser.beforeCommand = undefined;
      browser.navigateWithBlockedFrame(id, `${A}/back`);
    };
    await expect(goToHistoryEntry(tab, 3)).resolves.toBeDefined();
  });

  it('is not repeated for a later load that went through', async () => {
    browser.loadErrors.set(B, BLOCKED);
    await expect(loadAddress(tab, B)).rejects.toThrow(UPGRADE);
    await expect(loadAddress(tab, `${A}/fine`)).resolves.toBeDefined();
  });

  it('stops an act step that followed a link into it, naming the address, not asking to approve the origin', async () => {
    browser.beforeCommand = (id, method) => {
      if (id !== tab || method !== 'Input.dispatchKeyEvent') return;
      browser.beforeCommand = undefined;
      browser.failLoad(id, B, BLOCKED);
    };
    await expect(actOnPage(session, tab, [{ press: { key: 'Enter' } }], [null], 0, A, reload)).rejects.toThrow(
      `Step 1 (press): ${UPGRADE}`,
    );
  });

  it('hides a secret the page put in the address it could not load', async () => {
    const leaky = 'http://b.test/login?user=ada&password=hunter2secret';
    rememberSecrets(tab, ['hunter2secret']);
    browser.beforeCommand = (id, method) => {
      if (id !== tab || method !== 'Input.dispatchKeyEvent') return;
      browser.beforeCommand = undefined;
      browser.failLoad(id, leaky, BLOCKED);
    };
    const failed = actOnPage(session, tab, [{ press: { key: 'Enter' } }], [null], 0, A, reload);
    await expect(failed).rejects.toThrow(HTTPS_UPGRADE_FAILED);
    await expect(failed).rejects.not.toThrow('hunter2secret');
  });

  it('leaves an act step that blocked nothing alone', async () => {
    const result = await actOnPage(session, tab, [{ press: { key: 'Enter' } }], [null], 0, A, reload);
    expect(result.failure).toBeUndefined();
  });
});
