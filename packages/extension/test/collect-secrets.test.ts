import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';

import { initCdp } from '../src/cdp';
import { rememberPageSecrets } from '../src/page';
import { FakeBrowser } from './fake-browser';

const browser = new FakeBrowser();

beforeAll(() => {
  browser.install();
  initCdp();
});

beforeEach(() => {
  browser.reset();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

it('gives up on the page\'s secret values within two seconds, making T3-Tab\'s world on a new document included', async () => {
  const tab = browser.addTab({ id: 41, url: 'http://a.test/form' });
  // The browser never answers the command that makes T3-Tab's world.
  browser.beforeCommand = async (_tabId, method) => {
    if (method === 'Page.createIsolatedWorld') await new Promise<never>(() => undefined);
  };
  let done = false;
  const collecting = rememberPageSecrets(tab.id).then(() => {
    done = true;
  });
  await vi.advanceTimersByTimeAsync(2_100);
  expect(done).toBe(true);
  await collecting;
});
