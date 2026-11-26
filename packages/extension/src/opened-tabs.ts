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

/** A closed tab opens nothing more, and a tab id is not reused for long. */
export function forgetOpener(tabId: number): void {
  byOpener.delete(tabId);
}
