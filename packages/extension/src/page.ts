import type { PageReadResult } from '@t3-tab/protocol';

import { restrictToOriginFrames, slimAxNodes, type FrameInfo, type FramePolicy } from './ax';
import { CommandTimeoutError, DialogOpenError, documentEpoch, ensureAttached, forgetPrivateWorld, privateWorld, sendCommand, setRecoveryOrigin } from './cdp';
import { redactPasswordValues, type FieldAnswer } from './password';
import { knownSecrets, promoteAddressSecrets, rememberSecrets, scrubReported } from './secret-text';
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
  const pageSecrets = await collectSecrets(tabId);
  // A value of the tab's tree of openers that its address carries is one its page can echo.
  promoteAddressSecrets(tabId, after.url ?? after.pendingUrl ?? '');
  // Before the tree is trimmed, so a value is taken whole and every node's relations are still there.
  const nodes = slimAxNodes(
    await redactPasswordValues(restricted, (backendIds) => inspectFields(tabId, backendIds), {
      // A dialog opening mid-read is the read's failure, not a field that could not be checked.
      rethrow: (error) => error instanceof DialogOpenError,
      pageSecrets,
      remembered: knownSecrets(tabId),
      onSecrets: (needles) => rememberSecrets(tabId, needles),
    }),
  );
  // The title and address come from the browser, not the tree: a form that sends the password in the address puts it there.
  return {
    tab: tabId,
    title: scrubReported(tabId, after.title ?? '', false),
    url: scrubReported(tabId, after.url ?? after.pendingUrl ?? '', true),
    epoch,
    nodes,
  };
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
      if (field.nodeType !== 1) return null;
      let secret = false;
      if (field.nodeName === 'INPUT' && String(field.type).toLowerCase() === 'password') secret = true;
      if (!secret) {
        const hints = String(field.getAttribute('autocomplete') || '').toLowerCase().split(/\\s+/);
        secret = hints.some((hint) => SECRET_AUTOCOMPLETE.includes(hint));
      }
      if (!secret) {
        const view = field.ownerDocument && field.ownerDocument.defaultView;
        if (!view) return null;
        secret = view.getComputedStyle(field).getPropertyValue('-webkit-text-security') !== 'none';
      }
      const holdsValue = field.nodeName === 'INPUT' || field.nodeName === 'TEXTAREA';
      return secret && holdsValue && typeof field.value === 'string' ? { secret, value: field.value.slice(0, 5000) } : { secret };
    } catch (error) {
      return null;
    }
  });
}`;

/**
 * Runs in T3-Tab's own world: the value of every input and textarea in the page that holds a secret (a password input, a
 * field marked secret by its `autocomplete`, one masked with `-webkit-text-security`), hidden ones too, also in open shadow
 * roots and same-origin frames. Closed shadow roots cannot be reached from the page's DOM.
 */
const COLLECT_SECRETS = `function () {
  const SECRET_AUTOCOMPLETE = ['current-password', 'new-password', 'one-time-code', 'cc-number', 'cc-csc'];
  const found = new Set();
  let styled = 0;
  let seen = 0;
  const visit = (root, level) => {
    if (!root || level > 8) return;
    const view = (root.ownerDocument || root).defaultView;
    for (const element of root.querySelectorAll('*')) {
      if ((seen += 1) > 200000 || found.size >= 3000) return;
      try {
        if (element.shadowRoot) visit(element.shadowRoot, level + 1);
        if (element.nodeName === 'IFRAME' || element.nodeName === 'FRAME') {
          try {
            visit(element.contentDocument, level + 1);
          } catch (error) {
            // Another origin.
          }
        }
        if (element.nodeName !== 'INPUT' && element.nodeName !== 'TEXTAREA') continue;
        const value = typeof element.value === 'string' ? element.value : '';
        if (value === '') continue;
        let secret = element.nodeName === 'INPUT' && String(element.type).toLowerCase() === 'password';
        if (!secret) {
          const hints = String(element.getAttribute('autocomplete') || '').toLowerCase().split(/\\s+/);
          secret = hints.some((hint) => SECRET_AUTOCOMPLETE.includes(hint));
        }
        if (!secret && view && styled < 5000) {
          styled += 1;
          secret = view.getComputedStyle(element).getPropertyValue('-webkit-text-security') !== 'none';
        }
        if (secret) found.add(value.slice(0, 5000));
      } catch (error) {
        // An element that cannot be read is left out.
      }
    }
  };
  visit(document, 0);
  return [...found];
}`;

/**
 * The values of the page's secret fields, found without a node; empty when the browser cannot be asked. With `timeoutMs`
 * each command (making T3-Tab's world on a new document included) is given up after that long, and the page's script is
 * stopped after it.
 */
async function collectSecrets(tabId: number, timeoutMs?: number): Promise<string[]> {
  try {
    const context = await (timeoutMs === undefined ? privateWorld(tabId) : privateWorld(tabId, timeoutMs));
    const answer = await sendCommand<{ result?: { value?: unknown } }>(
      tabId,
      'Runtime.evaluate',
      { expression: `(${COLLECT_SECRETS})()`, contextId: context, returnByValue: true, ...(timeoutMs === undefined ? {} : { timeout: timeoutMs }) },
      ...(timeoutMs === undefined ? [] : [timeoutMs + COLLECT_REPLY_MS]),
    );
    const value = answer.result?.value;
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
  } catch (error) {
    if (error instanceof DialogOpenError) throw error;
    // A slow page is not a lost world.
    if (!(error instanceof CommandTimeoutError)) forgetPrivateWorld(tabId);
    return [];
  }
}

/** How long an `act` step waits for the page's secret values before it goes on without them. */
const STEP_COLLECT_MS = 1_500;
/** Room for the browser's answer once it stopped the script. */
const COLLECT_REPLY_MS = 500;

/**
 * Remembers the values of the page's secret fields for the tab, as they are now, waiting at most `STEP_COLLECT_MS` (and
 * the browser's answer) for them in all, whatever the commands it takes. Never fails the call it is part of.
 */
export async function rememberPageSecrets(tabId: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), STEP_COLLECT_MS + COLLECT_REPLY_MS);
  });
  try {
    const values = await Promise.race([collectSecrets(tabId, STEP_COLLECT_MS), late]);
    if (values !== undefined) rememberSecrets(tabId, values);
  } catch {
    // The read that follows asks again.
  } finally {
    clearTimeout(timer);
  }
}

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
 * For each field, whether it holds a secret (a password input, whatever its role, a field masked with
 * `-webkit-text-security`, or one whose `autocomplete` says so) and the value it really holds. One round trip per field to
 * find it and one for the whole batch to ask; `undefined` for a field the browser could not resolve or inspect. When the
 * private world is gone (a navigation destroyed it) it is made again and the batch asked once more.
 */
export async function inspectFields(tabId: number, backendIds: number[]): Promise<Array<FieldAnswer | undefined>> {
  try {
    return await askAboutFields(tabId, backendIds, true);
  } catch (error) {
    if (error instanceof DialogOpenError) throw error;
    forgetPrivateWorld(tabId);
    return await askAboutFields(tabId, backendIds, false);
  }
}

/** With `strict`, a batch no node of which could be resolved is an error: the world they were resolved in may be gone. */
async function askAboutFields(tabId: number, backendIds: number[], strict: boolean): Promise<Array<FieldAnswer | undefined>> {
  const context = await privateWorld(tabId);
  const group = `t3tab-fields-${(inspections += 1)}`;
  try {
    const resolved = await resolveFields(tabId, backendIds, context, group);
    const found = resolved.filter((objectId): objectId is string => objectId !== undefined);
    if (found.length === 0) {
      if (strict && backendIds.length > 0) throw new Error('None of the fields could be resolved');
      return backendIds.map(() => undefined);
    }
    const answer = await sendCommand<{ result?: { value?: unknown } }>(tabId, 'Runtime.callFunctionOn', {
      objectId: found[0],
      functionDeclaration: INSPECT_FIELDS,
      arguments: found.map((objectId) => ({ objectId })),
      returnByValue: true,
    });
    const flags = answer.result?.value;
    if (!Array.isArray(flags) || flags.length !== found.length) throw new Error('The browser gave no answer about the fields');
    let next = 0;
    return resolved.map((objectId) => {
      if (objectId === undefined) return undefined;
      const flag: unknown = flags[next++];
      if (typeof flag !== 'object' || flag === null) return undefined;
      const { secret, value } = flag as { secret?: unknown; value?: unknown };
      return typeof secret === 'boolean' ? { secret, value: typeof value === 'string' ? value : undefined } : undefined;
    });
  } finally {
    await sendCommand(tabId, 'Runtime.releaseObjectGroup', { objectGroup: group }).catch(() => undefined);
  }
}
