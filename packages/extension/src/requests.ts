import type { BrowserMethods, BrowserRequestMessage, ToolSession } from '@t3-tab/protocol';

import { actOnPage } from './actions';
import { claimTabs } from './claims';
import { evaluatePage } from './evaluate';
import { readPage } from './page';
import { originOf, restrictedPageError, type PromptTab } from './permissions';
import { claimStore, permissionPrompts, sessionStore, siteStore } from './runtime';
import { captureViewport } from './screenshot';
import type { StoredSession } from './sessions';
import {
  closeSessionTab,
  describeSessionTab,
  isOpenableUrl,
  listTabs,
  openSessionTab,
  resolveSessionTab,
  switchSessionTab,
} from './tabs';

const siteSetting = async (origin: string) => await siteStore.get(origin);

/** Runs one request from the background program and returns its result. Throws a readable message on failure. */
export async function handleRequest(request: BrowserRequestMessage): Promise<unknown> {
  if (request.method === 'session.register') {
    await sessionStore.register(request.session);
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
        shared: await claimTabs(claimStore, sessionStore, session.id, request.params.code),
      } satisfies BrowserMethods['session.claim']['result'];
    case 'tabs.list':
      return { tabs: await listTabs(session, siteSetting) } satisfies BrowserMethods['tabs.list']['result'];
    case 'tabs.open':
      return await openTabForSession(session, request.params.url);
    case 'tabs.switch':
      return { tab: await switchSessionTab(session, request.params.tab, siteSetting) } satisfies BrowserMethods['tabs.switch']['result'];
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
      await permissionPrompts.authorize(origin, 'act', session, promptTab(tab));
      let currentSession = await registeredSession(session);
      await sessionStore.approveOrigin(session.id, tab.id ?? -1, origin);
      currentSession = await registeredSession(session);
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
      await permissionPrompts.authorize(origin, 'run_js', session, promptTab(tab));
      let currentSession = await registeredSession(session);
      await sessionStore.approveOrigin(session.id, tab.id ?? -1, origin);
      currentSession = await registeredSession(session);
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

async function openTabForSession(
  session: StoredSession,
  url: string,
): Promise<BrowserMethods['tabs.open']['result']> {
  const error = restrictedPageError(url);
  if (error !== undefined) throw new Error(error);
  if (!isOpenableUrl(url)) throw new Error('Only http and https URLs can be opened');
  const opened = await openSessionTab(session, url, sessionStore);
  try {
    await sessionStore.observeTabOrigin(opened.tab.id, opened.origin);
    await permissionPrompts.authorize(opened.origin, 'open', session, promptTabOf(opened.tab.id, opened.tab.title));
    await sessionStore.approveOrigin(session.id, opened.tab.id, opened.origin);
    return { tab: await describeSessionTab(await registeredSession(session), opened.tab.id, siteSetting) };
  } catch (failure) {
    await chrome.tabs.remove(opened.tab.id).catch(() => undefined);
    throw failure;
  }
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
  if (!(await sessionStore.hasApprovedOrigin(session.id, tabId, origin))) {
    await permissionPrompts.authorize(origin, 'read', session, promptTab(tab));
  }
  await sessionStore.approveOrigin(session.id, tabId, origin);
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
