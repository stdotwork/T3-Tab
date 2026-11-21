import type { BrowserMethods, BrowserRequestMessage, ToolSession } from '@t3-tab/protocol';

import { actOnPage } from './actions';
import { evaluatePage } from './evaluate';
import { readPage } from './page';
import { isOpenableUrl } from './tabs';
import { originOf, restrictedPageError } from './permissions';
import { permissionPrompts, sessionStore } from './runtime';
import { captureViewport } from './screenshot';
import {
  closeSessionTab,
  listTabs,
  openSessionTab,
  resolveSessionTab,
  switchSessionTab,
} from './tabs';
import type { StoredSession } from './sessions';

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

  const session = await ensureSession(request.session);
  switch (request.method) {
    case 'tabs.list':
      return { tabs: await listTabs(session) } satisfies BrowserMethods['tabs.list']['result'];
    case 'tabs.open': {
      const error = restrictedPageError(request.params.url);
      if (error !== undefined) throw new Error(error);
      if (!isOpenableUrl(request.params.url)) throw new Error('Only http and https URLs can be opened');
      const origin = originOf(request.params.url);
      if (origin === undefined) throw new Error('Only http and https URLs can be opened');
      await permissionPrompts.authorize(origin, 'open', session);
      const opened = await openSessionTab(session, request.params.url, sessionStore);
      return { tab: opened.tab } satisfies BrowserMethods['tabs.open']['result'];
    }
    case 'tabs.switch':
      return { tab: await switchSessionTab(session, request.params.tab) } satisfies BrowserMethods['tabs.switch']['result'];
    case 'tabs.close':
      return { closed: await closeSessionTab(session, request.params.tab) } satisfies BrowserMethods['tabs.close']['result'];
    case 'page.read': {
      const tab = await resolveSessionTab(session, request.params.tab);
      return await readPage(session, tab.id);
    }
    case 'page.screenshot': {
      const tab = await resolveSessionTab(session, request.params.tab);
      return await captureViewport(tab.id ?? -1, request.params.maxEdge);
    }
    case 'page.act': {
      const tab = await resolveSessionTab(session, request.params.tab);
      const origin = await actionOrigin(tab);
      await permissionPrompts.authorize(origin, 'act', session);
      return await actOnPage(
        session,
        tab.id ?? -1,
        request.params.steps,
        request.params.backendIds,
        request.params.epoch,
        origin,
      );
    }
    case 'page.eval': {
      const tab = await resolveSessionTab(session, request.params.tab);
      const origin = await actionOrigin(tab);
      await permissionPrompts.authorize(origin, 'run_js', session);
      return await evaluatePage(session, tab.id, request.params.expression, origin);
    }
    default:
      throw new Error(`Unknown request: ${String((request as { method?: unknown }).method)}`);
  }
}

async function ensureSession(session: ToolSession): Promise<StoredSession> {
  const existing = await sessionStore.get(session.id);
  return existing ?? (await sessionStore.register(session));
}

async function actionOrigin(tab: chrome.tabs.Tab): Promise<string> {
  const url = tab.url ?? tab.pendingUrl ?? '';
  const error = restrictedPageError(url);
  if (error !== undefined) throw new Error(error);
  const origin = originOf(url);
  if (origin === undefined) throw new Error('T3-Tab cannot act on this page because its origin is unavailable.');
  return origin;
}
