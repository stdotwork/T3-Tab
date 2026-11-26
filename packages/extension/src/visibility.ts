/**
 * Whether the owner can not see the tab: it is not the active tab of its window, or its window is minimised or not
 * the one in focus. The browser draws such a tab rarely or not at all, so a screenshot or a wheel scroll there can
 * do nothing. When the browser cannot say, the tab counts as visible, so nothing is reported against it.
 */
export async function tabHiddenFromOwner(tabId: number): Promise<boolean> {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab.active !== true) return true;
    const window = await chrome.windows.get(tab.windowId);
    return window.state === 'minimized' || window.focused !== true;
  } catch {
    return false;
  }
}
