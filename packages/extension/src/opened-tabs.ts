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
 * only into a tab it opens then; `secret-text.ts` keeps a tree's secret values for the addresses of all its tabs. The trees
 * are kept in `chrome.storage.session` too, so a worker that restarts gets them back (`loadOpenerTrees`): the browser's
 * own `openerTabId` is the tab strip's idea of an opener, which it reassigns and clears, so it cannot stand in for them.
 */
const treeOf = new Map<number, number>();
const members = new Map<number, Set<number>>();
/** The tabs closed while `loadOpenerTrees` waited for the browser, which it must not add. */
let closedWhileLoading: Set<number> | undefined;
const TREES_KEY = 't3tab.openerTrees';
let saving = false;

/** Writes the trees to session storage once the current task is done, however many changes it made. */
function saveTrees(): void {
  if (saving) return;
  saving = true;
  queueMicrotask(() => {
    saving = false;
    const session = (globalThis as { chrome?: { storage?: { session?: chrome.storage.StorageArea } } }).chrome?.storage?.session;
    void session?.set({ [TREES_KEY]: Object.fromEntries(treeOf) }).catch(() => undefined);
  });
}

function setTree(tabId: number, tree: number): void {
  const old = treeOf.get(tabId);
  if (old === tree) return;
  if (old !== undefined) leaveTree(tabId, old);
  treeOf.set(tabId, tree);
  const set = members.get(tree) ?? new Set<number>();
  set.add(tabId);
  members.set(tree, set);
  saveTrees();
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
  if (tree !== undefined) {
    leaveTree(tabId, tree);
    treeOf.delete(tabId);
    saveTrees();
  }
  closedWhileLoading?.add(tabId);
}

/**
 * The browser swapped a tab for another (a prerendered page): the new tab joins the old one's tree before the old one
 * leaves it, so a tree whose last tab is swapped keeps its values.
 */
export function replaceTreeTab(addedTabId: number, removedTabId: number): void {
  const tree = treeOf.get(removedTabId);
  if (tree !== undefined) setTree(addedTabId, tree);
  forgetClosedTab(removedTabId);
}

interface TreeSources {
  stored: () => Promise<unknown>;
  open: () => Promise<Array<{ id?: number | undefined }>>;
}

const browserSources: TreeSources = {
  stored: async () => (await chrome.storage.session.get(TREES_KEY))[TREES_KEY],
  open: async () => await chrome.tabs.query({}),
};

/**
 * The trees the worker kept before it restarted, from session storage, for the tabs the browser still lists. A tab that
 * closed meanwhile is left out. A tree a page added to since the worker started is merged with the stored one it meets,
 * so a tab opened during the load stays in one tree with its opener's.
 */
export async function loadOpenerTrees(sources: TreeSources = browserSources): Promise<void> {
  const closed = new Set<number>();
  closedWhileLoading = closed;
  let stored: unknown;
  let open: Array<{ id?: number | undefined }>;
  try {
    [stored, open] = await Promise.all([sources.stored(), sources.open()]);
  } catch {
    return;
  } finally {
    closedWhileLoading = undefined;
  }
  if (typeof stored !== 'object' || stored === null) return;
  const listed = new Set(open.flatMap((tab) => (tab.id === undefined || closed.has(tab.id) ? [] : [tab.id])));
  const byStoredTree = new Map<number, number[]>();
  for (const [key, value] of Object.entries(stored)) {
    const tabId = Number(key);
    if (!Number.isInteger(tabId) || typeof value !== 'number' || !listed.has(tabId)) continue;
    byStoredTree.set(value, [...(byStoredTree.get(value) ?? []), tabId]);
  }
  for (const [storedTree, tabs] of byStoredTree) {
    if (tabs.length < 2 && !tabs.some((tabId) => treeOf.has(tabId))) continue;
    const live = tabs.map((tabId) => treeOf.get(tabId)).find((tree) => tree !== undefined);
    const tree = live ?? storedTree;
    for (const tabId of tabs) {
      const current = treeOf.get(tabId);
      // Another tree a page made since the worker started, which this stored tree meets: its tabs join this one.
      if (current !== undefined && current !== tree) for (const other of Array.from(members.get(current) ?? [])) setTree(other, tree);
      setTree(tabId, tree);
    }
  }
}
