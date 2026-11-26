import { PROTOCOL_VERSION, type BrowserMethod, type BrowserMethods, type PageReadResult, type ToolSession } from '@t3-tab/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FakeBrowser } from './fake-browser';

const daemon = vi.hoisted(() => ({
  askDaemon: vi.fn(),
  daemonLinkState: vi.fn(),
  sendPromptNotice: vi.fn(),
}));
vi.mock('../src/daemon-link', () => daemon);

/**
 * Reading the page and probing whether it moved are stand-ins. `pageRevision` is what the probe reports: a test moves
 * the page by changing it, before or during a read. Every read is recorded with whether another was still running.
 */
const reader = vi.hoisted(() => ({
  pageRevision: 0,
  textLength: 100,
  snapshots: 0,
  reads: [] as Array<{ tab: number; overlapped: boolean }>,
  running: 0,
  duringRead: undefined as (() => Promise<void> | void) | undefined,
  duringTextLength: undefined as (() => void) | undefined,
}));
vi.mock('../src/settle', () => ({
  sleep: async () => undefined,
  settlePage: async () => ({ settled: true, timedOut: false, elapsedMs: 0 }),
  pageTextLength: async () => {
    reader.duringTextLength?.();
    return reader.textLength;
  },
  settleSnapshot: async () => {
    reader.snapshots += 1;
    return { ready: true, revision: reader.pageRevision, layout: 'layout', networkRevision: 0 };
  },
}));
vi.mock('../src/page', () => ({
  readPage: async (_session: unknown, tab: number): Promise<PageReadResult> => {
    reader.reads.push({ tab, overlapped: reader.running > 0 });
    reader.running += 1;
    try {
      await reader.duringRead?.();
      const current = await chrome.tabs.get(tab);
      return { tab, title: current.title ?? '', url: current.url ?? '', epoch: reader.pageRevision, nodes: [] };
    } finally {
      reader.running -= 1;
    }
  },
  rememberPageSecrets: async (): Promise<void> => undefined,
}));

const browser = new FakeBrowser();
const alice: ToolSession = { id: 'session-alice', name: 'Alice · 1' };
const SHOP = 'https://shop.test';
const FULL_ACCESS_ENDED = 'T3 no longer confirms Full access for this thread, so the page is left out: read it to ask the owner.';

async function load() {
  // The runtime builds its stores from `chrome` when it is first imported, so the stubs come first.
  const [runtime, requests, cdp] = await Promise.all([import('../src/runtime'), import('../src/requests'), import('../src/cdp')]);
  cdp.initCdp();
  const call = async <M extends BrowserMethod>(method: M, params: BrowserMethods[M]['params']): Promise<BrowserMethods[M]['result']> =>
    (await requests.handleRequest({ type: 'browser.request', protocolVersion: PROTOCOL_VERSION, requestId: 'r', method, session: alice, params } as never)) as BrowserMethods[M]['result'];
  return { ...runtime, call };
}

let clock = 1_000_000;

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
  (globalThis as unknown as { chrome: Record<string, unknown> }).chrome.storage = { session: storage({}), local: storage({}) };
  (globalThis as unknown as { chrome: Record<string, unknown> }).chrome.webNavigation = {
    onCommitted: { addListener: () => undefined },
  };
  Object.assign(reader, { pageRevision: 0, textLength: 100, snapshots: 0, reads: [], running: 0, duringRead: undefined, duringTextLength: undefined });
  clock = 1_000_000;
  vi.spyOn(Date, 'now').mockImplementation(() => clock);
});

afterEach(() => {
  vi.restoreAllMocks();
});

const pageNavigations = (): string[] =>
  browser.commands.filter((command) => command.method === 'Page.navigate').map((command) => String(command.params?.url));

describe('a load\'s reply', () => {
  it('reads a page that held still once', async () => {
    const { sessionStore, siteStore, call } = await load();
    await sessionStore.register(alice);
    await siteStore.set(SHOP, 'allow');
    const result = await call('tabs.open', { url: `${SHOP}/cart` });
    expect(result.page?.url).toBe(`${SHOP}/cart`);
    expect(reader.reads).toHaveLength(1);
    expect(reader.snapshots).toBe(2);
  });

  it('reads a page that moved while it was read once more, after the first read ended, and keeps that read', async () => {
    const { sessionStore, siteStore, call } = await load();
    await sessionStore.register(alice);
    await siteStore.set(SHOP, 'allow');
    reader.duringRead = () => {
      reader.duringRead = undefined;
      reader.pageRevision += 1;
    };
    const result = await call('tabs.open', { url: `${SHOP}/cart` });
    expect(reader.reads.map((read) => read.overlapped)).toEqual([false, false]);
    expect(result.page?.epoch).toBe(1);
  });

  it('reads a page that never stops moving no more than twice', async () => {
    const { sessionStore, siteStore, call } = await load();
    await sessionStore.register(alice);
    await siteStore.set(SHOP, 'allow');
    reader.duringRead = () => {
      reader.pageRevision += 1;
    };
    const result = await call('tabs.open', { url: `${SHOP}/cart` });
    expect(reader.reads).toHaveLength(2);
    expect(result.page).toBeDefined();
  });

  it('does not read again when the first read took the whole re-read window', async () => {
    const { sessionStore, siteStore, call } = await load();
    await sessionStore.register(alice);
    await siteStore.set(SHOP, 'allow');
    reader.duringRead = () => {
      reader.pageRevision += 1;
      clock += 150;
    };
    await call('tabs.open', { url: `${SHOP}/cart` });
    expect(reader.reads).toHaveLength(1);
  });

  it('reads a move within the same document once, with nothing to compare', async () => {
    const { sessionStore, siteStore, call } = await load();
    await sessionStore.register(alice);
    await siteStore.set(SHOP, 'allow');
    const opened = await call('tabs.open', { url: `${SHOP}/cart` });
    Object.assign(reader, { snapshots: 0, reads: [] });
    const moved = await call('tabs.navigate', { action: 'goto', tab: opened.tab.id, url: `${SHOP}/cart#total` });
    expect(moved.page).toBeDefined();
    expect(reader.reads).toHaveLength(1);
    expect(reader.snapshots).toBe(0);
  });

  it('does not read a page whose text is longer than the load asked for, and reads a shorter one', async () => {
    const { sessionStore, siteStore, call } = await load();
    await sessionStore.register(alice);
    await siteStore.set(SHOP, 'allow');
    reader.textLength = 5_000;
    const long = await call('tabs.open', { url: `${SHOP}/cart`, skipReadOver: 4_000 });
    expect(long).toMatchObject({ textLength: 5_000 });
    expect(long.page).toBeUndefined();
    expect(reader.reads).toHaveLength(0);
    reader.textLength = 3_000;
    const short = await call('tabs.open', { url: `${SHOP}/cart`, skipReadOver: 4_000 });
    expect(short.textLength).toBeUndefined();
    expect(short.page).toBeDefined();
  });

  it('leaves out a page a redirect took to an origin the session holds nothing for, and reads one the owner allows', async () => {
    const { sessionStore, siteStore, call } = await load();
    await sessionStore.register(alice);
    await siteStore.set(SHOP, 'allow');
    browser.redirect = () => 'https://mail.test/inbox';
    const hidden = await call('tabs.open', { url: `${SHOP}/cart` });
    expect(hidden).toMatchObject({ redirectedFrom: SHOP, tab: { needsApproval: true } });
    expect(hidden.page).toBeUndefined();
    expect(reader.reads).toHaveLength(0);

    await siteStore.set('https://mail.test', 'read');
    const shown = await call('tabs.open', { url: `${SHOP}/cart` });
    expect(shown.redirectedFrom).toBe(SHOP);
    expect(shown.page?.url).toBe('https://mail.test/inbox');
  });
});

describe('a load that Full access let through', () => {
  async function fullAccessSession() {
    const runtime = await load();
    await runtime.sessionStore.register(alice, 'th1');
    return runtime;
  }

  it('carries the page while T3 still confirms the mode once it was read', async () => {
    const { call } = await fullAccessSession();
    daemon.askDaemon.mockImplementation(async () => ({ runtimeMode: 'full-access' }));
    const result = await call('tabs.open', { url: `${SHOP}/cart` });
    expect(result.page?.url).toBe(`${SHOP}/cart`);
    expect(result.unread).toBeUndefined();
  });

  it('leaves the page out when the thread left Full access during the read', async () => {
    const { call } = await fullAccessSession();
    let mode = 'full-access';
    daemon.askDaemon.mockImplementation(async () => ({ runtimeMode: mode }));
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    reader.duringRead = () => {
      // The thread leaves Full access, and the yes T3 gave before the read is older than it counts for.
      mode = 'approval-required';
      now += 10_000;
    };
    const result = await call('tabs.open', { url: `${SHOP}/cart` });
    expect(reader.reads.length).toBeGreaterThan(0);
    expect(result.page).toBeUndefined();
    expect(result.unread).toBe(FULL_ACCESS_ENDED);
    expect(result.tab.needsApproval).toBe(true);
  });
  it('leaves the length of a long page out too when the thread left Full access while it was measured', async () => {
    const { call } = await fullAccessSession();
    let mode = 'full-access';
    daemon.askDaemon.mockImplementation(async () => ({ runtimeMode: mode }));
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    reader.textLength = 5_000;
    reader.duringTextLength = () => {
      mode = 'approval-required';
      now += 10_000;
    };
    const result = await call('tabs.open', { url: `${SHOP}/cart`, skipReadOver: 4_000 });
    expect(reader.reads).toHaveLength(0);
    expect(result.textLength).toBeUndefined();
    expect(result.unread).toBe(FULL_ACCESS_ENDED);
    expect(result.tab.needsApproval).toBe(true);
  });
});

describe('goto and read with an address', () => {
  it('goto with no tab, in a session with none, opens one behind the open prompt', async () => {
    const { sessionStore, permissionPrompts, call } = await load();
    await sessionStore.register(alice);
    const moving = call('tabs.navigate', { action: 'goto', url: `${SHOP}/cart` });
    await vi.waitFor(() => expect(permissionPrompts.list()).toHaveLength(1));
    const [prompt] = permissionPrompts.list();
    expect(prompt).toMatchObject({ tool: 'open', origin: SHOP });
    expect(prompt?.tab).toBeUndefined();
    expect(browser.tabs.size).toBe(0);
    await permissionPrompts.decide(prompt?.id ?? '', 'allow-once');
    const result = await moving;
    expect(result.opened).toBe(true);
    expect(result.page?.url).toBe(`${SHOP}/cart`);
  });

  it('reads a tab of the session already at the address as it is, without loading it, and makes it current', async () => {
    const { sessionStore, siteStore, call } = await load();
    await sessionStore.register(alice);
    await siteStore.set(SHOP, 'allow');
    const cart = await call('tabs.open', { url: `${SHOP}/cart` });
    const other = await call('tabs.open', { url: `${SHOP}/other` });
    const before = pageNavigations();
    const result = await call('tabs.open', { url: `${SHOP}/cart#total`, reuse: true });
    expect(result).toMatchObject({ reused: true, tab: { id: cart.tab.id }, page: { url: `${SHOP}/cart` } });
    expect(pageNavigations()).toEqual(before);
    expect((await sessionStore.get(alice.id))?.currentTabId).toBe(cart.tab.id);
    expect(other.tab.id).not.toBe(cart.tab.id);
  });

  it('opens a new tab for any other address, and never moves the owner\'s shared tab', async () => {
    const { sessionStore, siteStore, call } = await load();
    await sessionStore.register(alice);
    await siteStore.set(SHOP, 'allow');
    browser.addTab({ id: 7, url: `${SHOP}/checkout`, title: 'Checkout' });
    await sessionStore.share(alice.id, 7, SHOP);
    await sessionStore.setCurrentTab(alice.id, 7);
    const result = await call('tabs.open', { url: `${SHOP}/cart`, reuse: true });
    expect(result.reused).toBeUndefined();
    expect(result.tab.id).not.toBe(7);
    expect(browser.tabs.get(7)?.url).toBe(`${SHOP}/checkout`);
    expect(browser.commands.filter((command) => command.tabId === 7 && command.method === 'Page.navigate')).toEqual([]);
  });

  it('does not count a tab the session may not read yet, so the prompt says nothing about where it is', async () => {
    const { sessionStore, permissionPrompts, call } = await load();
    await sessionStore.register(alice);
    browser.addTab({ id: 7, url: `${SHOP}/checkout`, title: 'Checkout' });
    await sessionStore.share(alice.id, 7, undefined);
    const opening = call('tabs.open', { url: `${SHOP}/checkout`, reuse: true });
    await vi.waitFor(() => expect(permissionPrompts.list()).toHaveLength(1));
    expect(permissionPrompts.list()[0]).toMatchObject({ tool: 'open' });
    permissionPrompts.cancelSession(alice.id);
    await expect(opening).rejects.toThrow('declined');
  });
});
