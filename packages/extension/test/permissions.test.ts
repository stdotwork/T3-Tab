import { describe, expect, it } from 'vitest';

import {
  isOriginKey,
  originOf,
  ChromeSitePermissionStore,
  PermissionPrompts,
  restrictedPageError,
  restrictedPageReason,
  type SitePermission,
  type SitePermissionStore,
  type StoredSitePermission,
} from '../src/permissions';

class MemorySites implements SitePermissionStore {
  readonly sites = new Map<string, SitePermission>();

  async get(origin: string): Promise<SitePermission | undefined> {
    return this.sites.get(origin);
  }

  async set(origin: string, setting: SitePermission): Promise<void> {
    this.sites.set(origin, setting);
  }

  async list(): Promise<StoredSitePermission[]> {
    return [...this.sites].map(([origin, setting]) => ({ origin, setting }));
  }
}

const session = { id: 'session-a', name: 'Session A' };
const tab = { id: 7, title: 'Test tab' };

describe('origin and restricted-page policy', () => {
  it('keys permissions by normalized HTTP(S) origin', () => {
    expect(originOf('https://Example.COM:443/a?b=1')).toBe('https://example.com');
    expect(originOf('http://127.0.0.1:4321/path')).toBe('http://127.0.0.1:4321');
    expect(isOriginKey('https://example.com')).toBe(true);
    expect(isOriginKey('https://example.com/path')).toBe(false);
    expect(originOf('chrome://version')).toBeUndefined();
  });

  it('refuses every restricted scheme, the Chrome Web Store and view-source', () => {
    for (const url of [
      'chrome://version',
      'brave://settings',
      'edge://version',
      'devtools://devtools/bundled/inspector.html',
      'chrome-extension://gggnknbjooockcnnocejdolfdpjifebm/sidepanel.html',
      'https://chromewebstore.google.com/detail/example',
      'https://foo.chromewebstore.google.com/detail/example',
      'https://chrome.google.com/webstore/detail/example',
      'view-source:https://example.com',
      'file:///tmp/secret.html',
      'data:text/html,secret',
      'about:blank',
    ]) {
      expect(restrictedPageReason(url), url).toBeDefined();
      expect(restrictedPageError(url), url).toMatch(/^T3-Tab cannot access this page:/);
    }
    expect(restrictedPageReason('https://example.com/')).toBeUndefined();
  });
});

describe('per-site permission prompts', () => {
  it('defaults a new origin to ask, records it, and allows one call', async () => {
    const store = new MemorySites();
    const prompts = new PermissionPrompts(store, { makeId: () => 'p1' });
    const waiting = prompts.authorize('https://example.com', 'act', session, tab);
    await until(() => prompts.list().length === 1);
    expect(await store.get('https://example.com')).toBe('ask');
    expect(prompts.list()[0]).toMatchObject({ origin: 'https://example.com', tool: 'act', session });
    await prompts.decide('p1', 'allow-once');
    await expect(waiting).resolves.toBeUndefined();
    expect(await store.get('https://example.com')).toBe('ask');
    expect(prompts.list()).toEqual([]);
  });

  it('skips the prompt for an allowed site and persists always-allow', async () => {
    const store = new MemorySites();
    store.sites.set('https://allowed.test', 'allow');
    const allowed = new PermissionPrompts(store, { makeId: () => 'p1' });
    await expect(allowed.authorize('https://allowed.test', 'run_js', session, tab)).resolves.toBeUndefined();
    expect(allowed.list()).toEqual([]);

    const prompts = new PermissionPrompts(store, { makeId: () => 'p2' });
    const waiting = prompts.authorize('https://asked.test', 'open', session, tab);
    await until(() => prompts.list().length === 1);
    await prompts.decide('p2', 'always-allow');
    await expect(waiting).resolves.toBeUndefined();
    expect(await store.get('https://asked.test')).toBe('allow');
  });

  it('keeps prompts in arrival order and includes the tab in each prompt', async () => {
    let next = 0;
    const prompts = new PermissionPrompts(new MemorySites(), { makeId: () => `p${++next}` });
    const first = prompts.authorize('https://z.test', 'read', session, { id: 9, title: 'Zed' });
    const second = prompts.authorize('https://a.test', 'act', session, { id: 10, title: 'Alpha' });
    await until(() => prompts.list().length === 2);
    expect(prompts.list().map((prompt) => prompt.id)).toEqual(['p1', 'p2']);
    expect(prompts.list()[1]).toMatchObject({ tool: 'act', tab: { id: 10, title: 'Alpha' } });
    prompts.cancelSession(session.id);
    await expect(first).rejects.toThrow('Permission declined');
    await expect(second).rejects.toThrow('Permission declined');
  });

  it('caps pending prompts per session without blocking an allowed site', async () => {
    let next = 0;
    const store = new MemorySites();
    const prompts = new PermissionPrompts(store, { makeId: () => `p${++next}` });
    const waiting = [
      prompts.authorize('https://one.test', 'act', session, tab),
      prompts.authorize('https://two.test', 'act', session, tab),
      prompts.authorize('https://three.test', 'act', session, tab),
    ];
    await until(() => prompts.list().length === 3);
    await expect(prompts.authorize('https://four.test', 'act', session, tab)).rejects.toThrow(
      'Too many permission requests for this session (maximum 3)',
    );
    store.sites.set('https://allowed.test', 'allow');
    await expect(prompts.authorize('https://allowed.test', 'act', session, tab)).resolves.toBeUndefined();
    prompts.cancelSession(session.id);
    await Promise.allSettled(waiting);
  });

  it('declines the waiting tool call', async () => {
    const prompts = new PermissionPrompts(new MemorySites(), { makeId: () => 'p1' });
    const waiting = prompts.authorize('https://declined.test', 'act', session, tab);
    await until(() => prompts.list().length === 1);
    await prompts.decide('p1', 'decline');
    await expect(waiting).rejects.toThrow('Permission declined for https://declined.test.');
  });

  it('times out as a decline and removes the prompt', async () => {
    const prompts = new PermissionPrompts(new MemorySites(), { timeoutMs: 20, makeId: () => 'p1' });
    await expect(prompts.authorize('https://slow.test', 'act', session, tab)).rejects.toThrow(
      'Permission for https://slow.test timed out and was declined.',
    );
    expect(prompts.list()).toEqual([]);
  });

  it('serialises site-permission writes so concurrent changes are retained', async () => {
    const data: Record<string, unknown> = {};
    const storage = {
      async get(key: string) {
        return { [key]: structuredClone(data[key]) };
      },
      async set(items: Record<string, unknown>) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        Object.assign(data, items);
      },
    };
    const store = new ChromeSitePermissionStore(storage);
    await Promise.all([store.set('https://one.test', 'allow'), store.set('https://two.test', 'ask')]);
    expect(await store.list()).toEqual([
      { origin: 'https://one.test', setting: 'allow' },
      { origin: 'https://two.test', setting: 'ask' },
    ]);
  });

  it('cancels a session\'s waiting prompts when its MCP client disconnects', async () => {
    const prompts = new PermissionPrompts(new MemorySites(), { makeId: () => 'p1' });
    const waiting = prompts.authorize('https://closed.test', 'act', session, tab);
    await until(() => prompts.list().length === 1);
    prompts.cancelSession(session.id);
    await expect(waiting).rejects.toThrow('Permission declined for https://closed.test.');
    expect(prompts.list()).toEqual([]);
  });

  it('reports decisions for prompts that are no longer waiting', async () => {
    const prompts = new PermissionPrompts(new MemorySites());
    await expect(prompts.decide('missing', 'allow-once')).rejects.toThrow('no longer waiting');
  });
});

async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Condition was not met in time');
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}
