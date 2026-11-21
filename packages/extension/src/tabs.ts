import type { TabInfo } from '@t3-tab/protocol';

const OPEN_TIMEOUT_MS = 15_000;
const OPENABLE_PROTOCOLS = new Set(['http:', 'https:']);

export async function listTabs(): Promise<TabInfo[]> {
  const [tabs, front] = await Promise.all([
    chrome.tabs.query({}),
    chrome.tabs.query({ active: true, lastFocusedWindow: true }),
  ]);
  const frontId = front[0]?.id;
  const infos: TabInfo[] = [];
  for (const tab of tabs) {
    if (tab.id !== undefined) infos.push(tabInfo(tab, tab.id === frontId));
  }
  return infos;
}

export async function resolveTabId(tab: number | undefined): Promise<number> {
  if (tab !== undefined) {
    await getTab(tab);
    return tab;
  }
  const [front] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const id = front?.id ?? (await chrome.tabs.query({ active: true }))[0]?.id;
  if (id === undefined) throw new Error('No tab is open');
  return id;
}

export async function getTabInfo(tabId: number): Promise<{ title: string; url: string }> {
  const tab = await getTab(tabId);
  return { title: tab.title ?? '', url: tab.url ?? '' };
}

export async function openTab(url: string): Promise<TabInfo> {
  if (!isOpenableUrl(url)) throw new Error('Only http and https URLs can be opened');
  const created = await chrome.tabs.create({ url, active: true });
  if (created.id === undefined) throw new Error('The browser did not create a tab');
  await waitForLoad(created.id, OPEN_TIMEOUT_MS);
  return tabInfo(await getTab(created.id), true);
}

export async function switchTab(tabId: number): Promise<TabInfo> {
  await getTab(tabId);
  await chrome.tabs.update(tabId, { active: true });
  return tabInfo(await getTab(tabId), true);
}

export async function closeTab(tabId: number): Promise<number> {
  await getTab(tabId);
  await chrome.tabs.remove(tabId);
  return tabId;
}

export function isOpenableUrl(value: string): boolean {
  try {
    return OPENABLE_PROTOCOLS.has(new URL(value).protocol);
  } catch {
    return false;
  }
}

async function getTab(tabId: number): Promise<chrome.tabs.Tab> {
  try {
    return await chrome.tabs.get(tabId);
  } catch {
    throw new Error(`No tab with id ${tabId}`);
  }
}

function tabInfo(tab: chrome.tabs.Tab, active: boolean): TabInfo {
  return { id: tab.id ?? -1, title: tab.title ?? '', url: tab.url ?? tab.pendingUrl ?? '', active };
}

/** Resolves when the tab finishes loading, or after the timeout: a slow page is still returned. */
async function waitForLoad(tabId: number, timeoutMs: number): Promise<void> {
  await new Promise<void>((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    };
    const listener = (updatedId: number, change: { status?: string }): void => {
      if (updatedId === tabId && change.status === 'complete') done();
    };
    const timer = setTimeout(done, timeoutMs);
    chrome.tabs.onUpdated.addListener(listener);
    void chrome.tabs.get(tabId).then((tab) => {
      if (tab.status === 'complete' && tab.url !== undefined && tab.url !== '' && tab.url !== 'about:blank') done();
    });
  });
}
