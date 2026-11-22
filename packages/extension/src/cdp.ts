const PROTOCOL = '1.3';
const COMMAND_TIMEOUT_MS = 15_000;

const attached = new Set<number>();
const attaching = new Map<number, Promise<void>>();
/** Per tab: bumped whenever the document may have been replaced, including when the debugger attaches. */
const epochs = new Map<number, number>();
/** Per tab: the address each top-frame navigation committed, keyed by the epoch it started. */
const navigations = new Map<number, Map<number, string>>();
const NAVIGATION_LOG_SIZE = 32;
/** Per tab: bumped by any network event, so action settling can see when traffic goes quiet. */
const networkEvents = new Map<number, number>();

/** One JavaScript execution context the page reported through `Runtime.executionContextCreated`. */
interface PageContext {
  id: number;
  uniqueId: string;
  origin: string;
  frameId: string | undefined;
  isDefault: boolean;
}

/** Per tab: the live execution contexts by unique id, kept from `Runtime.enable` onward. */
const contexts = new Map<number, Map<string, PageContext>>();

export function documentEpoch(tabId: number): number {
  return epochs.get(tabId) ?? 0;
}

/**
 * The addresses of the top-frame documents that replaced the one at `since`, oldest first, or undefined when
 * the document was replaced in a way that recorded no address (the debugger detached or reattached).
 */
export function navigationsSince(tabId: number, since: number): string[] | undefined {
  const now = documentEpoch(tabId);
  const log = navigations.get(tabId);
  const urls: string[] = [];
  for (let epoch = since + 1; epoch <= now; epoch += 1) {
    const url = log?.get(epoch);
    if (url === undefined) return undefined;
    urls.push(url);
  }
  return urls;
}

function logNavigation(tabId: number, url: string): void {
  const log = navigations.get(tabId) ?? new Map<number, string>();
  log.set(documentEpoch(tabId), url);
  for (const epoch of log.keys()) {
    if (log.size <= NAVIGATION_LOG_SIZE) break;
    log.delete(epoch);
  }
  navigations.set(tabId, log);
}

export function networkRevision(tabId: number): number {
  return networkEvents.get(tabId) ?? 0;
}

/** Starts tracking navigations and detaches. Call once, when the service worker starts. */
export function initCdp(): void {
  chrome.debugger.onEvent.addListener((source, method, params) => {
    if (source.tabId === undefined) return;
    if (method.startsWith('Network.')) {
      networkEvents.set(source.tabId, networkRevision(source.tabId) + 1);
    }
    if (method.startsWith('Runtime.executionContext')) {
      trackContext(source.tabId, method, params);
      return;
    }
    if (method !== 'Page.frameNavigated') return;
    const frame = (params as { frame?: { parentId?: unknown; url?: unknown } } | undefined)?.frame;
    // Only the top frame replaces the document the held refs point into.
    if (frame !== undefined && frame.parentId === undefined) {
      bumpEpoch(source.tabId);
      logNavigation(source.tabId, typeof frame.url === 'string' ? frame.url : '');
    }
  });
  chrome.debugger.onDetach.addListener((source) => {
    if (source.tabId === undefined) return;
    attached.delete(source.tabId);
    contexts.delete(source.tabId);
    bumpEpoch(source.tabId);
  });
  chrome.tabs.onRemoved.addListener((tabId) => {
    attached.delete(tabId);
    epochs.delete(tabId);
    navigations.delete(tabId);
    networkEvents.delete(tabId);
    contexts.delete(tabId);
  });
}

function trackContext(tabId: number, method: string, params: unknown): void {
  if (method === 'Runtime.executionContextsCleared') {
    contexts.delete(tabId);
    return;
  }
  const known = contexts.get(tabId) ?? new Map<string, PageContext>();
  if (method === 'Runtime.executionContextCreated') {
    const context = (params as { context?: Record<string, unknown> } | undefined)?.context;
    if (context === undefined) return;
    const aux = typeof context.auxData === 'object' && context.auxData !== null ? (context.auxData as Record<string, unknown>) : {};
    if (typeof context.uniqueId !== 'string' || typeof context.id !== 'number' || typeof context.origin !== 'string') return;
    known.set(context.uniqueId, {
      id: context.id,
      uniqueId: context.uniqueId,
      origin: context.origin,
      frameId: typeof aux.frameId === 'string' ? aux.frameId : undefined,
      isDefault: aux.isDefault === true,
    });
    contexts.set(tabId, known);
    return;
  }
  if (method === 'Runtime.executionContextDestroyed') {
    const destroyed = params as { executionContextId?: unknown; executionContextUniqueId?: unknown } | undefined;
    for (const [uniqueId, context] of known) {
      if (uniqueId === destroyed?.executionContextUniqueId || context.id === destroyed?.executionContextId) {
        known.delete(uniqueId);
      }
    }
  }
}

/**
 * The page's own JavaScript world in the tab's main frame: its unique id and the origin the browser
 * reports for it. A command sent with this id fails once a navigation has replaced the context, so it
 * can never run in a later document.
 */
export async function mainWorldContext(tabId: number): Promise<{ uniqueId: string; origin: string }> {
  await ensureAttached(tabId);
  const tree = await sendCommand<{ frameTree?: { frame?: { id?: unknown } } }>(tabId, 'Page.getFrameTree');
  const mainFrameId = tree.frameTree?.frame?.id;
  if (typeof mainFrameId !== 'string') throw new Error('The browser did not report the page frame');
  let found: PageContext | undefined;
  for (const context of contexts.get(tabId)?.values() ?? []) {
    if (context.isDefault && context.frameId === mainFrameId) found = context;
  }
  if (found === undefined) throw new Error('The page has no JavaScript context yet; try again once it has loaded.');
  return { uniqueId: found.uniqueId, origin: found.origin };
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
    contexts.delete(tabId);
    await chrome.debugger.sendCommand({ tabId }, 'Page.enable');
    await chrome.debugger.sendCommand({ tabId }, 'Network.enable');
    // Reports every existing context before it answers, then each new or destroyed one.
    await chrome.debugger.sendCommand({ tabId }, 'Runtime.enable');
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

async function withTimeout<T>(promise: Promise<T>, milliseconds: number, message: string): Promise<T> {
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
