import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { initCdp } from '../src/cdp';
import { evaluatePage } from '../src/evaluate';
import type { StoredSession } from '../src/sessions';
import { FakeBrowser } from './fake-browser';

const A = 'http://a.test';
const B = 'http://b.test';
const SECRET_B = 'secret of site B: the inbox';

/** An expression that closes the wrapper run_js builds around it and then reads the page unchecked. */
const ESCAPE = '0); })(); ((v)=>(f)=>()=>v)(document.body.innerText)(function(){ return (0';

const session: StoredSession = {
  id: 's1',
  name: 'Session',
  groupId: 5,
  sharedTabIds: [],
  approvedOrigins: {},
  currentOrigins: {},
};
const reload = async (): Promise<StoredSession> => session;

const browser = new FakeBrowser();
let tabCounter = 0;

beforeAll(() => {
  browser.install();
  initCdp();
});

beforeEach(() => {
  browser.reset();
  // cdp.ts keeps state per tab id, so every test gets tabs of its own.
  tabCounter += 10;
});

describe('run_js in a verified context', () => {
  it('runs an expression in the approved page and pins it to that page\'s context', async () => {
    const tab = browser.addTab({ id: tabCounter, groupId: 5, url: `${A}/page`, text: 'hello from A', title: 'Page A' });
    const result = await evaluatePage(session, tab.id, 'document.title', A, reload);
    expect(result).toEqual({ value: 'Page A' });
    const sent = browser.commands.find((command) => command.method === 'Runtime.evaluate');
    expect(sent?.params?.uniqueContextId).toBe(tab.context.uniqueId);
  });

  it('runs an expression that breaks out of the wrapper only in the approved page', async () => {
    const tab = browser.addTab({ id: tabCounter, groupId: 5, url: `${A}/page`, text: 'text of A' });
    const result = await evaluatePage(session, tab.id, ESCAPE, A, reload);
    expect(result).toEqual({ value: 'text of A' });
    expect(browser.evaluated.every((run) => run.origin === A)).toBe(true);
  });

  it('cannot run the escape expression in a page that replaced the approved one before it started', async () => {
    const tab = browser.addTab({ id: tabCounter, groupId: 5, url: `${A}/page`, text: 'text of A' });
    // The tab moves to site B after the origin was checked and before the browser gets the evaluation.
    browser.beforeCommand = (_tabId, method) => {
      if (method !== 'Runtime.evaluate') return;
      browser.beforeCommand = undefined;
      browser.navigate(tab.id, `${B}/inbox`, SECRET_B);
    };
    await expect(evaluatePage(session, tab.id, ESCAPE, A, reload)).rejects.toThrow(/page changed before run_js could start/);
    expect(browser.evaluated.some((run) => run.origin === B)).toBe(false);
  });

  it('refuses when the page\'s own context is not the approved origin, even if the tab address still says so', async () => {
    const tab = browser.addTab({ id: tabCounter, groupId: 5, url: `${A}/page`, text: 'text of A' });
    // The document was replaced but the tab's address has not caught up yet.
    browser.navigate(tab.id, `${B}/inbox`, SECRET_B);
    const original = chrome.tabs.get;
    chrome.tabs.get = (async (id: number) => ({ ...(await original(id)), url: `${A}/page` })) as typeof chrome.tabs.get;
    try {
      await expect(evaluatePage(session, tab.id, ESCAPE, A, reload)).rejects.toThrow(/belongs to http:\/\/b\.test, not the approved http:\/\/a\.test/);
    } finally {
      chrome.tabs.get = original;
    }
    expect(browser.evaluated).toEqual([]);
  });
});
