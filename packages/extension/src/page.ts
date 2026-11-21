import type { PageReadResult } from '@t3-tab/protocol';

import { restrictToOriginFrames, slimAxNodes, type FrameInfo, type FramePolicy } from './ax';
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
  const frames = await frameTree(tabId);
  if (frames.mainOrigin !== expectedOrigin) {
    throw new Error(`The page moved from ${expectedOrigin} to ${frames.mainOrigin ?? 'an unknown origin'} while reading; approve the new origin first.`);
  }
  const tree = await sendCommand<{ nodes?: unknown }>(tabId, 'Accessibility.getFullAXTree');
  const after = await resolveSessionTab(await reloadSession(), tabId);
  assertOrigin(after, expectedOrigin);
  const nodes = slimAxNodes(
    await restrictToOriginFrames(tree.nodes, {
      origin: expectedOrigin,
      mainFrameId: frames.mainFrameId,
      frames: frames.byId,
      ownerOrigin: async (backendId) => await ownerFrameOrigin(tabId, backendId, frames.byId, expectedOrigin),
    } satisfies FramePolicy),
  );
  await redactPasswordValues(nodes, async (backendId) => isPasswordInput(await describeNode(tabId, backendId)));
  return { tab: tabId, title: after.title ?? '', url: after.url ?? after.pendingUrl ?? '', epoch, nodes };
}

function assertOrigin(tab: chrome.tabs.Tab, expectedOrigin: string): void {
  const actual = originOf(tab.url ?? tab.pendingUrl ?? '');
  if (actual !== expectedOrigin) {
    throw new Error(`The page moved from ${expectedOrigin} to ${actual ?? 'an unknown origin'} while reading; approve the new origin first.`);
  }
}


interface FrameTreeNode {
  frame?: { id?: unknown; securityOrigin?: unknown };
  childFrames?: FrameTreeNode[];
}

/** The page's frames by id, and the id and origin the browser reports for the main one. */
async function frameTree(tabId: number): Promise<{ mainFrameId: string; mainOrigin: string | undefined; byId: Map<string, FrameInfo> }> {
  const reply = await sendCommand<{ frameTree?: FrameTreeNode }>(tabId, 'Page.getFrameTree');
  const byId = new Map<string, FrameInfo>();
  const walk = (node: FrameTreeNode | undefined): void => {
    if (node === undefined) return;
    const { id, securityOrigin } = node.frame ?? {};
    if (typeof id === 'string') byId.set(id, { origin: typeof securityOrigin === 'string' ? securityOrigin : undefined });
    for (const child of node.childFrames ?? []) walk(child);
  };
  walk(reply.frameTree);
  const mainFrameId = reply.frameTree?.frame?.id;
  if (typeof mainFrameId !== 'string') throw new Error('The browser did not report the page frame');
  return { mainFrameId, mainOrigin: byId.get(mainFrameId)?.origin, byId };
}

/** The origin of the frame an `<iframe>` element holds: the browser's own answer, else its `src` address. */
async function ownerFrameOrigin(
  tabId: number,
  backendId: number,
  frames: ReadonlyMap<string, FrameInfo>,
  pageOrigin: string,
): Promise<string | undefined> {
  const described = await sendCommand<{ node?: { frameId?: unknown; attributes?: unknown } }>(tabId, 'DOM.describeNode', {
    backendNodeId: backendId,
  });
  const frameId = described.node?.frameId;
  const known = typeof frameId === 'string' ? frames.get(frameId)?.origin : undefined;
  if (known !== undefined) return known;
  const attributes = described.node?.attributes;
  if (!Array.isArray(attributes)) return undefined;
  for (let index = 0; index + 1 < attributes.length; index += 2) {
    if (attributes[index] === 'src' && typeof attributes[index + 1] === 'string') {
      try {
        return originOf(new URL(attributes[index + 1] as string, pageOrigin).href);
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
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
