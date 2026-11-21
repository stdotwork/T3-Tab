import type { BrowserMethods, BrowserRequestMessage } from '@t3-tab/protocol';

import { actOnPage } from './actions';
import { evaluatePage } from './evaluate';
import { readPage } from './page';
import { captureViewport } from './screenshot';
import { closeTab, listTabs, openTab, resolveTabId, switchTab } from './tabs';

/** Runs one request from the background program and returns its result. Throws a readable message on failure. */
export async function handleRequest(request: BrowserRequestMessage): Promise<unknown> {
  switch (request.method) {
    case 'tabs.list':
      return { tabs: await listTabs() } satisfies BrowserMethods['tabs.list']['result'];
    case 'tabs.open':
      return { tab: await openTab(request.params.url) } satisfies BrowserMethods['tabs.open']['result'];
    case 'tabs.switch':
      return { tab: await switchTab(request.params.tab) } satisfies BrowserMethods['tabs.switch']['result'];
    case 'tabs.close':
      return { closed: await closeTab(request.params.tab) } satisfies BrowserMethods['tabs.close']['result'];
    case 'page.read':
      return await readPage(request.params.tab);
    case 'page.screenshot':
      return await captureViewport(await resolveTabId(request.params.tab), request.params.maxEdge);
    case 'page.act': {
      const tabId = await resolveTabId(request.params.tab);
      return await actOnPage(tabId, request.params.steps, request.params.backendIds, request.params.epoch);
    }
    case 'page.eval':
      return await evaluatePage(request.params.tab, request.params.expression);
    default:
      throw new Error(`Unknown request: ${String((request as { method?: unknown }).method)}`);
  }
}
