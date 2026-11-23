import { ensureAttached, onDialogOpen, openDialog } from './cdp';
import type { TabInfo } from '@t3-tab/protocol';

import { originOf, restrictedPageError, type SitePermission } from './permissions';
import {
  assertSessionTab,
  groupTitle,
  hasApprovedOrigin,
  sessionColor,
  sessionForPopup,
  tabInfo,
  usableSessionTabs,
  type SessionStore,
  type StoredSession,
} from './sessions';

const OPEN_TIMEOUT_MS = 15_000;
const OPENABLE_PROTOCOLS = new Set(['http:', 'https:']);
const grouping = new Map<string, Promise<unknown>>();

/** What the browser tools may show for a tab: the site setting for an origin, from the owner's site list. */
export type SiteSetting = (origin: string) => Promise<SitePermission | undefined>;

export async function listTabs(session: StoredSession, siteSetting: SiteSetting): Promise<TabInfo[]> {
  const [tabs, front] = await Promise.all([
    chrome.tabs.query({}),
    chrome.tabs.query({ active: true, lastFocusedWindow: true }),
  ]);
  const frontId = front[0]?.id;
  return await Promise.all(
    usableSessionTabs(session, tabs).map(async (tab) => await describeTab(session, tab, tab.id === frontId, siteSetting)),
  );
}

/**
 * A tab as the agent sees it. Its title and address are shown only for an origin the session approved for
 * that tab, or one the owner allows reading on; otherwise only the origin and that approval is needed.
 */
async function describeTab(
  session: StoredSession,
  tab: chrome.tabs.Tab,
  active: boolean,
  siteSetting: SiteSetting,
): Promise<TabInfo> {
  const origin = originOf(tab.url ?? tab.pendingUrl ?? '');
  if (origin === undefined || tab.id === undefined) return tabInfo(tab, active);
  if (hasApprovedOrigin(session, tab.id, origin)) return tabInfo(tab, active);
  const setting = await siteSetting(origin);
  if (setting === 'read' || setting === 'allow') return tabInfo(tab, active);
  return { ...tabInfo(tab, active), title: '', url: origin, needsApproval: true };
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
  // The debugger is on the tab before its page runs: a dialog opened earlier than that can never be answered.
  const created = await chrome.tabs.create({ url: 'about:blank', active: true });
  if (created.id === undefined) throw new Error('The browser did not create a tab');
  try {
    await attachToSessionGroup(session, created.id, store);
    await ensureAttached(created.id);
    await chrome.tabs.update(created.id, { url });
    await waitForLoad(created.id, OPEN_TIMEOUT_MS);
    await assertTabOrigin(created.id, origin);
    return { tab: tabInfo(await getTab(created.id), true), origin };
  } catch (error) {
    await chrome.tabs.remove(created.id).catch(() => undefined);
    throw error;
  }
}

export async function switchSessionTab(session: StoredSession, tabId: number, siteSetting: SiteSetting): Promise<TabInfo> {
  await resolveSessionTab(session, tabId);
  await chrome.tabs.update(tabId, { active: true });
  return await describeTab(session, await getTab(tabId), true, siteSetting);
}

/** One session tab as the agent sees it now, in front. */
export async function describeSessionTab(session: StoredSession, tabId: number, siteSetting: SiteSetting): Promise<TabInfo> {
  const tab = await resolveSessionTab(session, tabId);
  return await describeTab(session, tab, true, siteSetting);
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

/**
 * A tab a page opened is kept in its opener's session group, so the session that works in the opener can
 * use it. Only the opener's group decides: a tab opened from the owner's own tabs, shared ones included, is
 * left alone. The tab carries no origin approval, so its first read still prompts.
 */
export async function adoptPopupTab(tabId: number, sourceTabId: number, store: SessionStore): Promise<void> {
  try {
    const opener = await chrome.tabs.get(sourceTabId);
    const owner = sessionForPopup(await store.list(), opener);
    if (owner?.groupId === undefined) return;
    await chrome.tabs.group({ tabIds: [tabId], groupId: owner.groupId });
  } catch {
    // The popup, its opener or the group can close before adoption.
  }
}

async function assertTabOrigin(tabId: number, expectedOrigin: string): Promise<void> {
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
      stopWaiting();
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    };
    const listener = (updatedId: number, change: { status?: string }): void => {
      if (updatedId === tabId && change.status === 'complete') done();
    };
    const timer = setTimeout(done, timeoutMs);
    // A dialog holds the load open until it is answered, which the agent can only do once this returns.
    const stopWaiting = onDialogOpen(tabId, done);
    chrome.tabs.onUpdated.addListener(listener);
    if (openDialog(tabId) !== undefined) done();
    void chrome.tabs.get(tabId).then((tab) => {
      if (tab.status === 'complete' && tab.url !== undefined && tab.url !== '' && tab.url !== 'about:blank') done();
    });
  });
}
