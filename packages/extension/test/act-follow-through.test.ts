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
  /** Runs at each wait, after the clock moved: the place for a loading tab to commit. */
  onSleep: undefined as (() => void) | undefined,
  /** The tabs whose secret values a step noted, in order. */
  collected: [] as number[],
}));
vi.mock('../src/settle', () => ({
  sleep: async (ms: number) => {
    reader.clock += ms;
    reader.onSleep?.();
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
  rememberPageSecrets: async (tab: number): Promise<void> => {
    reader.collected.push(tab);
  },
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
    // One more than the tabs there are now, so two tabs opened in one test get two ids.
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
  Object.assign(reader, { textLength: 100, reads: [], clock: 1_000_000, duringRead: undefined, onSleep: undefined, collected: [] });
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

describe('the secret values a batch notes', () => {
  it('are noted before every step that can change a field or send a form, and before a scroll, hover or wait only after one did', async () => {
    const { shopTab, act, allowOnce, sessionStore } = await load();
    await sessionStore.register(alice);
    const tab = await shopTab();
    const steps: ActStep[] = [
      { scroll: { dy: 100 } },
      { wait: { ms: 10 } },
      { type: { text: 'ada' } },
      { scroll: { dy: 100 } },
      { wait: { ms: 10 } },
      { press: { key: 'Enter' } },
    ];
    const acting = act(tab, { steps, backendIds: steps.map(() => null) });
    await allowOnce();
    const result = await acting;
    expect(result.failure).toBeUndefined();
    // The first scroll (nothing noted on this document yet), the type, the scroll after it and the key press.
    expect(reader.collected).toEqual([tab, tab, tab, tab]);
  });
});

describe('a tab a step opened, further', () => {
  it('that redirected from the batch\'s origin to one the session may not read shows that origin only', async () => {
    const { shopTab, opensOnKey, act, allowOnce, sessionStore, siteStore } = await load();
    await sessionStore.register(alice);
    const tab = await shopTab();
    await siteStore.set(SHOP, 'allow');
    const popup = opensOnKey(tab, { url: '', status: 'loading', pendingUrl: `${SHOP}/go` });
    // The shop's address answers with a redirect: the tab commits on the other site.
    reader.onSleep = () => {
      const fake = browser.tabs.get(popup);
      if (fake === undefined || fake.pendingUrl === undefined) return;
      Object.assign(fake, { url: `${OTHER}/inbox`, title: 'Inbox (3)', pendingUrl: undefined, status: 'complete' });
    };
    const result = await act(tab);
    expect(result.opened).toEqual([{ tab: { id: popup, title: '', url: OTHER, active: false, needsApproval: true, groupId: 1000 } }]);
    expect(reader.reads).not.toContain(popup);
    void allowOnce;
  });

  it('still on the blank page it was created with is said to be loading, not refused', async () => {
    const { shopTab, opensOnKey, act, sessionStore, siteStore } = await load();
    await sessionStore.register(alice);
    const tab = await shopTab();
    await siteStore.set(SHOP, 'allow');
    const popup = opensOnKey(tab, { url: 'about:blank' });
    const started = reader.clock;
    expect((await act(tab)).opened).toEqual([
      { tab: { id: popup, title: '', url: 'about:blank', active: false, needsApproval: true }, unread: 'It is still loading.' },
    ]);
    // Given a second to start loading something, not the whole wait.
    expect(reader.clock - started).toBeLessThan(2_000);
  });

  it('from a GET form the batch sent does not show the password it carries in its address or title', async () => {
    const { shopTab, opensOnKey, act, allowOnce, sessionStore, siteStore } = await load();
    const secrets = await import('../src/secret-text');
    await sessionStore.register(alice);
    const tab = await shopTab();
    await siteStore.set(SHOP, 'read');
    // What a read or the click step itself noted of the opener's form.
    secrets.rememberSecrets(tab, ['hunter2-secret']);
    const popup = opensOnKey(tab, { url: `${SHOP}/login?user=ada&pw=hunter2-secret`, title: 'Welcome hunter2-secret' });
    const acting = act(tab);
    await allowOnce();
    const [described] = (await acting).opened ?? [];
    expect(described?.tab.id).toBe(popup);
    // The page itself is a stand-in here; the real read scrubs its title and address as `tabs list` does.
    expect(described?.tab.url).not.toContain('hunter2-secret');
    expect(described?.tab.title).not.toContain('hunter2-secret');
    expect(described?.tab.url).toContain('pw=');
  });

  describe('under Full access', () => {
    async function fullAccess() {
      const runtime = await load();
      await runtime.sessionStore.register(alice, 'th1');
      daemon.askDaemon.mockImplementation(async () => ({ runtimeMode: 'full-access' }));
      return runtime;
    }

    it('comes with its page on the batch\'s own origin, and is listed with what Full access let through', async () => {
      const { shopTab, opensOnKey, act, permissionPrompts } = await fullAccess();
      const tab = await shopTab();
      const before = permissionPrompts.autoAllowed().length;
      const popup = opensOnKey(tab, { url: `${SHOP}/receipt`, title: 'Receipt' });
      const [described] = (await act(tab)).opened ?? [];
      expect(described).toMatchObject({ tab: { id: popup, title: 'Receipt' }, page: { url: `${SHOP}/receipt` } });
      const listed = permissionPrompts.autoAllowed().slice(before);
      expect(listed.map((entry) => entry.tool)).toEqual(['act', 'read']);
      expect(listed[1]).toMatchObject({ origin: SHOP, tabId: popup, tabTitle: 'Receipt' });
    });

    it('is listed with what Full access let through when its read fails and the reply still shows its title', async () => {
      const { shopTab, opensOnKey, act, permissionPrompts } = await fullAccess();
      const tab = await shopTab();
      const before = permissionPrompts.autoAllowed().length;
      const popup = opensOnKey(tab, { url: `${SHOP}/receipt`, title: 'Receipt' });
      reader.duringRead = (read) => {
        if (read === popup) throw new Error('The page could not be read.');
      };
      const [described] = (await act(tab)).opened ?? [];
      expect(described).toMatchObject({ tab: { id: popup, title: 'Receipt' }, unread: 'The page could not be read.' });
      const listed = permissionPrompts.autoAllowed().slice(before);
      expect(listed.map((entry) => entry.tool)).toEqual(['act', 'read']);
      expect(listed[1]).toMatchObject({ origin: SHOP, tabId: popup, tabTitle: 'Receipt' });
    });

    it('does not count on another origin, which needs its own site setting', async () => {
      const { shopTab, opensOnKey, act, permissionPrompts, siteStore } = await fullAccess();
      const tab = await shopTab();
      const before = permissionPrompts.autoAllowed().length;
      const popup = opensOnKey(tab, { url: `${OTHER}/inbox`, title: 'Inbox' });
      const [described] = (await act(tab)).opened ?? [];
      expect(described).toEqual({ tab: { id: popup, title: '', url: OTHER, active: false, needsApproval: true, groupId: 1000 } });
      expect(reader.reads).not.toContain(popup);
      expect(permissionPrompts.autoAllowed().slice(before).map((entry) => entry.tool)).toEqual(['act']);

      await siteStore.set(OTHER, 'read');
      const second = opensOnKey(tab, { url: `${OTHER}/inbox`, title: 'Inbox' });
      const [shown] = (await act(tab)).opened ?? [];
      expect(shown).toMatchObject({ tab: { id: second, title: 'Inbox' }, page: { url: `${OTHER}/inbox` } });
    });
  });
});
