import type { BrowserMethods, BrowserRequestMessage, LoadOptions, PageReadResult, TabLoadResult, ToolSession } from '@t3-tab/protocol';

import { actOnPage } from './actions';
import { claimTabs } from './claims';
import { setRecoveryOrigin } from './cdp';
import { evaluatePage } from './evaluate';
import { readPage } from './page';
import { originOf, promptAddress, restrictedPageError, type AuthorizeResult, type PromptTab } from './permissions';
import { claimStore, permissionPrompts, sessionStore, siteStore } from './runtime';
import { captureViewport } from './screenshot';
import { pageTextLength, settleSnapshot, type SettleSnapshot } from './settle';
import type { StoredSession } from './sessions';
import {
  closeSessionTab,
  describeSessionTab,
  goToHistoryEntry,
  historyTarget,
  isOpenableUrl,
  listTabs,
  loadAddress,
  openSessionTab,
  reloadTab,
  resolveSessionTab,
  sessionCurrentTab,
  sessionTabAt,
  switchSessionTab,
  type Landing,
  type SiteSetting,
} from './tabs';

/**
 * A load's reply reads the page once its document has loaded and drawn its first frames, without waiting for it to go
 * quiet. When the page moved while it was read and that read ended within this long, it is read once more. A page that
 * never stops moving costs at most this and one more read.
 */
const LOAD_REREAD_MS = 100;

/** Said in a load's reply in place of the page when the Full access pass the load went through no longer holds. */
const FULL_ACCESS_ENDED = 'T3 no longer confirms Full access for this thread, so the page is left out: read it to ask the owner.';

/**
 * What a session may see of a tab it holds no approval for. Full access shows it while T3 confirms the mode, and records
 * nothing, so the tab goes back to `[needs approval]` when the thread leaves Full access.
 */
const tabAccess = (session: ToolSession): SiteSetting => async (origin) => {
  const setting = await siteStore.get(origin);
  if (setting === 'read' || setting === 'allow') return setting;
  return (await permissionPrompts.hasFullAccess(session.id)) ? 'read' : setting;
};

/** A real approval is kept for the tab. A pass from Full access is not, so later requests ask T3 again. */
async function recordApproval(pass: AuthorizeResult, sessionId: string, tabId: number, origin: string): Promise<void> {
  if (pass !== 'full-access') await sessionStore.approveOrigin(sessionId, tabId, origin);
}

/** Runs one request from the background program and returns its result. Throws a readable message on failure. */
export async function handleRequest(request: BrowserRequestMessage): Promise<unknown> {
  if (request.method === 'session.register') {
    await sessionStore.register(request.session, request.params.t3ThreadId);
    return { registered: true } satisfies BrowserMethods['session.register']['result'];
  }
  if (request.method === 'session.unregister') {
    permissionPrompts.cancelSession(request.session.id);
    await sessionStore.unregister(request.session.id);
    return { unregistered: true } satisfies BrowserMethods['session.unregister']['result'];
  }

  const session = await registeredSession(request.session);
  switch (request.method) {
    case 'session.claim':
      return {
        shared: await claimTabs(claimStore, sessionStore, session.id, request.params.code, request.params.route),
      } satisfies BrowserMethods['session.claim']['result'];
    case 'prompt.decide': {
      // An agent can answer only a prompt of its own session, and only once or by declining: never a lasting setting.
      const { promptId, decision } = request.params;
      if (decision !== 'allow-once' && decision !== 'decline') throw new Error('Invalid answer');
      const prompt = permissionPrompts.list().find((waiting) => waiting.id === promptId);
      if (prompt === undefined || prompt.session.id !== session.id) throw new Error('No such permission request for this session');
      await permissionPrompts.decide(promptId, decision);
      return { decided: true } satisfies BrowserMethods['prompt.decide']['result'];
    }
    case 'tabs.list':
      return { tabs: await listTabs(session, tabAccess(session)) } satisfies BrowserMethods['tabs.list']['result'];
    case 'tabs.open':
      return await openOrReuse(session, request.params);
    case 'tabs.navigate':
      return await navigateTab(session, request.params);
    case 'tabs.switch': {
      const tab = await switchSessionTab(session, request.params.tab, tabAccess(session));
      await sessionStore.setCurrentTab(session.id, tab.id);
      return { tab } satisfies BrowserMethods['tabs.switch']['result'];
    }
    case 'tabs.close':
      return { closed: await closeSessionTab(session, request.params.tab) } satisfies BrowserMethods['tabs.close']['result'];
    case 'page.read': {
      const access = await authorizeRead(session, request.params.tab);
      return await readPage(access.session, access.tab.id, access.origin, async () => await registeredSession(session));
    }
    case 'page.screenshot': {
      const access = await authorizeRead(session, request.params.tab);
      const tab = await resolveSessionTab(access.session, access.tab.id);
      assertSameOrigin(tab, access.origin);
      const tabId = tab.id ?? -1;
      return await captureViewport(tabId, request.params.maxEdge, {
        origin: access.origin,
        currentUrl: async () => {
          const latest = await resolveSessionTab(await registeredSession(session), tabId);
          return latest.url ?? latest.pendingUrl ?? '';
        },
      });
    }
    case 'page.act': {
      let tab = await resolveSessionTab(session, request.params.tab);
      const origin = tabOrigin(tab);
      await sessionStore.observeTabOrigin(tab.id ?? -1, origin);
      const pass = await permissionPrompts.authorize(origin, 'act', session, promptTab(tab));
      await registeredSession(session);
      await recordApproval(pass, session.id, tab.id ?? -1, origin);
      const currentSession = await registeredSession(session);
      tab = await resolveSessionTab(currentSession, tab.id);
      assertSameOrigin(tab, origin);
      return await actOnPage(
        currentSession,
        tab.id ?? -1,
        request.params.steps,
        request.params.backendIds,
        request.params.epoch,
        origin,
        async () => await registeredSession(session),
      );
    }
    case 'page.eval': {
      let tab = await resolveSessionTab(session, request.params.tab);
      const origin = tabOrigin(tab);
      await sessionStore.observeTabOrigin(tab.id ?? -1, origin);
      const pass = await permissionPrompts.authorize(origin, 'run_js', session, promptTab(tab));
      await registeredSession(session);
      await recordApproval(pass, session.id, tab.id ?? -1, origin);
      const currentSession = await registeredSession(session);
      tab = await resolveSessionTab(currentSession, tab.id);
      assertSameOrigin(tab, origin);
      return await evaluatePage(currentSession, tab.id, request.params.expression, origin, async () =>
        await registeredSession(session),
      );
    }
    default:
      throw new Error(`Unknown request: ${String((request as { method?: unknown }).method)}`);
  }
}

async function registeredSession(session: ToolSession): Promise<StoredSession> {
  const existing = await sessionStore.get(session.id);
  if (existing === undefined) throw new Error('Session is not registered. Restart the MCP client.');
  return existing;
}

/** The origin of an address a tool may load, or a readable refusal. */
function loadableOrigin(url: string): string {
  const error = restrictedPageError(url);
  if (error !== undefined) throw new Error(error);
  const origin = isOpenableUrl(url) ? originOf(url) : undefined;
  if (origin === undefined) throw new Error('Only http and https URLs can be opened');
  return origin;
}

/**
 * `read` with an address: a tab of the session already showing it is read as it is, never moved or loaded again, and
 * becomes the current tab. Otherwise the address opens in a new tab, as `tabs open` does.
 */
async function openOrReuse(
  session: StoredSession,
  params: BrowserMethods['tabs.open']['params'],
): Promise<BrowserMethods['tabs.open']['result']> {
  loadableOrigin(params.url);
  const options: LoadOptions = params.skipReadOver === undefined ? {} : { skipReadOver: params.skipReadOver };
  if (params.reuse !== true) return await openTabForSession(session, params.url, options);
  const found = await sessionTabAt(session, params.url, params.tab, tabAccess(session));
  if (found?.id === undefined) return await openTabForSession(session, params.url, options);
  const access = await authorizeRead(session, found.id);
  const tabId = access.tab.id ?? -1;
  await sessionStore.setCurrentTab(session.id, tabId);
  const page = await readPage(access.session, tabId, access.origin, async () => await registeredSession(session));
  const tab = await describeSessionTab(await registeredSession(session), tabId, tabAccess(session));
  return { tab, page, reused: true };
}

/** Asks first, for the requested address: nothing is created, fetched or run until the owner says yes. */
async function openTabForSession(
  session: StoredSession,
  url: string,
  options: LoadOptions = {},
): Promise<TabLoadResult> {
  const origin = loadableOrigin(url);
  const pass = await permissionPrompts.authorize(origin, 'open', session, undefined, promptAddress(url));
  const { tabId, ...landing } = await openSessionTab(await registeredSession(session), url, sessionStore);
  try {
    return await describeLanding(session, tabId, origin, pass, landing, options);
  } catch (failure) {
    await chrome.tabs.remove(tabId).catch(() => undefined);
    throw failure;
  }
}

/**
 * Moves an existing tab. A new address is asked for like `open`, every time, because it is one the agent chose and
 * loading it can change something on the site. Going through history or reloading revisits a page this tab has already
 * shown, so it asks only when that page is on an origin the session holds no approval for on this tab. A `goto` that
 * names no tab, in a session with no tab, opens one instead.
 */
async function navigateTab(
  session: StoredSession,
  params: BrowserMethods['tabs.navigate']['params'],
): Promise<BrowserMethods['tabs.navigate']['result']> {
  const { action } = params;
  if (action === 'goto' && params.tab === undefined && (await sessionCurrentTab(session)) === undefined) {
    if (params.url === undefined) throw new Error('goto needs a url');
    return { ...(await openTabForSession(session, params.url, loadOptions(params))), opened: true };
  }
  const tab = await resolveSessionTab(session, params.tab);
  const tabId = tab.id ?? -1;
  const origin = tabOrigin(tab);
  await sessionStore.observeTabOrigin(tabId, origin);
  const approved = await sessionStore.hasApprovedOrigin(session.id, tabId, origin);
  if (approved) setRecoveryOrigin(tabId, origin);

  let url: string;
  let entryId: number | undefined;
  if (action === 'goto') {
    if (params.url === undefined) throw new Error('goto needs a url');
    url = params.url;
  } else if (action === 'reload') {
    url = tab.url ?? tab.pendingUrl ?? '';
  } else {
    ({ url, entryId } = await historyTarget(tabId, action));
  }
  const target = loadableOrigin(url);
  const revisit = action !== 'goto' && approved && target === origin;
  const pass: AuthorizeResult = revisit
    ? 'approved'
    : await permissionPrompts.authorize(target, 'open', session, promptTab(tab), promptAddress(url));

  const current = await resolveSessionTab(await registeredSession(session), tabId);
  // Only a move from the page that was asked about: the tab may have gone elsewhere while the prompt waited.
  assertSameOrigin(current, origin);
  let landing: Landing;
  if (action === 'goto') landing = await loadAddress(tabId, url);
  else if (action === 'reload') landing = await reloadTab(tabId, current.url ?? url);
  else landing = await goToHistoryEntry(tabId, entryId ?? -1);
  await sessionStore.setCurrentTab(session.id, tabId);
  return await describeLanding(session, tabId, target, pass, landing, loadOptions(params));
}

function loadOptions(params: LoadOptions): LoadOptions {
  return params.skipReadOver === undefined ? {} : { skipReadOver: params.skipReadOver };
}

/**
 * Where a load ended up, and the page as it arrived. The approval covers the origin that was asked for, so a tab that a
 * redirect took elsewhere stays in the session unapproved: the agent is told the new origin, and its next read asks the
 * owner unless the site is allowed. The page is read only where a `read` would pass without a prompt, and goes into the
 * reply only if that still holds once it was read.
 */
async function describeLanding(
  session: StoredSession,
  tabId: number,
  requested: string,
  pass: AuthorizeResult,
  landing: Landing,
  options: LoadOptions = {},
): Promise<TabLoadResult> {
  const landed = await resolveSessionTab(await registeredSession(session), tabId);
  const origin = tabOrigin(landed);
  await sessionStore.observeTabOrigin(tabId, origin);
  if (origin === requested) await recordApproval(pass, session.id, tabId, origin);
  const current = await registeredSession(session);
  const described = await describeSessionTab(current, tabId, tabAccess(session));
  const result: TabLoadResult = origin === requested ? { tab: described } : { tab: described, redirectedFrom: requested };
  const readable = async (): Promise<boolean> => await readableAfterLoad(session, tabId, origin, requested, pass);
  if (!(await readable())) return pass === 'full-access' && origin === requested ? { ...result, unread: FULL_ACCESS_ENDED } : result;
  // A page too long for the reply to carry whole is left to the read the agent sends anyway, so it is not read twice.
  if (options.skipReadOver !== undefined) {
    const textLength = await pageTextLength(tabId);
    if (textLength > options.skipReadOver) return { ...result, textLength };
  }
  let page: PageReadResult;
  try {
    page = await readLanded(current, session, tabId, origin, landing);
  } catch (error) {
    return { ...result, unread: error instanceof Error ? error.message : String(error) };
  }
  // A pass from Full access holds only while T3 confirms the mode, which may have ended during the read. Then the tab is
  // described again, so its title and address are not shown either.
  if (!(await readable())) {
    const tab = await describeSessionTab(await registeredSession(session), tabId, tabAccess(session));
    return { ...result, tab, unread: FULL_ACCESS_ENDED };
  }
  return { ...result, page };
}

/**
 * Reads the page a load arrived at. A new document is read at once, without waiting for it to go quiet; if it moved
 * while it was read (its content, layout or document, not only its network traffic) and that took under
 * `LOAD_REREAD_MS`, it is read once more, after the first read ended, and that read is the answer.
 */
async function readLanded(
  current: StoredSession,
  session: StoredSession,
  tabId: number,
  origin: string,
  landing: Landing,
): Promise<PageReadResult> {
  const reload = async (): Promise<StoredSession> => await registeredSession(session);
  if (!landing.newDocument) return await readPage(current, tabId, origin, reload);
  const startedAt = Date.now();
  const before = await settleSnapshot(tabId);
  try {
    const page = await readPage(current, tabId, origin, reload);
    if (Date.now() - startedAt >= LOAD_REREAD_MS || samePage(before, await settleSnapshot(tabId))) return page;
  } catch (error) {
    if (Date.now() - startedAt >= LOAD_REREAD_MS) throw error;
  }
  return await readPage(await registeredSession(session), tabId, origin, reload);
}

/** Nothing a read shows moved between the two snapshots: network traffic alone does not count. */
function samePage(a: SettleSnapshot, b: SettleSnapshot): boolean {
  return a.ready && b.ready && a.revision === b.revision && a.layout === b.layout;
}

/**
 * Whether a load's reply may carry the page: never past what a `read` would need a prompt for. A pass from Full access
 * counts only while T3 still confirms it.
 */
async function readableAfterLoad(
  session: StoredSession,
  tabId: number,
  origin: string,
  requested: string,
  pass: AuthorizeResult,
): Promise<boolean> {
  if (origin === requested && pass !== 'full-access') return true;
  if (await sessionStore.hasApprovedOrigin(session.id, tabId, origin)) return true;
  const setting = await siteStore.get(origin);
  if (setting === 'read' || setting === 'allow') return true;
  return origin === requested && (await permissionPrompts.hasFullAccess(session.id));
}

async function authorizeRead(
  session: StoredSession,
  requestedTab: number | undefined,
): Promise<{ tab: chrome.tabs.Tab; session: StoredSession; origin: string }> {
  let tab = await resolveSessionTab(session, requestedTab);
  const tabId = tab.id ?? -1;
  const origin = tabOrigin(tab);
  await sessionStore.observeTabOrigin(tabId, origin);
  // A site the owner allows, even for reading only, passes `authorize` without a prompt.
  const approved = await sessionStore.hasApprovedOrigin(session.id, tabId, origin);
  const pass = approved ? 'approved' : await permissionPrompts.authorize(origin, 'read', session, promptTab(tab));
  await recordApproval(pass, session.id, tabId, origin);
  const currentSession = await registeredSession(session);
  tab = await resolveSessionTab(currentSession, tabId);
  assertSameOrigin(tab, origin);
  return { tab, session: currentSession, origin };
}

function tabOrigin(tab: chrome.tabs.Tab): string {
  const url = tab.url ?? tab.pendingUrl ?? '';
  const error = restrictedPageError(url);
  if (error !== undefined) throw new Error(error);
  const origin = originOf(url);
  if (origin === undefined) throw new Error('T3-Tab cannot access this page because its origin is unavailable.');
  return origin;
}

function assertSameOrigin(tab: chrome.tabs.Tab, expectedOrigin: string): void {
  const actual = tabOrigin(tab);
  if (actual !== expectedOrigin) {
    throw new Error(
      `The page moved from ${expectedOrigin} to ${actual}. Read the new page and approve it before continuing.`,
    );
  }
}

function promptTab(tab: chrome.tabs.Tab): PromptTab {
  return promptTabOf(tab.id ?? -1, tab.title);
}

function promptTabOf(id: number, title: string | undefined): PromptTab {
  return { id, title: title?.trim() || '(untitled)' };
}
