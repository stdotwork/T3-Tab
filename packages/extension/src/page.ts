import type { PageReadResult } from '@t3-tab/protocol';

import { slimAxNodes } from './ax';
import { documentEpoch, ensureAttached, sendCommand } from './cdp';
import { redactPasswordValues } from './password';
import { originOf } from './permissions';
import type { StoredSession } from './sessions';
import { resolveSessionTab } from './tabs';

export async function readPage(
  session: StoredSession,
  tab: number | undefined,
  expectedOrigin: string,
  reloadSession: () => Promise<StoredSession>,
): Promise<PageReadResult> {
  const initial = await resolveSessionTab(session, tab);
  const tabId = initial.id ?? -1;
  await ensureAttached(tabId);
  const before = await resolveSessionTab(await reloadSession(), tabId);
  assertOrigin(before, expectedOrigin);
  // Taken before the tree: a navigation during the read then shows up as a new value on the next one.
  const epoch = documentEpoch(tabId);
  const tree = await sendCommand<{ nodes?: unknown }>(tabId, 'Accessibility.getFullAXTree');
  const after = await resolveSessionTab(await reloadSession(), tabId);
  assertOrigin(after, expectedOrigin);
  const nodes = slimAxNodes(tree.nodes);
  await redactPasswordValues(nodes, async (backendId) => isPasswordInput(await describeNode(tabId, backendId)));
  return { tab: tabId, title: after.title ?? '', url: after.url ?? after.pendingUrl ?? '', epoch, nodes };
}

function assertOrigin(tab: chrome.tabs.Tab, expectedOrigin: string): void {
  const actual = originOf(tab.url ?? tab.pendingUrl ?? '');
  if (actual !== expectedOrigin) {
    throw new Error(`The page moved from ${expectedOrigin} to ${actual ?? 'an unknown origin'} while reading; approve the new origin first.`);
  }
}


interface DescribedNode {
  node?: { nodeName?: string; attributes?: string[] };
}

async function describeNode(tabId: number, backendId: number): Promise<DescribedNode['node']> {
  const described = await sendCommand<DescribedNode>(tabId, 'DOM.describeNode', { backendNodeId: backendId });
  return described.node;
}

function isPasswordInput(node: DescribedNode['node']): boolean {
  if (node?.nodeName?.toUpperCase() !== 'INPUT' || !Array.isArray(node.attributes)) return false;
  for (let index = 0; index + 1 < node.attributes.length; index += 2) {
    if (node.attributes[index]?.toLowerCase() === 'type' && node.attributes[index + 1]?.toLowerCase() === 'password') {
      return true;
    }
  }
  return false;
}
