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
/**
 * Every open tab that opened or was opened by another, by the tree of openers it belongs to (named by its first tab). A
 * page can send a form into any tab of its tree by the tab's name (`target="results"`), not only into a tab it opens then.
 */
const treeOf = new Map<number, number>();

export function noteOpenedTab(sourceTabId: number, tabId: number, adopted: Promise<void>): void {
  const tree = treeOf.get(sourceTabId) ?? sourceTabId;
  const joined = treeOf.get(tabId);
  treeOf.set(sourceTabId, tree);
  if (joined !== undefined && joined !== tree) {
    for (const [id, of] of treeOf) if (of === joined) treeOf.set(id, tree);
  }
  treeOf.set(tabId, tree);
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

/** The other open tabs of the tree of openers `tabId` belongs to: the tabs a form on any of them can be sent into. */
export function relatedTabs(tabId: number): number[] {
  const tree = treeOf.get(tabId);
  if (tree === undefined) return [];
  const related: number[] = [];
  for (const [id, of] of treeOf) if (of === tree && id !== tabId) related.push(id);
  return related;
}

/** A closed tab opens nothing more and takes no form, and a tab id is not reused for long. */
export function forgetClosedTab(tabId: number): void {
  byOpener.delete(tabId);
  treeOf.delete(tabId);
}
