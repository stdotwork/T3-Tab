import type { BrowserMethods, BrowserRequestMessage, PageReadResult } from '@t3-tab/protocol';

import { slimAxNodes } from './ax';
import { documentEpoch, ensureAttached, sendCommand } from './cdp';
import { captureViewport } from './screenshot';
import { closeTab, getTabInfo, listTabs, openTab, resolveTabId, switchTab } from './tabs';

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
    default:
      throw new Error(`Unknown request: ${String((request as { method?: unknown }).method)}`);
  }
}

async function readPage(tab: number | undefined): Promise<PageReadResult> {
  const tabId = await resolveTabId(tab);
  await ensureAttached(tabId);
  // Taken before the tree: a navigation during the read then shows up as a new value on the next one.
  const epoch = documentEpoch(tabId);
  const tree = await sendCommand<{ nodes?: unknown }>(tabId, 'Accessibility.getFullAXTree');
  const info = await getTabInfo(tabId);
  return { tab: tabId, title: info.title, url: info.url, epoch, nodes: slimAxNodes(tree.nodes) };
}
