import { beforeEach, describe, expect, it } from 'vitest';

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
      get: async (key: string) => (key in data ? { [key]: structuredClone(data[key]) } : {}),
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
    expect(await claims.get('code-a')).toEqual([{ tabId: 1, origin: 'https://a.test' }, { tabId: 2 }]);
    expect(await claims.get('other')).toBeUndefined();
    await claims.revoke('code-a');
    expect(await claims.get('code-a')).toBeUndefined();
  });

  it('keeps only the 30 newest codes', async () => {
    const claims = new ClaimStore();
    for (let index = 0; index < 32; index += 1) {
      await claims.issue(`code-${index}`, [{ tabId: index }]);
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    expect(await claims.get('code-0')).toBeUndefined();
    expect(await claims.get('code-1')).toBeUndefined();
    expect(await claims.get('code-2')).toEqual([{ tabId: 2 }]);
    expect(await claims.get('code-31')).toEqual([{ tabId: 31 }]);
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
