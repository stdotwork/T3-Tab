export interface PanelMessageSender {
  id?: string | undefined;
  tab?: unknown;
  url?: string | undefined;
}

/** Only the extension's real side-panel page may drive panel actions. */
export function isSidePanelSender(sender: PanelMessageSender, extensionId: string): boolean {
  if (sender.id !== extensionId || sender.tab !== undefined || typeof sender.url !== 'string') return false;
  try {
    const url = new URL(sender.url);
    return url.protocol === 'chrome-extension:' && url.hostname === extensionId && url.pathname === '/sidepanel.html';
  } catch {
    return false;
  }
}
