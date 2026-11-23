import type { TabInfo } from '@t3-tab/protocol';

import {
  DialogOpenError,
  documentEpoch,
  documentMethod,
  ensureAttached,
  holdInputFocus,
  privateWorld,
  sendCommand,
  waitForDocumentLoad,
} from './cdp';

import { originOf, restrictedPageError, type SitePermission } from './permissions';
import { settlePage } from './settle';
import {
  assertSessionTab,
  currentSessionTab,
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
const NO_TAB = 'No tab is available in this session. Open one with tabs (action "open", url) or ask the owner to share one from the T3-Tab panel.';

/** What the browser tools may show for a tab: the site setting for an origin, from the owner's site list. */
export type SiteSetting = (origin: string) => Promise<SitePermission | undefined>;

export async function listTabs(session: StoredSession, siteSetting: SiteSetting): Promise<TabInfo[]> {
  const [tabs, front] = await Promise.all([
    chrome.tabs.query({}),
    chrome.tabs.query({ active: true, lastFocusedWindow: true }),
  ]);
  const usable = usableSessionTabs(session, tabs);
  const currentId = currentSessionTab(session, usable, front[0]?.id)?.id;
  return await Promise.all(usable.map(async (tab) => await describeTab(session, tab, tab.id === currentId, siteSetting)));
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
  const selected = currentSessionTab(session, usableSessionTabs(session, all), front[0]?.id);
  if (selected === undefined) throw new Error(NO_TAB);
  assertAllowedTab(selected);
  return selected;
}

/**
 * Opens the page in a new tab of the session's group, behind the tab the owner is on, and makes it the session's
 * current tab. Call it only after the owner's answer: this is what sends the request and runs the page.
 */
export async function openSessionTab(session: StoredSession, url: string, store: SessionStore): Promise<number> {
  const restricted = restrictedPageError(url);
  if (restricted !== undefined) throw new Error(restricted);
  if (!isOpenableUrl(url)) throw new Error('Only http and https URLs can be opened');
  // The debugger is on the tab before its page runs: a dialog opened earlier than that can never be answered.
  const created = await chrome.tabs.create({ url: 'about:blank', active: false });
  if (created.id === undefined) throw new Error('The browser did not create a tab');
  try {
    await attachToSessionGroup(session, created.id, store);
    await ensureAttached(created.id);
    await loadAddress(created.id, url);
    await store.setCurrentTab(session.id, created.id);
    return created.id;
  } catch (error) {
    await chrome.tabs.remove(created.id).catch(() => undefined);
    throw error;
  }
}

/** Loads an address in the tab and waits for it. A fragment change on the same document has nothing to wait for. */
export async function loadAddress(tabId: number, url: string): Promise<void> {
  await navigated(tabId, async () => {
    const result = await sendCommand<{ loaderId?: string; errorText?: string }>(tabId, 'Page.navigate', { url });
    if (result.errorText !== undefined && result.errorText !== '') throw new Error(`Could not load ${url}: ${result.errorText}`);
    return result.loaderId !== undefined;
  });
}

/**
 * Runs a command that moves the tab, then waits for the new document to load and settle. A dialog that opens counts as
 * arrived. A hidden page gets no animation frames and slow timers, so a page that renders from script would stay blank:
 * the tab counts as visible until it has settled, and goes back to hidden.
 */
async function navigated(tabId: number, go: () => Promise<boolean>): Promise<void> {
  const since = documentEpoch(tabId);
  const release = await holdInputFocus(tabId);
  try {
    if (!(await go())) return;
    await waitForDocumentLoad(tabId, since, OPEN_TIMEOUT_MS);
    await settlePage(tabId);
  } catch (error) {
    if (!(error instanceof DialogOpenError)) throw error;
  } finally {
    await release();
  }
}

export interface HistoryTarget {
  entryId: number;
  url: string;
}

/** The page one step back or forward in the tab's history. The blank page a new tab starts on does not count. */
export async function historyTarget(tabId: number, direction: 'back' | 'forward'): Promise<HistoryTarget> {
  const history = await sendCommand<{ currentIndex: number; entries: Array<{ id: number; url: string }> }>(tabId, 'Page.getNavigationHistory');
  const entry = history.entries[history.currentIndex + (direction === 'back' ? -1 : 1)];
  if (entry === undefined || entry.url === 'about:blank') {
    throw new Error(`No ${direction === 'back' ? 'earlier' : 'later'} page in tab ${tabId}.`);
  }
  const restricted = restrictedPageError(entry.url);
  if (restricted !== undefined) throw new Error(restricted);
  return { entryId: entry.id, url: entry.url };
}

export async function goToHistoryEntry(tabId: number, entryId: number): Promise<void> {
  await navigated(tabId, async () => {
    await sendCommand(tabId, 'Page.navigateToHistoryEntry', { entryId });
    return true;
  });
}

/**
 * Loads the tab's page again. The browser's reload sends a form's POST again without asking, so unless the debugger
 * saw this document come from a GET, the address is fetched with a new GET through `location.replace`, from T3-Tab's
 * own world, which keeps the history as it is (`Page.navigate` and `chrome.tabs.update` each add an entry). That drops
 * the fragment, which would otherwise make it a same-document move that loads nothing.
 */
export async function reloadTab(tabId: number, url: string): Promise<void> {
  if (documentMethod(tabId) === 'GET') {
    await navigated(tabId, async () => {
      await sendCommand(tabId, 'Page.reload');
      return true;
    });
    return;
  }
  const address = new URL(url);
  address.hash = '';
  await navigated(tabId, async () => {
    await sendCommand(tabId, 'Runtime.evaluate', {
      contextId: await privateWorld(tabId),
      expression: `location.replace(${JSON.stringify(address.href)})`,
    });
    return true;
  });
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
