import type { AxNode, PageReadResult } from '@t3-tab/protocol';

import { slimAxNodes } from './ax';
import { documentEpoch, ensureAttached, sendCommand } from './cdp';
import type { StoredSession } from './sessions';
import { resolveSessionTab } from './tabs';

export async function readPage(session: StoredSession, tab: number | undefined): Promise<PageReadResult> {
  const resolved = await resolveSessionTab(session, tab);
  const tabId = resolved.id ?? -1;
  await ensureAttached(tabId);
  // Taken before the tree: a navigation during the read then shows up as a new value on the next one.
  const epoch = documentEpoch(tabId);
  const tree = await sendCommand<{ nodes?: unknown }>(tabId, 'Accessibility.getFullAXTree');
  const nodes = slimAxNodes(tree.nodes);
  await redactPasswordValues(tabId, nodes);
  return { tab: tabId, title: resolved.title ?? '', url: resolved.url ?? resolved.pendingUrl ?? '', epoch, nodes };
}


interface DescribedNode {
  node?: { nodeName?: string; attributes?: string[] };
}

/** The accessibility tree shows password values as bullets, but their count is still the length. */
async function redactPasswordValues(tabId: number, nodes: AxNode[]): Promise<void> {
  const fields = nodes
    .filter((node) => node.role.toLowerCase() === 'textbox' && node.backendId !== undefined)
    .slice(0, 200);
  await Promise.all(
    fields.map(async (node) => {
      let described: DescribedNode;
      try {
        described = await sendCommand<DescribedNode>(tabId, 'DOM.describeNode', { backendNodeId: node.backendId });
      } catch {
        return;
      }
      if (!isPasswordInput(described.node) && !looksMasked(node.value)) return;
      delete node.value;
      node.props = { ...node.props, password: true };
    }),
  );
}

function looksMasked(value: string | undefined): boolean {
  return value !== undefined && value !== '' && /^•+$/.test(value);
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
