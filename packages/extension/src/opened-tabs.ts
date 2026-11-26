/**
 * The tabs pages opened, by the tab they were opened from, so an `act` batch can say which tabs its steps opened. The
 * browser reports each through `chrome.webNavigation.onCreatedNavigationTarget`, which is also where the tab is adopted
 * into its opener's session group; `adopted` ends when that is done, however it went.
 */
export interface OpenedTab {
  tabId: number;
  /** Ordinal of the report, for `openedSince`. */
  seq: number;
  adopted: Promise<void>;
}

/** Kept per opener: a page that opens tabs without end does not grow this. */
const MAX_PER_OPENER = 20;

let seq = 0;
const byOpener = new Map<number, OpenedTab[]>();

export function noteOpenedTab(sourceTabId: number, tabId: number, adopted: Promise<void>): void {
  seq += 1;
  const list = byOpener.get(sourceTabId) ?? [];
  list.push({ tabId, seq, adopted });
  if (list.length > MAX_PER_OPENER) list.splice(0, list.length - MAX_PER_OPENER);
  byOpener.set(sourceTabId, list);
}

/** A mark to pass to `openedSince` later. */
export function openedMark(): number {
  return seq;
}

/** The tabs opened from `sourceTabId` after `mark`, oldest first. */
export function openedSince(sourceTabId: number, mark: number): OpenedTab[] {
  return (byOpener.get(sourceTabId) ?? []).filter((opened) => opened.seq > mark);
}

/**
 * Every open tab that opened or was opened by another, by the tree of openers it belongs to (named by one of its tabs), and
 * the open tabs of each tree. A page can send a form into any tab of its tree by the tab's name (`target="results"`), not
 * only into a tab it opens then; `secret-text.ts` keeps a tree's secret values for the addresses of all its tabs.
 */
const treeOf = new Map<number, number>();
const members = new Map<number, Set<number>>();
/** The tabs closed while `rebuildOpenerTrees` waited for the browser's list, which it must not add. */
let closedWhileRebuilding: Set<number> | undefined;

function setTree(tabId: number, tree: number): void {
  const old = treeOf.get(tabId);
  if (old === tree) return;
  if (old !== undefined) leaveTree(tabId, old);
  treeOf.set(tabId, tree);
  const set = members.get(tree) ?? new Set<number>();
  set.add(tabId);
  members.set(tree, set);
}

function leaveTree(tabId: number, tree: number): void {
  const set = members.get(tree);
  set?.delete(tabId);
  if (set?.size !== 0) return;
  members.delete(tree);
  for (const listener of treeClosedListeners) listener(tree);
}

const treeClosedListeners: Array<(tree: number) => void> = [];

/** Calls `listener` with a tree whose last open tab closed. */
export function onTreeClosed(listener: (tree: number) => void): void {
  treeClosedListeners.push(listener);
}

/** Puts a tab a page opened into its opener's tree. */
export function joinTree(sourceTabId: number, tabId: number): void {
  const tree = treeOf.get(sourceTabId) ?? sourceTabId;
  setTree(sourceTabId, tree);
  setTree(tabId, tree);
}

export function treeOfTab(tabId: number): number | undefined {
  return treeOf.get(tabId);
}

/** A closed tab opens nothing more and takes no form, and a tab id is not reused for long. */
export function forgetClosedTab(tabId: number): void {
  byOpener.delete(tabId);
  const tree = treeOf.get(tabId);
  if (tree !== undefined) leaveTree(tabId, tree);
  treeOf.delete(tabId);
  closedWhileRebuilding?.add(tabId);
}

/** The browser swapped a tab for another (a prerendered page), which keeps its place in the tree. */
export function replaceTreeTab(addedTabId: number, removedTabId: number): void {
  const tree = treeOf.get(removedTabId);
  if (tree === undefined) return;
  forgetClosedTab(removedTabId);
  setTree(addedTabId, tree);
}

/** What the browser records of a tab for `rebuildOpenerTrees`. */
export interface OpenerRecord {
  id?: number | undefined;
  openerTabId?: number | undefined;
}

/**
 * The trees again after the worker started, from the openers the browser records (`openerTabId`), so a restart does not
 * lose which tabs a form can reach. A tab that closed meanwhile is left out, and a tab a page opened since is kept as it is.
 */
export async function rebuildOpenerTrees(
  list: () => Promise<OpenerRecord[]> = async () => await chrome.tabs.query({}),
): Promise<void> {
  const closed = new Set<number>();
  closedWhileRebuilding = closed;
  let tabs: OpenerRecord[];
  try {
    tabs = await list();
  } catch {
    return;
  } finally {
    closedWhileRebuilding = undefined;
  }
  const openerOf = new Map<number, number | undefined>();
  for (const tab of tabs) if (tab.id !== undefined && !closed.has(tab.id)) openerOf.set(tab.id, tab.openerTabId);
  for (const [tabId, opener] of openerOf) {
    if (opener === undefined || !openerOf.has(opener) || treeOf.has(tabId)) continue;
    // Up the openers to the first tab already in a tree, or to the top; every tab on the way joins that tree.
    const chain = [tabId];
    let tree: number | undefined;
    for (let at = opener; tree === undefined; ) {
      chain.push(at);
      const known = treeOf.get(at);
      const up = openerOf.get(at);
      if (known !== undefined) tree = known;
      else if (up === undefined || !openerOf.has(up) || chain.includes(up)) tree = at;
      else at = up;
    }
    for (const id of chain) setTree(id, tree);
  }
}
