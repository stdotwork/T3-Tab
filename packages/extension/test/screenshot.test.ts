import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { initCdp } from '../src/cdp';
import { captureViewport } from '../src/screenshot';
import { FakeBrowser } from './fake-browser';

const browser = new FakeBrowser();
let tabCounter = 0;

beforeAll(() => {
  browser.install();
  initCdp();
});

beforeEach(() => {
  browser.reset();
  tabCounter += 10;
});

describe('a screenshot of a page that changes while it is taken', () => {
  it('discards the image when the document was replaced during the capture', async () => {
    const tab = browser.addTab({ id: tabCounter, url: 'http://a.test/page' });
    browser.beforeCommand = (_tabId, method) => {
      if (method !== 'Page.captureScreenshot') return;
      browser.beforeCommand = undefined;
      browser.navigate(tab.id, 'http://a.test/other', 'new document');
    };
    await expect(
      captureViewport(tab.id, 640, { origin: 'http://a.test', currentUrl: async () => browser.tabs.get(tab.id)?.url ?? '' }),
    ).rejects.toThrow(/changed while the screenshot was being taken/);
  });

  it('discards the image when the address changed during the capture', async () => {
    const tab = browser.addTab({ id: tabCounter, url: 'http://a.test/page' });
    let address = 'http://a.test/page';
    browser.beforeCommand = (_tabId, method) => {
      if (method === 'Page.captureScreenshot') address = 'http://b.test/private';
    };
    await expect(
      captureViewport(tab.id, 640, { origin: 'http://a.test', currentUrl: async () => address }),
    ).rejects.toThrow(/changed while the screenshot was being taken/);
  });

  it('refuses to capture a page that already moved off the approved origin', async () => {
    const tab = browser.addTab({ id: tabCounter, url: 'http://b.test/private' });
    await expect(
      captureViewport(tab.id, 640, { origin: 'http://a.test', currentUrl: async () => 'http://b.test/private' }),
    ).rejects.toThrow(/moved from http:\/\/a\.test to http:\/\/b\.test/);
    expect(browser.commands.some((command) => command.method === 'Page.captureScreenshot')).toBe(false);
  });
});
