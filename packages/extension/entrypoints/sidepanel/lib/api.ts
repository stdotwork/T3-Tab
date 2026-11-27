/** Talks to the extension's service worker. Only the real side panel may; the headless harness injects a bridge. */
export type PanelBridge = (request: unknown) => Promise<unknown>;

declare global {
  interface Window {
    __t3tabPanelBridge?: PanelBridge;
  }
}

export async function panel<T>(request: { type: string; [key: string]: unknown }): Promise<T> {
  const bridge = window.__t3tabPanelBridge;
  const result: unknown = bridge === undefined ? await chrome.runtime.sendMessage(request) : await bridge(request);
  if (typeof result === 'object' && result !== null && (result as { ok?: unknown }).ok === false) {
    throw new Error(String((result as { error?: unknown }).error ?? 'The request failed'));
  }
  return result as T;
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function readStored<T>(key: string): Promise<T | undefined> {
  const stored = await chrome.storage.local.get(key);
  return stored[key] as T | undefined;
}

export async function writeStored(key: string, value: unknown): Promise<void> {
  await chrome.storage.local.set({ [key]: value });
}

export async function removeStored(key: string): Promise<void> {
  await chrome.storage.local.remove(key);
}

/** What one tab's panel keeps. Session storage, so it ends with the browser. */
export async function readTabStored<T>(key: string): Promise<T | undefined> {
  const stored = await chrome.storage.session.get(key);
  return stored[key] as T | undefined;
}

export async function writeTabStored(key: string, value: unknown): Promise<void> {
  await chrome.storage.session.set({ [key]: value });
}
