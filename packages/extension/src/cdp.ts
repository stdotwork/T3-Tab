const PROTOCOL = '1.3';
const COMMAND_TIMEOUT_MS = 15_000;

const attached = new Set<number>();
const attaching = new Map<number, Promise<void>>();
/** Per tab: bumped whenever the document may have been replaced, including when the debugger attaches. */
const epochs = new Map<number, number>();

export function documentEpoch(tabId: number): number {
  return epochs.get(tabId) ?? 0;
}

/** Starts tracking navigations and detaches. Call once, when the service worker starts. */
export function initCdp(): void {
  chrome.debugger.onEvent.addListener((source, method, params) => {
    if (source.tabId === undefined || method !== 'Page.frameNavigated') return;
    const frame = (params as { frame?: { parentId?: unknown } } | undefined)?.frame;
    // Only the top frame replaces the document the held refs point into.
    if (frame !== undefined && frame.parentId === undefined) bumpEpoch(source.tabId);
  });
  chrome.debugger.onDetach.addListener((source) => {
    if (source.tabId === undefined) return;
    attached.delete(source.tabId);
    bumpEpoch(source.tabId);
  });
  chrome.tabs.onRemoved.addListener((tabId) => {
    attached.delete(tabId);
    epochs.delete(tabId);
  });
}

/** Runs one DevTools protocol command on a tab, attaching the debugger first when needed. */
export async function sendCommand<T = Record<string, unknown>>(
  tabId: number,
  method: string,
  params?: Record<string, unknown>,
): Promise<T> {
  await ensureAttached(tabId);
  try {
    return await send<T>(tabId, method, params);
  } catch (error) {
    // The debugger can be detached behind our back (the user closes the banner, DevTools opens).
    if (!isNotAttached(error)) throw error;
    attached.delete(tabId);
    await ensureAttached(tabId);
    return await send<T>(tabId, method, params);
  }
}

async function send<T>(tabId: number, method: string, params?: Record<string, unknown>): Promise<T> {
  const result = chrome.debugger.sendCommand({ tabId }, method, params) as Promise<unknown>;
  return (await withTimeout(result, COMMAND_TIMEOUT_MS, `${method} timed out`)) as T;
}

export async function ensureAttached(tabId: number): Promise<void> {
  if (attached.has(tabId)) return;
  let pending = attaching.get(tabId);
  if (pending === undefined) {
    pending = attach(tabId).finally(() => attaching.delete(tabId));
    attaching.set(tabId, pending);
  }
  await pending;
}

async function attach(tabId: number): Promise<void> {
  await chrome.debugger.attach({ tabId }, PROTOCOL);
  try {
    await chrome.debugger.sendCommand({ tabId }, 'Page.enable');
  } catch (error) {
    await chrome.debugger.detach({ tabId }).catch(() => undefined);
    throw error;
  }
  bumpEpoch(tabId);
  attached.add(tabId);
}

function bumpEpoch(tabId: number): void {
  epochs.set(tabId, documentEpoch(tabId) + 1);
}

function isNotAttached(error: unknown): boolean {
  return error instanceof Error && /not attached|detached/i.test(error.message);
}

export async function withTimeout<T>(promise: Promise<T>, milliseconds: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), milliseconds);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
