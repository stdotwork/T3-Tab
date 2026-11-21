import type { PageReadResult } from '@t3-tab/protocol';

import { slimAxNodes } from './ax';
import { documentEpoch, ensureAttached, sendCommand } from './cdp';
import { getTabInfo, resolveTabId } from './tabs';

export async function readPage(tab: number | undefined): Promise<PageReadResult> {
  const tabId = await resolveTabId(tab);
  await ensureAttached(tabId);
  // Taken before the tree: a navigation during the read then shows up as a new value on the next one.
  const epoch = documentEpoch(tabId);
  const tree = await sendCommand<{ nodes?: unknown }>(tabId, 'Accessibility.getFullAXTree');
  const info = await getTabInfo(tabId);
  return { tab: tabId, title: info.title, url: info.url, epoch, nodes: slimAxNodes(tree.nodes) };
}
