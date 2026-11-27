import type {
  ActFollowThrough,
  BrowserMethods,
  BrowserRequestMessage,
  LoadOptions,
  PageReadResult,
  TabInfo,
  TabLoadResult,
  ToolSession,
} from '@t3-tab/protocol';

import { actOnPage } from './actions';
import { claimTabs } from './claims';
import { ensureAttached, setRecoveryOrigin } from './cdp';
import { evaluatePage } from './evaluate';
import { openedMark, openedSince, type OpenedTab } from './opened-tabs';
import { readPage } from './page';
import { originOf, promptAddress, restrictedPageError, type AuthorizeResult, type PromptTab } from './permissions';
import { claimStore, permissionPrompts, sessionStore, siteStore } from './runtime';
import { captureViewport } from './screenshot';
import { pageTextLength, settleSnapshot, sleep, type SettleSnapshot } from './settle';
import { canSessionUseTab, type StoredSession } from './sessions';
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
      const access = await authorizeRead(session, request.params.tab, request.params.ifReadable === true);
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
      const tabId = tab.id ?? -1;
      const mark = openedMark();
      const page = await actOnPage(
        currentSession,
        tabId,
        request.params.steps,
        request.params.backendIds,
        request.params.epoch,
        origin,
        async () => await registeredSession(session),
      );
      const opened = await describeOpenedTabs(session, origin, openedSince(tabId, mark), loadOptions(request.params));
      return { ...page, ...opened } satisfies BrowserMethods['page.act']['result'];
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

/** Most tabs one batch's reply describes; the page goes with the first one the session may read. */
const MAX_OPENED = 5;
/** How long a batch's reply waits, in all, for the tabs it opened to be adopted, to commit and to load. */
const OPENED_WAIT_MS = 5_000;
/** How long a tab still on the blank page it was created with is given to start loading something else. */
const OPENED_BLANK_MS = 1_000;
const OPENED_POLL_MS = 50;
const OPENED_STILL_LOADING = 'It is still loading.';
const OPENED_ACCESS_ENDED = 'Its page is left out: reading it now needs the owner. read it to ask.';

/**
 * What the session may see of a tab a batch opened without asking: the owner's site setting, or T3's Full access, which
 * counts only on the origin the batch itself was let through for, as it does for a load. A tab opened onto another origin
 * needs that origin's site setting.
 */
const openedAccess = (session: ToolSession, actOrigin: string): SiteSetting => async (origin) => {
  const setting = await siteStore.get(origin);
  if (setting === 'read' || setting === 'allow') return setting;
  return origin === actOrigin && (await permissionPrompts.hasFullAccess(session.id)) ? 'read' : setting;
};

/**
 * The tabs a batch opened, as a load describes a tab: a tab that joined the session shows its origin only until the
 * session may read it, and the first one it may read comes with its page, under the rules of a load's reply. A tab the
 * session does not hold (opened from a tab the owner shared, or not adopted in time) is only counted.
 */
async function describeOpenedTabs(
  session: ToolSession,
  actOrigin: string,
  opened: OpenedTab[],
  options: LoadOptions,
): Promise<ActFollowThrough> {
  if (opened.length === 0) return {};
  const deadline = Date.now() + OPENED_WAIT_MS;
  const described: TabLoadResult[] = [];
  let elsewhere = 0;
  for (const entry of opened.slice(0, MAX_OPENED)) {
    await adoptedBy(entry.adopted, deadline);
    const withPage = !described.some((result) => result.page !== undefined || result.textLength !== undefined);
    // A tab that closed or moved out of reach while it was described is left out.
    const result = await describeOpened(session, actOrigin, entry.tabId, deadline, withPage, options).catch(() => undefined);
    if (result === 'elsewhere') elsewhere += 1;
    else if (result !== undefined) described.push(result);
  }
  return { ...(described.length === 0 ? {} : { opened: described }), ...(elsewhere === 0 ? {} : { openedElsewhere: elsewhere }) };
}

/** Waits for a tab's adoption into its opener's group, or the deadline, whichever is first. */
async function adoptedBy(adopted: Promise<void>, deadline: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([adopted, new Promise<void>((done) => (timer = setTimeout(done, Math.max(0, deadline - Date.now()))))]);
  } finally {
    clearTimeout(timer);
  }
}

/** One tab a batch opened, once it committed, or undefined when it closed already. */
async function describeOpened(
  session: ToolSession,
  actOrigin: string,
  tabId: number,
  deadline: number,
  withPage: boolean,
  options: LoadOptions,
): Promise<TabLoadResult | 'elsewhere' | undefined> {
  const first = await chrome.tabs.get(tabId).catch(() => undefined);
  if (first === undefined) return undefined;
  if (!canSessionUseTab(await registeredSession(session), first)) return 'elsewhere';
  // A new tab reports the address it is loading as pending until the page commits, and may sit on the blank page it was
  // created with for a moment first; its origin counts only once it committed something else.
  let blankSince: number | undefined;
  const committed = await waitForTab(tabId, deadline, (tab) => {
    if (tab.pendingUrl !== undefined || (tab.url ?? '') === '') return false;
    if (tab.url !== 'about:blank') return true;
    blankSince ??= Date.now();
    return Date.now() - blankSince >= OPENED_BLANK_MS;
  });
  if (committed === undefined) return undefined;
  const url = committed.url ?? '';
  const origin = originOf(url);
  // Shown as an unapproved tab is: by its origin, or, for a page the tools cannot use, by its scheme.
  if (committed.pendingUrl !== undefined || url === '' || url === 'about:blank') {
    const loading = originOf(committed.pendingUrl ?? '') ?? 'about:blank';
    return { tab: { id: tabId, title: '', url: loading, active: false, needsApproval: true }, unread: OPENED_STILL_LOADING };
  }
  if (origin === undefined) {
    const scheme = /^[a-z][a-z0-9+.-]*:/i.exec(url)?.[0] ?? '';
    return { tab: { id: tabId, title: '', url: scheme, active: false, needsApproval: true }, unread: restrictedPageError(url) ?? '' };
  }
  await sessionStore.observeTabOrigin(tabId, origin);
  const access = openedAccess(session, actOrigin);
  const describe = async (): Promise<TabInfo> => ({
    ...(await describeSessionTab(await registeredSession(session), tabId, access)),
    active: false,
  });
  const tab = await describe();
  // Only where a `read` of the tab would pass without a prompt; the tab itself carries no approval.
  if (tab.needsApproval === true) return { tab };
  // What Full access let through is listed with the requests it allowed, as a prompt it answered would be.
  let noted = false;
  const noteFullAccess = async (): Promise<void> => {
    if (noted) return;
    noted = true;
    const setting = await siteStore.get(origin);
    const held = await sessionStore.hasApprovedOrigin(session.id, tabId, origin);
    if (setting !== 'read' && setting !== 'allow' && !held) permissionPrompts.noteAutoAllowed('read', origin, promptTabOf(tabId, tab.title));
  };
  if (!withPage) {
    await noteFullAccess();
    return { tab };
  }
  const loaded = await waitForTab(tabId, deadline, (latest) => latest.status === 'complete');
  if (loaded?.status !== 'complete') {
    await noteFullAccess();
    return { tab, unread: OPENED_STILL_LOADING };
  }
  const stillReadable = async (): Promise<TabLoadResult | undefined> => {
    const now = await describe();
    return now.needsApproval === true || originOf(now.url) !== origin ? { tab: now, unread: OPENED_ACCESS_ENDED } : undefined;
  };
  try {
    await ensureAttached(tabId);
    if (options.skipReadOver !== undefined) {
      const textLength = await pageTextLength(tabId);
      if (textLength > options.skipReadOver) {
        const ended = await stillReadable();
        if (ended !== undefined) return ended;
        await noteFullAccess();
        return { tab, textLength };
      }
    }
    const page = await readLanded(await registeredSession(session), await registeredSession(session), tabId, origin, { newDocument: true });
    const ended = await stillReadable();
    if (ended !== undefined) return ended;
    await noteFullAccess();
    return { tab: await describe(), page };
  } catch (error) {
    // The reply still shows the tab's title and address, which Full access may be what let through.
    await noteFullAccess().catch(() => undefined);
    return { tab, unread: error instanceof Error ? error.message : String(error) };
  }
}

/** The tab once `ready` holds for it or the deadline passed, or undefined when it closed. */
async function waitForTab(
  tabId: number,
  deadline: number,
  ready: (tab: chrome.tabs.Tab) => boolean,
): Promise<chrome.tabs.Tab | undefined> {
  for (;;) {
    const tab = await chrome.tabs.get(tabId).catch(() => undefined);
    if (tab === undefined || ready(tab) || Date.now() >= deadline) return tab;
    await sleep(OPENED_POLL_MS);
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
  // A pass from Full access holds only while T3 confirms the mode, which may have ended since the tab was described.
  // Then the tab is described again, so its title and address are not shown either.
  const fullAccessEnded = async (): Promise<TabLoadResult> => {
    const tab = await describeSessionTab(await registeredSession(session), tabId, tabAccess(session));
    return { ...result, tab, unread: FULL_ACCESS_ENDED };
  };
  if (!(await readable())) return pass === 'full-access' && origin === requested ? await fullAccessEnded() : result;
  // A page too long for the reply to carry whole is left to the read the agent sends anyway, so it is not read twice.
  if (options.skipReadOver !== undefined) {
    const textLength = await pageTextLength(tabId);
    if (textLength > options.skipReadOver) return (await readable()) ? { ...result, textLength } : await fullAccessEnded();
  }
  let page: PageReadResult;
  try {
    page = await readLanded(current, session, tabId, origin, landing);
  } catch (error) {
    return { ...result, unread: error instanceof Error ? error.message : String(error) };
  }
  if (!(await readable())) return await fullAccessEnded();
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

/** Thrown by a read asked for only if it needs no prompt, when it would need one. */
export const READ_NEEDS_PROMPT = 'Reading this page needs the owner to allow it.';

async function authorizeRead(
  session: StoredSession,
  requestedTab: number | undefined,
  ifReadable = false,
): Promise<{ tab: chrome.tabs.Tab; session: StoredSession; origin: string }> {
  let tab = await resolveSessionTab(session, requestedTab);
  const tabId = tab.id ?? -1;
  const origin = tabOrigin(tab);
  await sessionStore.observeTabOrigin(tabId, origin);
  // A site the owner allows, even for reading only, passes `authorize` without a prompt.
  const approved = await sessionStore.hasApprovedOrigin(session.id, tabId, origin);
  if (ifReadable && !approved) {
    const setting = await siteStore.get(origin);
    if (setting !== 'read' && setting !== 'allow') throw new Error(READ_NEEDS_PROMPT);
  }
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
