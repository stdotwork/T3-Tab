import type { PageReadResult } from '@t3-tab/protocol';

import { restrictToOriginFrames, slimAxNodes, type FrameInfo, type FramePolicy } from './ax';
import { DialogOpenError, documentEpoch, ensureAttached, privateWorld, sendCommand, setRecoveryOrigin } from './cdp';
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
  setRecoveryOrigin(tabId, expectedOrigin);
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
  const withFrames = await addSameOriginFrames(tabId, tree.nodes, frames, expectedOrigin);
  const after = await resolveSessionTab(await reloadSession(), tabId);
  assertOrigin(after, expectedOrigin);
  const restricted = await restrictToOriginFrames(withFrames, {
      origin: expectedOrigin,
      mainFrameId: frames.mainFrameId,
      frames: frames.byId,
      ownerOrigin: async (backendId) => await ownerFrameOrigin(tabId, backendId, frames.byId, expectedOrigin),
    } satisfies FramePolicy);
  // Before the tree is trimmed, so a value is taken whole and every node's relations are still there.
  const nodes = slimAxNodes(await redactPasswordValues(restricted, (backendIds) => inspectFields(tabId, backendIds)));
  return { tab: tabId, title: after.title ?? '', url: after.url ?? after.pendingUrl ?? '', epoch, nodes };
}

function assertOrigin(tab: chrome.tabs.Tab, expectedOrigin: string): void {
  const actual = originOf(tab.url ?? tab.pendingUrl ?? '');
  if (actual !== expectedOrigin) {
    throw new Error(`The page moved from ${expectedOrigin} to ${actual ?? 'an unknown origin'} while reading; approve the new origin first.`);
  }
}


interface FrameTreeNode {
  frame?: { id?: unknown; securityOrigin?: unknown; loaderId?: unknown };
  childFrames?: FrameTreeNode[];
}

interface PageFrames {
  mainFrameId: string;
  mainOrigin: string | undefined;
  byId: Map<string, FrameInfo>;
  root: FrameTreeNode | undefined;
}

/** Most child frames one read fetches; the rest stay out of the reply. */
const MAX_CHILD_FRAMES = 20;

/**
 * The accessibility tree of the main frame does not hold its child frames' content. This fetches it for each
 * child frame of the approved origin, walking down only through such frames, and hangs it under the frame's
 * `<iframe>` node. A frame that navigated during the fetch is left out, so its new document is never read;
 * `restrictToOriginFrames` then checks every frame again.
 */
async function addSameOriginFrames(tabId: number, raw: unknown, frames: PageFrames, origin: string): Promise<unknown> {
  if (!Array.isArray(raw)) return raw;
  const nodes = [...(raw as Array<Record<string, unknown>>)];
  const owners = new Map<number, Record<string, unknown>>();
  const indexOwners = (items: Array<Record<string, unknown>>): void => {
    for (const node of items) {
      const role = (node.role as { value?: unknown } | undefined)?.value;
      if (role === 'Iframe' && typeof node.backendDOMNodeId === 'number') owners.set(node.backendDOMNodeId, node);
    }
  };
  indexOwners(nodes);
  const queue = [...(frames.root?.childFrames ?? [])];
  for (let fetched = 0; queue.length > 0 && fetched < MAX_CHILD_FRAMES; ) {
    const child = queue.shift();
    const frameId = child?.frame?.id;
    if (child === undefined || typeof frameId !== 'string' || child.frame?.securityOrigin !== origin) continue;
    fetched += 1;
    try {
      const owner = await sendCommand<{ backendNodeId?: number }>(tabId, 'DOM.getFrameOwner', { frameId });
      const holder = owner.backendNodeId === undefined ? undefined : owners.get(owner.backendNodeId);
      if (holder === undefined) continue;
      const tree = await sendCommand<{ nodes?: unknown }>(tabId, 'Accessibility.getFullAXTree', { frameId });
      const now = (await frameTree(tabId)).byId.get(frameId);
      if (now?.origin !== origin || now.loaderId !== child.frame?.loaderId || !Array.isArray(tree.nodes)) continue;
      const prefix = `f${fetched}:`;
      const added = (tree.nodes as Array<Record<string, unknown>>).map((node) => ({
        ...node,
        nodeId: `${prefix}${String(node.nodeId)}`,
        childIds: Array.isArray(node.childIds) ? node.childIds.map((id) => `${prefix}${String(id)}`) : [],
        frameId,
      }));
      const root = added[0];
      if (root === undefined) continue;
      holder.childIds = [root.nodeId];
      nodes.push(...added);
      indexOwners(added);
      queue.push(...(child.childFrames ?? []));
    } catch (error) {
      if (error instanceof DialogOpenError) throw error;
      // The frame went away during the read; the rest of the page is still good.
    }
  }
  return nodes;
}

/** The page's frames by id, and the id and origin the browser reports for the main one. */
async function frameTree(tabId: number): Promise<PageFrames> {
  const reply = await sendCommand<{ frameTree?: FrameTreeNode }>(tabId, 'Page.getFrameTree');
  const byId = new Map<string, FrameInfo>();
  const walk = (node: FrameTreeNode | undefined): void => {
    if (node === undefined) return;
    const { id, securityOrigin, loaderId } = node.frame ?? {};
    if (typeof id === 'string') {
      byId.set(id, {
        origin: typeof securityOrigin === 'string' ? securityOrigin : undefined,
        loaderId: typeof loaderId === 'string' ? loaderId : undefined,
      });
    }
    for (const child of node.childFrames ?? []) walk(child);
  };
  walk(reply.frameTree);
  const mainFrameId = reply.frameTree?.frame?.id;
  if (typeof mainFrameId !== 'string') throw new Error('The browser did not report the page frame');
  return { mainFrameId, mainOrigin: byId.get(mainFrameId)?.origin, byId, root: reply.frameTree };
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

/** Runs in T3-Tab's own world, so a page cannot change what `type` or `getComputedStyle` answer for its fields. */
const INSPECT_FIELDS = `function (...fields) {
  const SECRET_AUTOCOMPLETE = ['current-password', 'new-password', 'one-time-code', 'cc-number', 'cc-csc'];
  return fields.map((field) => {
    try {
      if (field.nodeName === 'INPUT' && String(field.type).toLowerCase() === 'password') return true;
      const hints = String(field.getAttribute('autocomplete') || '').toLowerCase().split(/\\s+/);
      if (hints.some((hint) => SECRET_AUTOCOMPLETE.includes(hint))) return true;
      const view = field.ownerDocument && field.ownerDocument.defaultView;
      if (!view) return null;
      const security = view.getComputedStyle(field).getPropertyValue('-webkit-text-security');
      return security !== 'none';
    } catch (error) {
      return null;
    }
  });
}`;

let inspections = 0;

/** Resolves nodes into T3-Tab's own world, in one object group; a node the browser cannot resolve is `undefined`. */
async function resolveFields(tabId: number, backendIds: number[], context: number, group: string): Promise<Array<string | undefined>> {
  return await Promise.all(
    backendIds.map(async (backendNodeId) => {
      try {
        const reply = await sendCommand<{ object?: { objectId?: unknown } }>(tabId, 'DOM.resolveNode', {
          backendNodeId,
          executionContextId: context,
          objectGroup: group,
        });
        return typeof reply.object?.objectId === 'string' ? reply.object.objectId : undefined;
      } catch (error) {
        if (error instanceof DialogOpenError) throw error;
        return undefined;
      }
    }),
  );
}

/**
 * For each field, whether its value must be hidden: a password input, whatever its role, or a field masked with
 * `-webkit-text-security` (a PIN or card number typed into `type=text`). One round trip per field to find it and one for
 * the whole batch to ask; the answer is `undefined` for a field the browser could not resolve or inspect.
 */
async function inspectFields(tabId: number, backendIds: number[]): Promise<Array<boolean | undefined>> {
  const context = await privateWorld(tabId);
  const group = `t3tab-fields-${(inspections += 1)}`;
  try {
    const resolved = await resolveFields(tabId, backendIds, context, group);
    const found = resolved.filter((objectId): objectId is string => objectId !== undefined);
    if (found.length === 0) return backendIds.map(() => undefined);
    const answer = await sendCommand<{ result?: { value?: unknown } }>(tabId, 'Runtime.callFunctionOn', {
      objectId: found[0],
      functionDeclaration: INSPECT_FIELDS,
      arguments: found.map((objectId) => ({ objectId })),
      returnByValue: true,
    });
    const flags = answer.result?.value;
    if (!Array.isArray(flags) || flags.length !== found.length) return backendIds.map(() => undefined);
    let next = 0;
    return resolved.map((objectId) => {
      if (objectId === undefined) return undefined;
      const flag: unknown = flags[next++];
      return typeof flag === 'boolean' ? flag : undefined;
    });
  } finally {
    await sendCommand(tabId, 'Runtime.releaseObjectGroup', { objectGroup: group }).catch(() => undefined);
  }
}
