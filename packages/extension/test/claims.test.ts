import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ClaimStore, claimTabs, newClaimCode, removeConversationTab } from '../src/claims';
import { SessionStore } from '../src/sessions';
import { FakeBrowser } from './fake-browser';

const browser = new FakeBrowser();
/** Set by a test to make one storage write fail; it sees the keys being written. */
let failWrite: ((keys: string[]) => boolean) | undefined;

/** Redeems a code without sharing anything, for tests of the store alone. */
async function redeem(claims: ClaimStore, code: string, route: 'launch' | 'message' = 'message'): Promise<unknown> {
  const reservation = await claims.reserve(code, route, 's');
  return reservation === undefined ? undefined : await claims.finish(code, reservation.token);
}

beforeEach(() => {
  failWrite = undefined;
  browser.reset();
  browser.install();
  const data: Record<string, unknown> = {};
  (globalThis as unknown as { chrome: { storage: unknown } }).chrome.storage = {
    session: {
      get: async (keys: string | string[]) =>
        Object.fromEntries([keys].flat().filter((key) => key in data).map((key) => [key, structuredClone(data[key])])),
      set: async (values: Record<string, unknown>) => {
        if (failWrite?.(Object.keys(values)) === true) throw new Error('storage write failed');
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
    expect(await redeem(claims, 'other')).toBeUndefined();
    expect(await redeem(claims, 'code-a')).toEqual([{ tabId: 1, origin: 'https://a.test' }, { tabId: 2 }]);
    await claims.issue('code-b', [{ tabId: 3 }]);
    await claims.revoke('code-b');
    expect(await redeem(claims, 'code-b')).toBeUndefined();
  });

  it('keeps only the 30 newest codes', async () => {
    const claims = new ClaimStore();
    for (let index = 0; index < 32; index += 1) {
      await claims.issue(`code-${index}`, [{ tabId: index }]);
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    expect(await redeem(claims, 'code-0')).toBeUndefined();
    expect(await redeem(claims, 'code-1')).toBeUndefined();
    expect(await redeem(claims, 'code-2')).toEqual([{ tabId: 2 }]);
    expect(await redeem(claims, 'code-31')).toEqual([{ tabId: 31 }]);
  });
});

describe('the T3 threads a session needs Full access from', () => {
  const held = async (conversationId?: string): Promise<ClaimStore> => {
    browser.addTab({ id: 1, url: 'https://a.test/page' });
    const sessions = new SessionStore();
    await sessions.register({ id: 'sess', name: 'Sess' });
    const claims = new ClaimStore();
    const grant = await claims.issue('code', [{ tabId: 1, origin: 'https://a.test' }]);
    if (conversationId !== undefined) await claims.bindConversation(grant, conversationId);
    await claimTabs(claims, sessions, 'sess', 'code');
    return claims;
  };

  it('is the proven thread for a session with no grants, and nothing without one', async () => {
    const claims = new ClaimStore();
    expect(await claims.t3ThreadsOf('sess', 'th-a')).toEqual(['th-a']);
    expect(await claims.t3ThreadsOf('sess')).toBeUndefined();
  });

  it('needs the proven thread and every thread a grant is bound to', async () => {
    const claims = await held('t3:th-b');
    expect((await claims.t3ThreadsOf('sess', 'th-a'))?.sort()).toEqual(['th-a', 'th-b']);
  });

  it('lets a proven thread hold a code not bound yet, which alone never counts', async () => {
    const claims = await held();
    expect(await claims.t3ThreadsOf('sess', 'th-a')).toEqual(['th-a']);
    expect(await claims.t3ThreadsOf('sess')).toBeUndefined();
  });

  it("never counts a session holding a direct run's grant", async () => {
    const claims = await held('direct-1');
    expect(await claims.t3ThreadsOf('sess', 'th-a')).toBeUndefined();
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

describe('a redemption that fails part way', () => {
  const TABS = [{ tabId: 1, origin: 'https://a.test' }, { tabId: 2, origin: 'https://b.test' }];

  async function setup(): Promise<{ claims: ClaimStore; sessions: SessionStore }> {
    browser.addTab({ id: 1, url: 'https://a.test/' });
    browser.addTab({ id: 2, url: 'https://b.test/' });
    const sessions = new SessionStore();
    await sessions.register({ id: 'sess', name: 'Sess' });
    await sessions.register({ id: 'other', name: 'Other' });
    const claims = new ClaimStore();
    await claims.issue('code', TABS, { route: 'launch' });
    return { claims, sessions };
  }

  /** Fails the `count`-th write of the claim records from now on, once. */
  function failClaimWrite(count: number): void {
    let seen = 0;
    failWrite = (keys) => {
      if (!keys.includes('claims')) return false;
      seen += 1;
      return seen === count;
    };
  }

  it('keeps the code when sharing fails, so the retry shares the tabs', async () => {
    const { claims, sessions } = await setup();
    let failed = false;
    failWrite = (keys) => {
      if (failed || !keys.includes('sessions')) return false;
      failed = true;
      return true;
    };
    await expect(claimTabs(claims, sessions, 'sess', 'code', 'launch')).rejects.toThrow('storage write failed');
    expect((await sessions.get('sess'))?.sharedTabIds).toEqual([]);
    expect(await claimTabs(claims, sessions, 'sess', 'code', 'launch')).toEqual([1, 2]);
  });

  it('keeps the code when the session is gone, and the code still works once', async () => {
    const { claims, sessions } = await setup();
    await sessions.unregister('sess');
    await expect(claimTabs(claims, sessions, 'sess', 'code', 'launch')).rejects.toThrow('Session is not registered');
    expect(await claimTabs(claims, sessions, 'other', 'code', 'launch')).toEqual([1, 2]);
    await expect(claimTabs(claims, sessions, 'other', 'code', 'launch')).rejects.toThrow('Unknown claim code');
  });

  it('rolls back every share and approval when the code cannot be used up, and the retry works', async () => {
    const { claims, sessions } = await setup();
    failClaimWrite(2);
    await expect(claimTabs(claims, sessions, 'sess', 'code', 'launch')).rejects.toThrow('storage write failed');
    const session = await sessions.get('sess');
    expect(session?.sharedTabIds).toEqual([]);
    expect(session?.approvedOrigins).toEqual({});
    failWrite = undefined;
    expect(await claimTabs(claims, sessions, 'sess', 'code', 'launch')).toEqual([1, 2]);
  });

  it('leaves a tab the session already had when it rolls back', async () => {
    const { claims, sessions } = await setup();
    await sessions.share('sess', 1, 'https://a.test');
    failClaimWrite(2);
    await expect(claimTabs(claims, sessions, 'sess', 'code', 'launch')).rejects.toThrow('storage write failed');
    const session = await sessions.get('sess');
    expect(session?.sharedTabIds).toEqual([1]);
    expect(await sessions.hasApprovedOrigin('sess', 1, 'https://a.test')).toBe(true);
    expect(await sessions.hasApprovedOrigin('sess', 2, 'https://b.test')).toBe(false);
  });

  it('refuses another session while the code is reserved, and releases it after a failure', async () => {
    const { claims, sessions } = await setup();
    const reservation = await claims.reserve('code', 'launch', 'sess');
    expect(reservation).toBeDefined();
    await expect(claimTabs(claims, sessions, 'other', 'code', 'launch')).rejects.toThrow('Unknown claim code');
    await claims.release('code', reservation?.token as string);
    expect(await claimTabs(claims, sessions, 'other', 'code', 'launch')).toEqual([1, 2]);
  });

  it('does not refuse the holder of a reservation as if the code were unknown', async () => {
    const { claims, sessions } = await setup();
    await claims.reserve('code', 'launch', 'sess');
    const failure = await claimTabs(claims, sessions, 'sess', 'code', 'launch').catch((error: Error) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).not.toMatch(/^Unknown claim code/);
  });

  it('lets a reservation lapse if its holder never finished', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: 1_000_000 });
    try {
      const { claims, sessions } = await setup();
      await claims.reserve('code', 'launch', 'sess');
      vi.setSystemTime(1_000_000 + 31_000);
      expect(await claimTabs(claims, sessions, 'other', 'code', 'launch')).toEqual([1, 2]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('still expires while reserved', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: 1_000_000 });
    try {
      const { claims, sessions } = await setup();
      await claims.reserve('code', 'launch', 'sess');
      vi.setSystemTime(1_000_000 + 60 * 60_000 + 1);
      await expect(claimTabs(claims, sessions, 'sess', 'code', 'launch')).rejects.toThrow('Unknown claim code');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("a conversation's shared tabs", () => {
  async function setup(route: 'launch' | 'message' = 'launch'): Promise<{ claims: ClaimStore; sessions: SessionStore }> {
    browser.addTab({ id: 1, url: 'https://a.test/' });
    browser.addTab({ id: 2, url: 'https://b.test/' });
    const sessions = new SessionStore();
    await sessions.register({ id: 'turn-1', name: 'Turn 1' });
    await sessions.register({ id: 'turn-2', name: 'Turn 2' });
    const claims = new ClaimStore();
    const grant = await claims.issue('first', [{ tabId: 1, origin: 'https://a.test' }, { tabId: 2, origin: 'https://b.test' }], { route });
    await claims.bindConversation(grant, 'conversation');
    return { claims, sessions };
  }

  it('lists the tabs each conversation holds', async () => {
    const { claims } = await setup();
    expect(await claims.conversationTabs()).toEqual({
      conversation: [{ tabId: 1, origin: 'https://a.test' }, { tabId: 2, origin: 'https://b.test' }],
    });
  });

  it('takes a tab back between turns, after the last turn has disconnected', async () => {
    const { claims, sessions } = await setup();
    await claimTabs(claims, sessions, 'turn-1', 'first', 'launch');
    // The turn ended: its MCP session is gone, so the panel has no control for it any more.
    await sessions.unregister('turn-1');
    await removeConversationTab(claims, sessions, 'conversation', 1);
    expect(await claims.conversationTabs()).toEqual({ conversation: [{ tabId: 2, origin: 'https://b.test' }] });
    expect(await claims.renew('conversation', 'second')).toBe(true);
    expect(await claimTabs(claims, sessions, 'turn-2', 'second', 'launch')).toEqual([2]);
    expect((await sessions.get('turn-2'))?.sharedTabIds).toEqual([2]);
  });

  it('gives the next turn no code once every tab is taken back', async () => {
    const { claims, sessions } = await setup();
    await claimTabs(claims, sessions, 'turn-1', 'first', 'launch');
    await removeConversationTab(claims, sessions, 'conversation', 1);
    await removeConversationTab(claims, sessions, 'conversation', 2);
    expect(await claims.renew('conversation', 'second')).toBe(false);
  });

  it('takes the tab from a session still connected, with its approval', async () => {
    const { claims, sessions } = await setup();
    await claimTabs(claims, sessions, 'turn-1', 'first', 'launch');
    expect(await sessions.hasApprovedOrigin('turn-1', 1, 'https://a.test')).toBe(true);
    await removeConversationTab(claims, sessions, 'conversation', 1);
    expect((await sessions.get('turn-1'))?.sharedTabIds).toEqual([2]);
    expect(await sessions.hasApprovedOrigin('turn-1', 1, 'https://a.test')).toBe(false);
  });

  it('drops the tab from a code issued for a turn that has not used it yet', async () => {
    const { claims, sessions } = await setup();
    await claimTabs(claims, sessions, 'turn-1', 'first', 'launch');
    await claims.renew('conversation', 'second');
    await removeConversationTab(claims, sessions, 'conversation', 1);
    expect(await claimTabs(claims, sessions, 'turn-2', 'second', 'launch')).toEqual([2]);
  });

  it('does not share a tab the owner takes back while the code is being redeemed', async () => {
    const { claims, sessions } = await setup();
    const realGet = chrome.tabs.get.bind(chrome.tabs);
    let removed = false;
    (chrome.tabs as unknown as { get: typeof chrome.tabs.get }).get = (async (tabId: number) => {
      if (!removed) {
        removed = true;
        await removeConversationTab(claims, sessions, 'conversation', 1);
      }
      return await realGet(tabId);
    }) as typeof chrome.tabs.get;
    expect(await claimTabs(claims, sessions, 'turn-1', 'first', 'launch')).toEqual([2]);
    expect((await sessions.get('turn-1'))?.sharedTabIds).toEqual([2]);
    expect(await sessions.hasApprovedOrigin('turn-1', 1, 'https://a.test')).toBe(false);
  });

  it('lists a T3 thread\'s tabs but never issues it a new code', async () => {
    const { claims } = await setup('message');
    expect(Object.keys(await claims.conversationTabs())).toEqual(['conversation']);
    expect(await claims.renew('conversation', 'second')).toBe(false);
  });

  it('ignores a conversation it does not know', async () => {
    const { claims, sessions } = await setup();
    await removeConversationTab(claims, sessions, 'nope', 1);
    expect((await claims.conversationTabs()).conversation).toHaveLength(2);
  });
});
