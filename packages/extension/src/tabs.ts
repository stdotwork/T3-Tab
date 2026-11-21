import type { TabInfo } from '@t3-tab/protocol';

import { originOf, restrictedPageError } from './permissions';
import {
  assertSessionTab,
  groupTitle,
  sessionColor,
  tabInfo,
  usableSessionTabs,
  type SessionStore,
  type StoredSession,
} from './sessions';

const OPEN_TIMEOUT_MS = 15_000;
const OPENABLE_PROTOCOLS = new Set(['http:', 'https:']);
const grouping = new Map<string, Promise<unknown>>();
const popupClaims = new Map<string, number>();

export async function listTabs(session: StoredSession): Promise<TabInfo[]> {
  const [tabs, front] = await Promise.all([
    chrome.tabs.query({}),
    chrome.tabs.query({ active: true, lastFocusedWindow: true }),
  ]);
  const frontId = front[0]?.id;
  return usableSessionTabs(session, tabs).map((tab) => tabInfo(tab, tab.id === frontId));
}

export async function resolveSessionTab(session: StoredSession, tab: number | undefined): Promise<chrome.tabs.Tab> {
  if (tab !== undefined) {
    const found = await getTab(tab);
    assertSessionTab(session, found);
    assertAllowedTab(found);
    return found;
  }
  const [all, front] = await Promise.all([
    chrome.tabs.query({}),
    chrome.tabs.query({ active: true, lastFocusedWindow: true }),
  ]);
  const usable = usableSessionTabs(session, all);
  const frontId = front[0]?.id;
  const selected = usable.find((candidate) => candidate.id === frontId) ?? usable[0];
  if (selected === undefined) throw new Error('No tab is available in this session. Open a tab or ask the owner to share one.');
  assertAllowedTab(selected);
  return selected;
}

export async function openSessionTab(
  session: StoredSession,
  url: string,
  store: SessionStore,
): Promise<{ tab: TabInfo; origin: string }> {
  const restricted = restrictedPageError(url);
  if (restricted !== undefined) throw new Error(restricted);
  if (!isOpenableUrl(url)) throw new Error('Only http and https URLs can be opened');
  const origin = originOf(url);
  if (origin === undefined) throw new Error('Only http and https URLs can be opened');
  const created = await chrome.tabs.create({ url, active: true });
  if (created.id === undefined) throw new Error('The browser did not create a tab');
  try {
    await attachToSessionGroup(session, created.id, store);
    await waitForLoad(created.id, OPEN_TIMEOUT_MS);
    await assertTabOrigin(created.id, origin);
    return { tab: tabInfo(await getTab(created.id), true), origin };
  } catch (error) {
    await chrome.tabs.remove(created.id).catch(() => undefined);
    throw error;
  }
}

export async function switchSessionTab(session: StoredSession, tabId: number): Promise<TabInfo> {
  await resolveSessionTab(session, tabId);
  await chrome.tabs.update(tabId, { active: true });
  return tabInfo(await getTab(tabId), true);
}

export async function closeSessionTab(session: StoredSession, tabId: number): Promise<number> {
  await resolveSessionTab(session, tabId);
  await chrome.tabs.remove(tabId);
  return tabId;
}

export function isOpenableUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return OPENABLE_PROTOCOLS.has(url.protocol) && restrictedPageError(value) === undefined;
  } catch {
    return false;
  }
}

async function getTab(tabId: number): Promise<chrome.tabs.Tab> {
  try {
    return await chrome.tabs.get(tabId);
  } catch {
    throw new Error(`No tab with id ${tabId}`);
  }
}

export function beginPopupCapture(session: StoredSession): () => void {
  if (session.groupId === undefined) return () => undefined;
  const id = crypto.randomUUID();
  popupClaims.set(id, session.groupId);
  return () => popupClaims.delete(id);
}

/** A window.open from a tab can inherit the wrong session group when that tab is not active. */
export async function adoptPopupTab(tab: chrome.tabs.Tab): Promise<void> {
  if (tab.id === undefined || tab.openerTabId === undefined) return;
  const claims = [...popupClaims.values()];
  if (claims.length !== 1) return;
  const groupId = claims[0];
  if (groupId === undefined) return;
  try {
    await chrome.tabs.group({ tabIds: [tab.id], groupId });
  } catch {
    // The popup or group can close before adoption.
  }
}

export async function assertTabOrigin(tabId: number, expectedOrigin: string): Promise<void> {
  const tab = await getTab(tabId);
  assertAllowedTab(tab);
  const url = tab.url ?? tab.pendingUrl ?? '';
  const actual = originOf(url);
  if (actual !== expectedOrigin) {
    throw new Error(
      `The page moved from ${expectedOrigin} to ${actual ?? 'an unknown origin'}. Read the new page and approve it before acting there.`,
    );
  }
}

function assertAllowedTab(tab: chrome.tabs.Tab): void {
  const error = restrictedPageError(tab.url ?? tab.pendingUrl ?? '');
  if (error !== undefined) throw new Error(error);
}

async function attachToSessionGroup(session: StoredSession, tabId: number, store: SessionStore): Promise<void> {
  await serialize(session.id, async () => {
    const stored = await store.get(session.id);
    if (stored === undefined) throw new Error('Session is not registered');
    let groupId = stored.groupId;
    if (groupId === undefined) {
      groupId = await chrome.tabs.group({ tabIds: [tabId] });
      await store.rememberGroup(session.id, groupId);
    } else {
      try {
        groupId = await chrome.tabs.group({ tabIds: [tabId], groupId });
      } catch {
        groupId = await chrome.tabs.group({ tabIds: [tabId] });
        await store.rememberGroup(session.id, groupId);
      }
    }
    await chrome.tabGroups.update(groupId, {
      title: groupTitle(session.name),
      color: sessionColor(session.id),
      collapsed: false,
    });
  });
}

async function serialize<T>(key: string, work: () => Promise<T>): Promise<T> {
  const previous = grouping.get(key) ?? Promise.resolve();
  const next = previous.then(work, work);
  const tracked = next.catch(() => undefined);
  grouping.set(key, tracked);
  try {
    return await next;
  } finally {
    if (grouping.get(key) === tracked) grouping.delete(key);
  }
}

/** Resolves when the tab finishes loading, or after the timeout: a slow page is still returned. */
async function waitForLoad(tabId: number, timeoutMs: number): Promise<void> {
  await new Promise<void>((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    };
    const listener = (updatedId: number, change: { status?: string }): void => {
      if (updatedId === tabId && change.status === 'complete') done();
    };
    const timer = setTimeout(done, timeoutMs);
    chrome.tabs.onUpdated.addListener(listener);
    void chrome.tabs.get(tabId).then((tab) => {
      if (tab.status === 'complete' && tab.url !== undefined && tab.url !== '' && tab.url !== 'about:blank') done();
    });
  });
}
