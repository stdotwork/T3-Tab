import { PROTOCOL_VERSION, type ActStep, type BrowserMethod, type BrowserMethods, type PageReadResult, type ToolSession } from '@t3-tab/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FakeBrowser } from './fake-browser';

const daemon = vi.hoisted(() => ({
  askDaemon: vi.fn(),
  daemonLinkState: vi.fn(),
  sendPromptNotice: vi.fn(),
}));
vi.mock('../src/daemon-link', () => daemon);

/** Settling and reading are stand-ins; `sleep` moves the clock, so waiting for a tab that never loads ends. */
const reader = vi.hoisted(() => ({
  textLength: 100,
  reads: [] as number[],
  clock: 0,
  duringRead: undefined as ((tab: number) => void) | undefined,
}));
vi.mock('../src/settle', () => ({
  sleep: async (ms: number) => {
    reader.clock += ms;
  },
  settlePage: async () => ({ settled: true, timedOut: false, elapsedMs: 0 }),
  pageTextLength: async () => reader.textLength,
  settleSnapshot: async () => ({ ready: true, revision: 0, layout: 'layout', networkRevision: 0 }),
}));
vi.mock('../src/page', () => ({
  readPage: async (_session: unknown, tab: number): Promise<PageReadResult> => {
    reader.reads.push(tab);
    reader.duringRead?.(tab);
    const current = await chrome.tabs.get(tab);
    return { tab, title: current.title ?? '', url: current.url ?? '', epoch: 0, nodes: [] };
  },
  rememberPageSecrets: async (): Promise<void> => undefined,
}));

const browser = new FakeBrowser();
const alice: ToolSession = { id: 'session-alice', name: 'Alice · 1' };
const SHOP = 'https://shop.test';
const OTHER = 'https://other.test';
const press: ActStep[] = [{ press: { key: 'Enter' } }];

async function load() {
  const [runtime, requests, cdp, opened, tabs] = await Promise.all([
    import('../src/runtime'),
    import('../src/requests'),
    import('../src/cdp'),
    import('../src/opened-tabs'),
    import('../src/tabs'),
  ]);
  cdp.initCdp();
  const call = async <M extends BrowserMethod>(method: M, params: BrowserMethods[M]['params']): Promise<BrowserMethods[M]['result']> =>
    (await requests.handleRequest({ type: 'browser.request', protocolVersion: PROTOCOL_VERSION, requestId: 'r', method, session: alice, params } as never)) as BrowserMethods[M]['result'];
  /**
   * The next key press opens a tab from `source`, as a page's `window.open` does: the browser creates it and reports
   * it, and the worker adopts it into its opener's group, as `background.ts` does with the browser's event.
   */
  const opensOnKey = (source: number, fields: { url: string; title?: string; status?: 'loading'; pendingUrl?: string }): number => {
    const id = 700 + browser.tabs.size;
    browser.beforeCommand = (tabId, method) => {
      if (tabId !== source || method !== 'Input.dispatchKeyEvent') return;
      browser.beforeCommand = undefined;
      const tab = browser.addTab({ id, url: fields.url, title: fields.title ?? 'Report' });
      if (fields.status !== undefined) tab.status = fields.status;
      if (fields.pendingUrl !== undefined) tab.pendingUrl = fields.pendingUrl;
      opened.noteOpenedTab(source, id, tabs.adoptPopupTab(id, source, runtime.sessionStore));
    };
    return id;
  };
  /** A tab of the session's own group, on the shop, which the session read. */
  const shopTab = async (): Promise<number> => {
    await runtime.siteStore.set(SHOP, 'allow');
    const result = await call('tabs.open', { url: `${SHOP}/cart` });
    await runtime.siteStore.set(SHOP, 'ask');
    reader.reads.length = 0;
    return result.tab.id;
  };
  const act = async (tab: number, extra: Partial<BrowserMethods['page.act']['params']> = {}) =>
    await call('page.act', { tab, steps: press, backendIds: [null], epoch: 0, skipReadOver: 4_000, ...extra });
  /** Answers the one prompt that is waiting with Allow once, and says what it asked about. */
  const allowOnce = async (): Promise<string | undefined> => {
    await vi.waitFor(() => expect(runtime.permissionPrompts.list()).toHaveLength(1));
    const [prompt] = runtime.permissionPrompts.list();
    await runtime.permissionPrompts.decide(prompt?.id ?? '', 'allow-once');
    return prompt?.tool;
  };
  return { ...runtime, call, opensOnKey, shopTab, act, allowOnce };
}

beforeEach(() => {
  vi.resetModules();
  daemon.askDaemon.mockReset();
  browser.reset();
  browser.install();
  const storage = (data: Record<string, unknown>) => ({
    get: async (keys: string | string[]) => Object.fromEntries([keys].flat().filter((key) => key in data).map((key) => [key, structuredClone(data[key])])),
    set: async (values: Record<string, unknown>) => {
      for (const [key, value] of Object.entries(values)) data[key] = structuredClone(value);
    },
  });
  const fake = (globalThis as unknown as { chrome: Record<string, unknown> }).chrome;
  fake.storage = { session: storage({}), local: storage({}) };
  fake.webNavigation = { onCommitted: { addListener: () => undefined } };
  Object.assign(reader, { textLength: 100, reads: [], clock: 1_000_000, duringRead: undefined });
  vi.spyOn(Date, 'now').mockImplementation(() => reader.clock);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('a tab a step opened', () => {
  it('is named by its origin only, unread, when the session may not read that origin', async () => {
    const { shopTab, opensOnKey, act, allowOnce, sessionStore } = await load();
    await sessionStore.register(alice);
    const tab = await shopTab();
    const popup = opensOnKey(tab, { url: `${OTHER}/report/1`, title: 'Secret report' });
    const acting = act(tab);
    expect(await allowOnce()).toBe('act');
    const result = await acting;
    expect(result.opened).toEqual([{ tab: { id: popup, title: '', url: OTHER, active: false, needsApproval: true, groupId: 1000 } }]);
    expect(reader.reads).not.toContain(popup);
    // Adopted into the session's group, with no approval of its own.
    expect(browser.tabs.get(popup)?.groupId).toBe(1000);
    expect((await sessionStore.get(alice.id))?.approvedOrigins[String(popup)]).toBeUndefined();
  });

  it('comes with its title, address and page when the site lets the session read it, and stays out of the current tab', async () => {
    const { shopTab, opensOnKey, act, allowOnce, sessionStore, siteStore } = await load();
    await sessionStore.register(alice);
    const tab = await shopTab();
    await siteStore.set(OTHER, 'read');
    const popup = opensOnKey(tab, { url: `${OTHER}/report/1`, title: 'Annual report' });
    const acting = act(tab);
    await allowOnce();
    const result = await acting;
    expect(result.opened).toHaveLength(1);
    expect(result.opened?.[0]).toMatchObject({
      tab: { id: popup, title: 'Annual report', url: `${OTHER}/report/1`, active: false },
      page: { tab: popup, url: `${OTHER}/report/1` },
    });
    expect(result.opened?.[0]?.tab.needsApproval).toBeUndefined();
    expect((await sessionStore.get(alice.id))?.currentTabId).toBe(tab);
  });

  it('is not read when its text is longer than a load reply carries, and says how long it is', async () => {
    const { shopTab, opensOnKey, act, allowOnce, sessionStore, siteStore } = await load();
    await sessionStore.register(alice);
    const tab = await shopTab();
    await siteStore.set(OTHER, 'allow');
    reader.textLength = 9_000;
    const popup = opensOnKey(tab, { url: `${OTHER}/long` });
    const acting = act(tab);
    await allowOnce();
    expect((await acting).opened?.[0]).toMatchObject({ tab: { id: popup }, textLength: 9_000 });
    expect(reader.reads).not.toContain(popup);
  });

  it('leaves the page out when reading it needs the owner by the time it was read', async () => {
    const { shopTab, opensOnKey, act, allowOnce, sessionStore, siteStore } = await load();
    await sessionStore.register(alice);
    const tab = await shopTab();
    await siteStore.set(OTHER, 'read');
    const popup = opensOnKey(tab, { url: `${OTHER}/report/1` });
    reader.duringRead = (read) => {
      if (read === popup) void siteStore.set(OTHER, 'ask');
    };
    const acting = act(tab);
    await allowOnce();
    const [described] = (await acting).opened ?? [];
    expect(reader.reads).toContain(popup);
    expect(described?.page).toBeUndefined();
    expect(described?.tab).toMatchObject({ id: popup, url: OTHER, needsApproval: true });
    expect(described?.unread).toMatch(/needs the owner/);
  });

  it('that has not committed by the time the reply goes is said to be loading, by the origin it is loading', async () => {
    const { shopTab, opensOnKey, act, allowOnce, sessionStore, siteStore } = await load();
    await sessionStore.register(alice);
    const tab = await shopTab();
    await siteStore.set(OTHER, 'allow');
    const popup = opensOnKey(tab, { url: '', status: 'loading', pendingUrl: `${OTHER}/slow?token=abc` });
    const acting = act(tab);
    await allowOnce();
    expect((await acting).opened).toEqual([
      { tab: { id: popup, title: '', url: OTHER, active: false, needsApproval: true }, unread: 'It is still loading.' },
    ]);
  });

  it('opened from a tab the owner shared stays the owner\'s, and is only counted', async () => {
    const { opensOnKey, act, allowOnce, sessionStore } = await load();
    await sessionStore.register(alice);
    browser.addTab({ id: 7, url: `${SHOP}/checkout`, title: 'Checkout' });
    await sessionStore.share(alice.id, 7, SHOP);
    const popup = opensOnKey(7, { url: `${OTHER}/pay` });
    const acting = act(7);
    await allowOnce();
    const result = await acting;
    expect(result.opened).toBeUndefined();
    expect(result.openedElsewhere).toBe(1);
    expect(browser.tabs.get(popup)?.groupId).toBe(-1);
  });
});

describe('js after the steps', () => {
  it('is asked for as run_js, runs in the main world of the approved origin once the steps ran, and gives its value', async () => {
    const { shopTab, act, allowOnce, sessionStore } = await load();
    await sessionStore.register(alice);
    const tab = await shopTab();
    const fake = browser.tabs.get(tab);
    if (fake !== undefined) fake.title = 'Cart (2)';
    const acting = act(tab, { expression: 'document.title' });
    expect(await allowOnce()).toBe('run_js');
    const result = await acting;
    expect(result.evaluated).toEqual({ value: 'Cart (2)' });
    const ran = browser.commands.filter((command) => command.method === 'Runtime.evaluate' && String(command.params?.expression).includes('document.title'));
    expect(ran).toHaveLength(1);
    expect(ran[0]?.params?.uniqueContextId).toBe(fake?.context.uniqueId);
    // After the batch's key press.
    const order = browser.commands.map((command) => command.method);
    expect(order.lastIndexOf('Input.dispatchKeyEvent')).toBeLessThan(browser.commands.indexOf(ran[0] ?? browser.commands[0]!));
  });

  it('does not run when a step took the page to another origin', async () => {
    const { shopTab, act, allowOnce, sessionStore } = await load();
    await sessionStore.register(alice);
    const tab = await shopTab();
    browser.beforeCommand = (tabId, method) => {
      if (tabId !== tab || method !== 'Input.dispatchKeyEvent') return;
      browser.beforeCommand = undefined;
      browser.navigate(tab, `${OTHER}/inbox`, '');
    };
    const acting = act(tab, { expression: 'document.title' });
    await allowOnce();
    await expect(acting).rejects.toThrow(/left the page outside the approved session origin/);
    expect(browser.evaluated.filter((entry) => entry.expression.includes('document.title'))).toEqual([]);
  });

  it('reports a script error as its outcome, not as the batch\'s failure', async () => {
    const { shopTab, act, allowOnce, sessionStore } = await load();
    await sessionStore.register(alice);
    const tab = await shopTab();
    const acting = act(tab, { expression: 'missingThing.value' });
    await allowOnce();
    const result = await acting;
    expect(result.failure).toBeUndefined();
    expect(result.evaluated).toMatchObject({ error: expect.stringMatching(/^run_js failed: .*missingThing/) as string });
  });

  it('is not asked for at all on a site the owner allows, as run_js is not', async () => {
    const { shopTab, act, sessionStore, siteStore, permissionPrompts } = await load();
    await sessionStore.register(alice);
    const tab = await shopTab();
    await siteStore.set(SHOP, 'allow');
    expect((await act(tab, { expression: '1 + 1' })).evaluated).toEqual({ value: 2 });
    expect(permissionPrompts.list()).toEqual([]);
  });

  it('on a site set to read is still asked for, as run_js', async () => {
    const { shopTab, act, allowOnce, sessionStore, siteStore } = await load();
    await sessionStore.register(alice);
    const tab = await shopTab();
    await siteStore.set(SHOP, 'read');
    const acting = act(tab, { expression: '1 + 1' });
    expect(await allowOnce()).toBe('run_js');
    expect((await acting).evaluated).toEqual({ value: 2 });
  });

  it('does not run when the thread left Full access while the steps ran', async () => {
    const { shopTab, act, sessionStore, permissionPrompts } = await load();
    await sessionStore.register(alice, 'th1');
    const tab = await shopTab();
    let mode = 'full-access';
    daemon.askDaemon.mockImplementation(async () => ({ runtimeMode: mode }));
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    browser.beforeCommand = (tabId, method) => {
      if (tabId !== tab || method !== 'Input.dispatchKeyEvent') return;
      browser.beforeCommand = undefined;
      mode = 'approval-required';
      now += 10_000;
    };
    const result = await act(tab, { expression: 'document.title' });
    expect(permissionPrompts.list()).toEqual([]);
    expect(result.evaluated).toEqual({ skipped: 'T3 no longer confirms Full access for this thread, so it did not run.' });
    expect(browser.evaluated.filter((entry) => entry.expression.includes('document.title'))).toEqual([]);
  });
});
