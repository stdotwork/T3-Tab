import { NO_TAB_MESSAGE, type TabInfo } from '@t3-tab/protocol';

import {
  blockedLoadCount,
  blockedLoadSince,
  DialogOpenError,
  documentEpoch,
  documentMethod,
  ensureAttached,
  holdInputFocus,
  privateWorld,
  sameDocumentMoveCount,
  sendCommand,
  waitForDocumentLoad,
} from './cdp';

import { joinTree } from './opened-tabs';
import { originOf, restrictedPageError, type SitePermission } from './permissions';
import { knownSecrets, rememberSecrets, scrubReported } from './secret-text';
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

/**
 * A load that has arrived. `newDocument` is false when nothing new was loaded: a move within the same document (a
 * fragment), or a dialog the page opened before it finished.
 */
export interface Landing {
  newDocument: boolean;
}

const ARRIVED: Landing = { newDocument: false };

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
  const selected = await sessionCurrentTab(session);
  if (selected === undefined) throw new Error(NO_TAB_MESSAGE);
  assertAllowedTab(selected);
  return selected;
}

/**
 * A tab of the session that already shows this address, the fragment aside, and whose page the session may read without
 * a prompt: only `tab` when it is given, else the current tab first. A tab still loading something else does not count.
 */
export async function sessionTabAt(
  session: StoredSession,
  url: string,
  tab: number | undefined,
  siteSetting: SiteSetting,
): Promise<chrome.tabs.Tab | undefined> {
  const wanted = withoutFragment(url);
  if (wanted === undefined) return undefined;
  let candidates: chrome.tabs.Tab[];
  if (tab !== undefined) {
    candidates = [await resolveSessionTab(session, tab)];
  } else {
    const [all, front] = await Promise.all([
      chrome.tabs.query({}),
      chrome.tabs.query({ active: true, lastFocusedWindow: true }),
    ]);
    const usable = usableSessionTabs(session, all);
    const current = currentSessionTab(session, usable, front[0]?.id);
    candidates = current === undefined ? usable : [current, ...usable.filter((other) => other.id !== current.id)];
  }
  for (const candidate of candidates) {
    if (candidate.pendingUrl !== undefined || candidate.url === undefined || withoutFragment(candidate.url) !== wanted) continue;
    if (restrictedPageError(candidate.url) !== undefined) continue;
    // A tab the session may not read yet does not count, so which prompt comes up says nothing about where that tab is.
    if (!(await describeTab(session, candidate, false, siteSetting)).needsApproval) return candidate;
  }
  return undefined;
}

function withoutFragment(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    return parsed.href;
  } catch {
    return undefined;
  }
}

/** The tab a call that names none uses, or nothing when the session has no tab. */
export async function sessionCurrentTab(session: StoredSession): Promise<chrome.tabs.Tab | undefined> {
  const [all, front] = await Promise.all([
    chrome.tabs.query({}),
    chrome.tabs.query({ active: true, lastFocusedWindow: true }),
  ]);
  return currentSessionTab(session, usableSessionTabs(session, all), front[0]?.id);
}

/**
 * Opens the page in a new tab of the session's group, behind the tab the owner is on, and makes it the session's
 * current tab. Call it only after the owner's answer: this is what sends the request and runs the page.
 */
export async function openSessionTab(
  session: StoredSession,
  url: string,
  store: SessionStore,
): Promise<Landing & { tabId: number }> {
  const restricted = restrictedPageError(url);
  if (restricted !== undefined) throw new Error(restricted);
  if (!isOpenableUrl(url)) throw new Error('Only http and https URLs can be opened');
  // The debugger is on the tab before its page runs: a dialog opened earlier than that can never be answered.
  const created = await chrome.tabs.create({ url: 'about:blank', active: false });
  if (created.id === undefined) throw new Error('The browser did not create a tab');
  try {
    await attachToSessionGroup(session, created.id, store);
    await ensureAttached(created.id);
    const landing = await loadAddress(created.id, url);
    await store.setCurrentTab(session.id, created.id);
    return { ...landing, tabId: created.id };
  } catch (error) {
    await chrome.tabs.remove(created.id).catch(() => undefined);
    throw error;
  }
}

export const HTTPS_UPGRADE_FAILED = 'the browser upgraded the address to https and the https site did not answer';

/**
 * Why a load failed. The browser upgrades an `http:` address to `https:` before sending anything and reports the failed
 * upgrade (the https site did not answer, or reset the connection) as `net::ERR_BLOCKED_BY_CLIENT`, which reads as if
 * something blocked the page. That error on an `http:` address is the upgrade. (An extension that blocks requests gives
 * the same error, and is named the same way: the browser does not tell the two apart.)
 */
export function loadFailure(url: string, errorText: string): string {
  return `Could not load ${url}: ${errorText === 'net::ERR_BLOCKED_BY_CLIENT' && isHttp(url) ? `${HTTPS_UPGRADE_FAILED}.` : errorText}`;
}

export function isHttp(url: string): boolean {
  try {
    return new URL(url).protocol === 'http:';
  } catch {
    return false;
  }
}

/** Loads an address in the tab and waits for it. A fragment change on the same document has nothing to wait for. */
export async function loadAddress(tabId: number, url: string): Promise<Landing> {
  return await navigated(tabId, async () => {
    const result = await sendCommand<{ loaderId?: string; errorText?: string }>(tabId, 'Page.navigate', { url });
    if (result.errorText !== undefined && result.errorText !== '') throw new Error(loadFailure(url, result.errorText));
    return result.loaderId !== undefined;
  });
}

/**
 * Runs a command that moves the tab, then waits for the new document to load and paint its first frames. A dialog that
 * opens counts as arrived. A hidden page gets no animation frames and slow timers, so a page that renders from script
 * would stay blank: the tab counts as visible until it has settled, which goes on after this returns so the agent is not
 * kept waiting, and then goes back to hidden.
 */
async function navigated(tabId: number, go: () => Promise<boolean>, throughHistory = false): Promise<Landing> {
  const since = documentEpoch(tabId);
  const blocked = blockedLoadCount(tabId);
  // A history entry can belong to this same document (a fragment, `pushState`), which fires no load event.
  const moves = throughHistory ? sameDocumentMoveCount(tabId) : undefined;
  const release = await holdInputFocus(tabId);
  let settling = false;
  try {
    if (!(await go())) return ARRIVED;
    await waitForDocumentLoad(tabId, since, OPEN_TIMEOUT_MS, moves);
    // A reload or a step through history has no reply of its own that says the load failed.
    const unreachable = blockedLoadSince(tabId, blocked);
    // The address came from the page (a link, a form), so it can hold a value the page treats as secret.
    if (unreachable !== undefined && isHttp(unreachable)) {
      throw new Error(loadFailure(scrubReported(tabId, unreachable, true), 'net::ERR_BLOCKED_BY_CLIENT'));
    }
    await firstFrames(tabId);
    settling = true;
    void settlePage(tabId)
      .catch(() => undefined)
      .finally(() => void release());
    return { newDocument: true };
  } catch (error) {
    if (!(error instanceof DialogOpenError)) throw error;
    return ARRIVED;
  } finally {
    if (!settling) await release();
  }
}

/** Two animation frames, or 100 ms if the page produces none. */
async function firstFrames(tabId: number): Promise<void> {
  await sendCommand(tabId, 'Runtime.evaluate', {
    contextId: await privateWorld(tabId),
    awaitPromise: true,
    expression: 'new Promise((done) => { setTimeout(done, 100); requestAnimationFrame(() => requestAnimationFrame(done)); })',
  });
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

export async function goToHistoryEntry(tabId: number, entryId: number): Promise<Landing> {
  return await navigated(tabId, async () => {
    await sendCommand(tabId, 'Page.navigateToHistoryEntry', { entryId });
    return true;
  }, true);
}

/**
 * Loads the tab's page again. The browser's reload sends a form's POST again without asking, so unless the debugger
 * saw this document come from a GET, the address is fetched with a new GET through `location.replace`, from T3-Tab's
 * own world, which keeps the history as it is (`Page.navigate` and `chrome.tabs.update` each add an entry). That drops
 * the fragment, which would otherwise make it a same-document move that loads nothing.
 */
export async function reloadTab(tabId: number, url: string): Promise<Landing> {
  if (documentMethod(tabId) === 'GET') {
    return await navigated(tabId, async () => {
      await sendCommand(tabId, 'Page.reload');
      return true;
    });
  }
  const address = new URL(url);
  address.hash = '';
  return await navigated(tabId, async () => {
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
 * left alone. The tab carries no origin approval, so its first read still prompts, and it joins its opener's tree of
 * openers, whose secret values are taken out of its title and address.
 */
export async function adoptPopupTab(tabId: number, sourceTabId: number, store: SessionStore): Promise<void> {
  // A form the opener sent into the new tab (a GET form with a target) puts its values in the new tab's address and title,
  // so the tab joins its opener's tree and the opener's values are kept for the tree, which scrubs the title and address
  // of its tabs. Done before anything else, while the tab is still loading; what the tree learns later reaches it too.
  joinTree(sourceTabId, tabId);
  rememberSecrets(sourceTabId, knownSecrets(sourceTabId));
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
