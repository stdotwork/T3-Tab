import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ClaimStore, claimTabs, newClaimCode } from '../src/claims';
import { SessionStore } from '../src/sessions';
import { FakeBrowser } from './fake-browser';

const browser = new FakeBrowser();

beforeEach(() => {
  browser.reset();
  browser.install();
  const data: Record<string, unknown> = {};
  (globalThis as unknown as { chrome: { storage: unknown } }).chrome.storage = {
    session: {
      get: async (keys: string | string[]) =>
        Object.fromEntries([keys].flat().filter((key) => key in data).map((key) => [key, structuredClone(data[key])])),
      set: async (values: Record<string, unknown>) => {
        for (const [key, value] of Object.entries(values)) data[key] = structuredClone(value);
      },
    },
  };
});

describe('newClaimCode', () => {
  it('is url-safe and long enough for the daemon to accept', () => {
    const code = newClaimCode();
    expect(code).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
    expect(newClaimCode()).not.toBe(code);
  });
});

describe('ClaimStore', () => {
  it('returns the issued tabs, and nothing after revoke or for an unknown code', async () => {
    const claims = new ClaimStore();
    await claims.issue('code-a', [{ tabId: 1, origin: 'https://a.test' }, { tabId: 2 }]);
    expect(await claims.consume('other', 'message', 's')).toBeUndefined();
    expect(await claims.consume('code-a', 'message', 's')).toEqual([{ tabId: 1, origin: 'https://a.test' }, { tabId: 2 }]);
    await claims.issue('code-b', [{ tabId: 3 }]);
    await claims.revoke('code-b');
    expect(await claims.consume('code-b', 'message', 's')).toBeUndefined();
  });

  it('keeps only the 30 newest codes', async () => {
    const claims = new ClaimStore();
    for (let index = 0; index < 32; index += 1) {
      await claims.issue(`code-${index}`, [{ tabId: index }]);
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    expect(await claims.consume('code-0', 'message', 's')).toBeUndefined();
    expect(await claims.consume('code-1', 'message', 's')).toBeUndefined();
    expect(await claims.consume('code-2', 'message', 's')).toEqual([{ tabId: 2 }]);
    expect(await claims.consume('code-31', 'message', 's')).toEqual([{ tabId: 31 }]);
  });
});

describe('claimTabs', () => {
  async function setup(): Promise<{ claims: ClaimStore; sessions: SessionStore }> {
    const sessions = new SessionStore();
    await sessions.register({ id: 'sess', name: 'Sess' });
    return { claims: new ClaimStore(), sessions };
  }

  it('shares a tab still on its recorded origin with that origin approved', async () => {
    browser.addTab({ id: 1, url: 'https://a.test/page' });
    const { claims, sessions } = await setup();
    await claims.issue('code', [{ tabId: 1, origin: 'https://a.test' }]);
    expect(await claimTabs(claims, sessions, 'sess', 'code')).toEqual([1]);
    const session = await sessions.get('sess');
    expect(session?.sharedTabIds).toEqual([1]);
    expect(await sessions.hasApprovedOrigin('sess', 1, 'https://a.test')).toBe(true);
  });

  it('shares a tab that moved to another origin without approving it', async () => {
    browser.addTab({ id: 1, url: 'https://elsewhere.test/' });
    const { claims, sessions } = await setup();
    await claims.issue('code', [{ tabId: 1, origin: 'https://a.test' }]);
    expect(await claimTabs(claims, sessions, 'sess', 'code')).toEqual([1]);
    expect((await sessions.get('sess'))?.sharedTabIds).toEqual([1]);
    expect(await sessions.hasApprovedOrigin('sess', 1, 'https://elsewhere.test')).toBe(false);
    expect(await sessions.hasApprovedOrigin('sess', 1, 'https://a.test')).toBe(false);
  });

  it('shares a tab recorded without an origin unapproved', async () => {
    browser.addTab({ id: 1, url: 'https://a.test/' });
    const { claims, sessions } = await setup();
    await claims.issue('code', [{ tabId: 1 }]);
    await claimTabs(claims, sessions, 'sess', 'code');
    expect(await sessions.hasApprovedOrigin('sess', 1, 'https://a.test')).toBe(false);
  });

  it('skips a closed tab and still shares the others', async () => {
    browser.addTab({ id: 2, url: 'https://a.test/' });
    const { claims, sessions } = await setup();
    await claims.issue('code', [{ tabId: 1, origin: 'https://a.test' }, { tabId: 2, origin: 'https://a.test' }]);
    expect(await claimTabs(claims, sessions, 'sess', 'code')).toEqual([2]);
    expect((await sessions.get('sess'))?.sharedTabIds).toEqual([2]);
  });

  it('throws for an unknown code and shares nothing', async () => {
    browser.addTab({ id: 1, url: 'https://a.test/' });
    const { claims, sessions } = await setup();
    await expect(claimTabs(claims, sessions, 'sess', 'nope')).rejects.toThrow('Unknown claim code');
    expect((await sessions.get('sess'))?.sharedTabIds).toEqual([]);
  });
});

describe('single-use claim codes', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  async function setup(): Promise<{ claims: ClaimStore; sessions: SessionStore }> {
    browser.addTab({ id: 1, url: 'https://a.test/' });
    browser.addTab({ id: 2, url: 'https://b.test/' });
    const sessions = new SessionStore();
    await sessions.register({ id: 'sess', name: 'Sess' });
    await sessions.register({ id: 'other', name: 'Other' });
    return { claims: new ClaimStore(), sessions };
  }

  it('refuses a second redemption of the same code', async () => {
    const { claims, sessions } = await setup();
    await claims.issue('code', [{ tabId: 1, origin: 'https://a.test' }]);
    expect(await claimTabs(claims, sessions, 'sess', 'code')).toEqual([1]);
    await expect(claimTabs(claims, sessions, 'other', 'code')).rejects.toThrow('Unknown claim code');
    expect((await sessions.get('other'))?.sharedTabIds).toEqual([]);
  });

  it('does not share a tab again after the owner unshared it', async () => {
    const { claims, sessions } = await setup();
    await claims.issue('code', [{ tabId: 1, origin: 'https://a.test' }]);
    await claimTabs(claims, sessions, 'sess', 'code');
    await sessions.unshare('sess', 1);
    await expect(claimTabs(claims, sessions, 'sess', 'code')).rejects.toThrow('Unknown claim code');
    expect((await sessions.get('sess'))?.sharedTabIds).toEqual([]);
  });

  it('lets exactly one of two simultaneous redemptions through', async () => {
    const { claims, sessions } = await setup();
    await claims.issue('code', [{ tabId: 1, origin: 'https://a.test' }]);
    const results = await Promise.allSettled([
      claimTabs(claims, sessions, 'sess', 'code'),
      claimTabs(claims, sessions, 'other', 'code'),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  });

  it('refuses a code that has expired', async () => {
    const { claims, sessions } = await setup();
    vi.useFakeTimers({ toFake: ['Date'], now: 1_000_000 });
    await claims.issue('code', [{ tabId: 1, origin: 'https://a.test' }]);
    vi.setSystemTime(1_000_000 + 10 * 60_000 + 1);
    await expect(claimTabs(claims, sessions, 'sess', 'code')).rejects.toThrow('Unknown claim code');
    expect((await sessions.get('sess'))?.sharedTabIds).toEqual([]);
  });

  it('refuses a launch code offered through the tabs tool, and still honours it at launch', async () => {
    const { claims, sessions } = await setup();
    await claims.issue('code', [{ tabId: 1, origin: 'https://a.test' }], { route: 'launch' });
    await expect(claimTabs(claims, sessions, 'sess', 'code', 'message')).rejects.toThrow('Unknown claim code');
    expect(await claimTabs(claims, sessions, 'sess', 'code', 'launch')).toEqual([1]);
  });

  it('gives a resumed turn a fresh code without the tabs the owner unshared', async () => {
    const { claims, sessions } = await setup();
    const grant = await claims.issue('first', [{ tabId: 1, origin: 'https://a.test' }, { tabId: 2, origin: 'https://b.test' }], { route: 'launch' });
    await claims.bindConversation(grant, 'conversation');
    await claimTabs(claims, sessions, 'sess', 'first', 'launch');
    await sessions.unshare('sess', 1);
    await claims.forgetTab('sess', 1);
    expect(await claims.renew('conversation', 'second')).toBe(true);
    await expect(claimTabs(claims, sessions, 'other', 'first', 'launch')).rejects.toThrow('Unknown claim code');
    expect(await claimTabs(claims, sessions, 'other', 'second', 'launch')).toEqual([2]);
    expect(await claims.renew('no-such-conversation', 'third')).toBe(false);
  });

  it('drops an unshared tab from a code issued but not yet redeemed', async () => {
    const { claims, sessions } = await setup();
    const grant = await claims.issue('first', [{ tabId: 1, origin: 'https://a.test' }, { tabId: 2, origin: 'https://b.test' }], { route: 'launch' });
    await claims.bindConversation(grant, 'conversation');
    await claimTabs(claims, sessions, 'sess', 'first', 'launch');
    await claims.renew('conversation', 'second');
    await claims.forgetTab('sess', 1);
    expect(await claimTabs(claims, sessions, 'other', 'second', 'launch')).toEqual([2]);
  });
});
