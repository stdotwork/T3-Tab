import { beforeEach, describe, expect, it } from 'vitest';

import { ClaimStore, claimTabs } from '../src/claims';
import { SessionStore } from '../src/sessions';
import { attachToSessionGroup, expandStartedCollapsedGroup } from '../src/tabs';
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

async function setup(t3ThreadId?: string): Promise<{ claims: ClaimStore; sessions: SessionStore }> {
  const sessions = new SessionStore();
  await sessions.register({ id: 's', name: 'Agent' }, t3ThreadId);
  return { claims: new ClaimStore(), sessions };
}

/** Opens a tab for the session the way `tabs open` does, and returns the group update it made. */
async function openTab(claims: ClaimStore, sessions: SessionStore, id: number): Promise<Record<string, unknown> | undefined> {
  browser.addTab({ id, url: 'about:blank' });
  const session = await sessions.get('s');
  if (session === undefined) throw new Error('not registered');
  const before = browser.groupUpdates.length;
  await attachToSessionGroup(session, id, sessions, claims);
  return browser.groupUpdates.slice(before).at(-1)?.details;
}

describe('which sessions count as started from the side panel', () => {
  it('counts a session a grant lists, whatever the route', async () => {
    const { claims, sessions } = await setup();
    browser.addTab({ id: 1, url: 'https://a.test/' });
    await claims.issue('launch-code', [{ tabId: 1, origin: 'https://a.test' }], { route: 'launch' });
    expect(await claims.startedFromPanel('s')).toBe(false);
    await claimTabs(claims, sessions, 's', 'launch-code', 'launch');
    expect(await claims.startedFromPanel('s')).toBe(true);
    expect(await claims.startedFromPanel('other')).toBe(false);
  });

  it('counts a session given no tabs at the start, as a direct run started with none is', async () => {
    const { claims, sessions } = await setup();
    await claims.issue('empty', [], { route: 'launch' });
    await claimTabs(claims, sessions, 's', 'empty', 'launch');
    expect(await claims.startedFromPanel('s')).toBe(true);
  });

  it('counts a session whose proven T3 thread is one the panel launched, before it redeems the code', async () => {
    const { claims } = await setup('thread-1');
    await claims.issue('message-code', [], { route: 'message' });
    expect(await claims.startedFromPanel('s', 'thread-1')).toBe(false);
    expect(await claims.bindByCode('message-code', 't3:thread-1')).toBe(true);
    expect(await claims.startedFromPanel('s', 'thread-1')).toBe(true);
    expect(await claims.startedFromPanel('s', 'thread-2')).toBe(false);
    expect(await claims.startedFromPanel('s')).toBe(false);
    expect(await claims.startedFromPanel('s', '')).toBe(false);
  });

  it('does not count a direct run\'s conversation as a T3 thread', async () => {
    const { claims } = await setup('conversation');
    const grant = await claims.issue('launch-code', [], { route: 'launch' });
    await claims.bindConversation(grant, 'conversation');
    expect(await claims.startedFromPanel('s', 'conversation')).toBe(false);
  });

  it('does not count a code issued but never redeemed or bound', async () => {
    const { claims } = await setup();
    await claims.issue('waiting', [], { route: 'message' });
    expect(await claims.startedFromPanel('s')).toBe(false);
  });
});

describe('the tab group of a session that reached for the tools by itself', () => {
  it('is created collapsed with its first tab', async () => {
    const { claims, sessions } = await setup();
    expect(await openTab(claims, sessions, 1)).toEqual({ title: 'Agent', color: expect.any(String), collapsed: true });
    expect((await sessions.get('s'))?.groupStartedCollapsed).toBe(true);
  });

  it('is never collapsed or expanded again by the tabs it opens later, so an owner who expanded it keeps it open', async () => {
    const { claims, sessions } = await setup();
    await openTab(claims, sessions, 1);
    const later = await openTab(claims, sessions, 2);
    expect(later).not.toHaveProperty('collapsed');
    expect(browser.tabs.get(2)?.groupId).toBe(browser.tabs.get(1)?.groupId);
  });

  it('is created collapsed again when the old group is gone', async () => {
    const { claims, sessions } = await setup();
    await openTab(claims, sessions, 1);
    const old = (await sessions.get('s'))?.groupId ?? -1;
    browser.goneGroups.add(old);
    expect(await openTab(claims, sessions, 2)).toMatchObject({ collapsed: true });
    expect((await sessions.get('s'))?.groupId).not.toBe(old);
  });

  it('expands once its claim arrives after its first tab, and is not touched by a second expand', async () => {
    const { claims, sessions } = await setup();
    await openTab(claims, sessions, 1);
    const groupId = (await sessions.get('s'))?.groupId ?? -1;
    await claims.issue('late', [], { route: 'message' });
    await claimTabs(claims, sessions, 's', 'late', 'message');
    await expandStartedCollapsedGroup('s', sessions);
    expect(browser.groupUpdates.at(-1)).toEqual({ groupId, details: { collapsed: false } });
    expect((await sessions.get('s'))?.groupStartedCollapsed).toBeUndefined();
    const count = browser.groupUpdates.length;
    await expandStartedCollapsedGroup('s', sessions);
    expect(browser.groupUpdates.length).toBe(count);
  });

  it('expands at its next tab when the claim arrived without the expand step', async () => {
    const { claims, sessions } = await setup('thread-1');
    await openTab(claims, sessions, 1);
    await claims.issue('message-code', [], { route: 'message' });
    await claims.bindByCode('message-code', 't3:thread-1');
    expect(await openTab(claims, sessions, 2)).toMatchObject({ collapsed: false });
    expect((await sessions.get('s'))?.groupStartedCollapsed).toBeUndefined();
  });

  it('survives an expand after the group was closed', async () => {
    const { claims, sessions } = await setup();
    await openTab(claims, sessions, 1);
    browser.goneGroups.add((await sessions.get('s'))?.groupId ?? -1);
    await expect(expandStartedCollapsedGroup('s', sessions)).resolves.toBeUndefined();
  });
});

describe('the tab group of a session started from the side panel', () => {
  it('is created expanded and expanded again with each new tab, as before', async () => {
    const { claims, sessions } = await setup();
    await claims.issue('launch-code', [], { route: 'launch' });
    await claimTabs(claims, sessions, 's', 'launch-code', 'launch');
    expect(await openTab(claims, sessions, 1)).toMatchObject({ collapsed: false });
    expect(await openTab(claims, sessions, 2)).toMatchObject({ collapsed: false });
    expect((await sessions.get('s'))?.groupStartedCollapsed).toBeUndefined();
  });

  it('is not touched by an expand, which only opens a group T3-Tab created collapsed', async () => {
    const { claims, sessions } = await setup();
    await claims.issue('launch-code', [], { route: 'launch' });
    await claimTabs(claims, sessions, 's', 'launch-code', 'launch');
    await openTab(claims, sessions, 1);
    const count = browser.groupUpdates.length;
    await expandStartedCollapsedGroup('s', sessions);
    expect(browser.groupUpdates.length).toBe(count);
  });
});

describe('a group the owner made', () => {
  it('is never collapsed or expanded by an expand for a session that has no group', async () => {
    const { sessions } = await setup();
    browser.addTab({ id: 9, url: 'https://own.test/', groupId: 77 });
    await expandStartedCollapsedGroup('s', sessions);
    expect(browser.groupUpdates).toEqual([]);
  });
});
