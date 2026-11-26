import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { initCdp } from '../src/cdp';
import { captureViewport } from '../src/screenshot';
import { FakeBrowser } from './fake-browser';

const browser = new FakeBrowser();
let tabCounter = 0;

beforeAll(() => {
  browser.install();
  initCdp();
  // Node has no image decoder; a 10 x 10 bitmap lets a capture that is not discarded run to its end.
  (globalThis as unknown as { createImageBitmap: unknown }).createImageBitmap = async () => ({ width: 10, height: 10, close: () => undefined });
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

  it('returns the image when nothing changed', async () => {
    const tab = browser.addTab({ id: tabCounter, url: 'http://a.test/page' });
    const shot = await captureViewport(tab.id, 640, { origin: 'http://a.test', currentUrl: async () => 'http://a.test/page' });
    expect(shot).toMatchObject({ tab: tab.id, data: 'AAAA', width: 10, height: 10, viewportWidth: 800, viewportHeight: 600 });
  });

  it('gives up when the browser draws no frame, and says why and what to do', async () => {
    const tab = browser.addTab({ id: tabCounter, url: 'http://a.test/page' });
    // A page that is not drawn: the browser holds the capture until its own 15 second limit.
    browser.beforeCommand = (_tabId, method) => (method === 'Page.captureScreenshot' ? new Promise<void>(() => undefined) : undefined);
    const started = Date.now();
    await expect(
      captureViewport(tab.id, 640, { origin: 'http://a.test', currentUrl: async () => 'http://a.test/page' }, 50),
    ).rejects.toThrow(/no picture of the page.*background.*tabs switch/s);
    expect(Date.now() - started).toBeLessThan(2_000);
    // The page is not left looking focused.
    const emulation = browser.commands.filter((command) => command.method === 'Emulation.setFocusEmulationEnabled');
    expect(emulation.at(-1)?.params).toEqual({ enabled: false });
  });
});
