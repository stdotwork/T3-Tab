/** The side panel belongs to the tab it was opened on: other tabs have none until the owner opens one there. */

const PANEL_TAB_PREFIX = 'panel.tab.';

export const panelPath = (tabId: number): string => `sidepanel.html?tabId=${tabId}`;

/** The key of one value a tab's panel keeps, in session storage so it ends with the browser. */
export const panelTabKey = (tabId: number | undefined, name: string): string => `${PANEL_TAB_PREFIX}${tabId ?? 'window'}.${name}`;

/** Turns off the window-wide panel the manifest declares, so only a tab that opened one shows it. */
export async function keepPanelOnItsTab(): Promise<void> {
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });
  await chrome.sidePanel.setOptions({ enabled: false });
}

/**
 * Opens the panel on this tab. `open` needs the toolbar click's user gesture, which an `await` before it would lose, so
 * both calls start in the same turn.
 */
export async function openPanelOn(tabId: number): Promise<void> {
  const configured = chrome.sidePanel.setOptions({ tabId, path: panelPath(tabId), enabled: true });
  const opened = chrome.sidePanel.open({ tabId });
  await Promise.all([configured, opened]);
}

/** Drops what a closed tab's panel kept. */
export async function forgetPanelTab(tabId: number): Promise<void> {
  const prefix = `${PANEL_TAB_PREFIX}${tabId}.`;
  const stored = await chrome.storage.session.get(null);
  const keys = Object.keys(stored).filter((key) => key.startsWith(prefix));
  if (keys.length > 0) await chrome.storage.session.remove(keys);
}
