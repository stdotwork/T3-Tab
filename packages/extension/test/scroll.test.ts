import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { initCdp } from '../src/cdp';
import { scrollWithWheel } from '../src/scroll';
import { FakeBrowser } from './fake-browser';

const browser = new FakeBrowser();
let tabId = 200;

beforeAll(() => {
  browser.install();
  initCdp();
});

beforeEach(() => {
  browser.reset();
  tabId += 10;
  // The tab the owner cannot see: another tab of its window is in front.
  browser.addTab({ id: tabId, url: 'http://a.test/long', active: false });
});

const wheels = (): number => browser.commands.filter((command) => command.method === 'Input.dispatchMouseEvent').length;
const probes = (): number => browser.commands.filter((command) => command.method === 'Runtime.evaluate').length;

/** The page answers each probe from `answers` in turn and then keeps the last one. */
function pageSays(...answers: unknown[]): void {
  let index = 0;
  browser.evaluateHook = () => answers[Math.min(index++, answers.length - 1)];
}

describe('a wheel scroll', () => {
  it('goes on once the page has moved', async () => {
    pageSays({ positions: [0, 0], room: true }, { positions: [0, 0], room: true }, { positions: [0, 300], room: true });
    await scrollWithWheel(tabId, 0, 300, 400);
    expect(wheels()).toBe(1);
  });

  it('goes on when an element under the pointer moved and the page did not', async () => {
    pageSays({ positions: [0, 0, 0, 0], room: true }, { positions: [0, 0, 0, 120], room: true });
    await scrollWithWheel(tabId, 0, 120, 400);
  });

  it('fails when nothing moved though there was room, and says what to do', async () => {
    pageSays({ positions: [0, 0], room: true });
    const started = Date.now();
    await expect(scrollWithWheel(tabId, 0, 3000, 120)).rejects.toThrow(/did not scroll.*in the background/s);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(wheels()).toBe(1);
  });

  it('is not an error at the end of the page, and does not wait for it', async () => {
    pageSays({ positions: [0, 900], room: false });
    await scrollWithWheel(tabId, 0, 300, 5_000);
    expect(wheels()).toBe(1);
    expect(probes()).toBe(1);
  });

  it('checks nothing when the page cannot be read', async () => {
    pageSays('not a probe answer');
    await scrollWithWheel(tabId, 0, 300, 5_000);
    expect(wheels()).toBe(1);
  });

  it('fails nothing in a tab the owner can see, even where the page took the wheel itself', async () => {
    browser.addTab({ id: tabId + 1, url: 'http://a.test/map', active: true });
    pageSays({ positions: [0, 0], room: true });
    await scrollWithWheel(tabId + 1, 0, 3000, 400);
    expect(wheels()).toBe(1);
    // Nothing is read, so nothing waits.
    expect(probes()).toBe(0);
  });

  it('counts a tab of a minimised window as one the owner cannot see, and one of an unfocused window as visible', async () => {
    browser.addTab({ id: tabId + 1, url: 'http://a.test/other', active: true });
    pageSays({ positions: [0, 0], room: true });
    // An unfocused browser beside a terminal is still on screen.
    browser.windowFocused = false;
    await scrollWithWheel(tabId + 1, 0, 3000, 80);
    expect(probes()).toBe(0);
    browser.windowState = 'minimized';
    await expect(scrollWithWheel(tabId + 1, 0, 3000, 80)).rejects.toThrow(/did not scroll/);
  });

  it('does not tell the agent to switch tabs, which moves the owner view', async () => {
    pageSays({ positions: [0, 0], room: true });
    const error = await scrollWithWheel(tabId, 0, 3000, 60).catch((caught: Error) => caught);
    expect(String(error)).toMatch(/in the background/);
    expect(String(error)).not.toMatch(/tabs switch/);
  });
});
