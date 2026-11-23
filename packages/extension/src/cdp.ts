import { clearForeignFrames } from './foreign-frames';
import { originOf } from './permissions';

const PROTOCOL = '1.3';
const COMMAND_TIMEOUT_MS = 15_000;
const ATTACH_COMMAND_TIMEOUT_MS = 5_000;
const FOREIGN_FRAME_ATTEMPTS = 5;
const MAX_COMMAND_ATTEMPTS = 4;
const MAX_DIALOG_TEXT = 300;

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

/** A JavaScript dialog the tab is waiting on. Nothing in the page runs until it is answered. */
export interface OpenDialog {
  type: string;
  message: string;
  defaultPrompt: string;
  /** The address of the frame that opened it. */
  url: string;
  /** Text a `type` step gave for a prompt, sent when it is accepted. */
  input?: string;
}

/** A command could not finish because the tab is waiting on a dialog. */
export class DialogOpenError extends Error {}

const dialogs = new Map<number, OpenDialog>();
const dialogWaiters = new Map<number, Set<() => void>>();
/** Per tab: the main document's loader and address, to tell a reattach to the same document from a new one. */
const mainDocuments = new Map<number, { loaderId: string; url: string }>();
/** Tabs the debugger left since their last attach. */
const detached = new Set<number>();
/** Per tab: how many running batches need the page to take input while it is in the background. */
const focusHolds = new Map<number, number>();
const focusReleaseDue = new Set<number>();

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
    if (method === 'Page.javascriptDialogOpening') {
      trackDialog(source.tabId, params);
      return;
    }
    if (method === 'Page.javascriptDialogClosed') {
      dialogClosed(source.tabId);
      return;
    }
    if (method !== 'Page.frameNavigated') return;
    const frame = (params as { frame?: { parentId?: unknown; url?: unknown; loaderId?: unknown } } | undefined)?.frame;
    // Only the top frame replaces the document the held refs point into.
    if (frame !== undefined && frame.parentId === undefined) {
      bumpEpoch(source.tabId);
      const url = typeof frame.url === 'string' ? frame.url : '';
      logNavigation(source.tabId, url);
      if (typeof frame.loaderId === 'string') mainDocuments.set(source.tabId, { loaderId: frame.loaderId, url });
      else mainDocuments.delete(source.tabId);
    }
  });
  chrome.debugger.onDetach.addListener((source) => {
    if (source.tabId === undefined) return;
    attached.delete(source.tabId);
    contexts.delete(source.tabId);
    dialogs.delete(source.tabId);
    focusReleaseDue.delete(source.tabId);
    // The epoch moves on the next attach, and only if a different document is showing by then.
    detached.add(source.tabId);
  });
  chrome.tabs.onRemoved.addListener((tabId) => {
    attached.delete(tabId);
    epochs.delete(tabId);
    navigations.delete(tabId);
    networkEvents.delete(tabId);
    contexts.delete(tabId);
    dialogs.delete(tabId);
    mainDocuments.delete(tabId);
    detached.delete(tabId);
    focusHolds.delete(tabId);
    focusReleaseDue.delete(tabId);
    notifyDialogWaiters(tabId);
  });
}

function trackDialog(tabId: number, params: unknown): void {
  const opened = (params ?? {}) as Record<string, unknown>;
  dialogs.set(tabId, {
    type: typeof opened.type === 'string' ? opened.type : 'alert',
    message: typeof opened.message === 'string' ? opened.message : '',
    defaultPrompt: typeof opened.defaultPrompt === 'string' ? opened.defaultPrompt : '',
    url: typeof opened.url === 'string' ? opened.url : '',
  });
  notifyDialogWaiters(tabId);
}

function dialogClosed(tabId: number): void {
  dialogs.delete(tabId);
  if (focusReleaseDue.delete(tabId) && (focusHolds.get(tabId) ?? 0) === 0) {
    void send(tabId, 'Emulation.setFocusEmulationEnabled', { enabled: false }).catch(() => undefined);
  }
}

function notifyDialogWaiters(tabId: number): void {
  const waiters = dialogWaiters.get(tabId);
  dialogWaiters.delete(tabId);
  for (const wake of waiters ?? []) wake();
}

/** Resolves when the tab opens a dialog; the returned function stops waiting. */
export function onDialogOpen(tabId: number, wake: () => void): () => void {
  const waiters = dialogWaiters.get(tabId) ?? new Set<() => void>();
  waiters.add(wake);
  dialogWaiters.set(tabId, waiters);
  return () => {
    waiters.delete(wake);
  };
}

export function openDialog(tabId: number): OpenDialog | undefined {
  return dialogs.get(tabId);
}

/**
 * What the agent is told about an open dialog. A dialog from a frame of another origin is named by origin
 * only, as `read` treats that frame, and can only be dismissed.
 */
export function dialogNotice(tabId: number, dialog: OpenDialog): string {
  const main = mainDocuments.get(tabId);
  const origin = originOf(dialog.url);
  if (main === undefined || origin === undefined || origin !== originOf(main.url)) {
    return `Tab ${tabId} is waiting on a dialog from another site (${origin ?? 'unknown origin'}). Answer it with act: press Escape to dismiss it.`;
  }
  const text = dialog.message.length > MAX_DIALOG_TEXT ? `${dialog.message.slice(0, MAX_DIALOG_TEXT - 1)}…` : dialog.message;
  const fill = dialog.type === 'prompt' ? ', after a type step for its text' : '';
  return `Tab ${tabId} is waiting on a JavaScript ${dialog.type}: ${JSON.stringify(text)}. Answer it with act: press Enter for OK${fill}, or Escape to cancel.`;
}

/** Answers the tab's open dialog. One the owner answered first counts as answered. */
export async function answerDialog(tabId: number, accept: boolean, promptText?: string): Promise<void> {
  try {
    await send(tabId, 'Page.handleJavaScriptDialog', { accept, ...(promptText === undefined ? {} : { promptText }) });
  } catch (error) {
    if (!(error instanceof Error && /No dialog is showing/.test(error.message))) throw error;
  }
  dialogClosed(tabId);
}

/**
 * Makes a background tab take input for the length of a batch: Chromium does not acknowledge wheel events on
 * a hidden page and holds mouse events for seconds. The page sees itself as visible and focused until the
 * returned function runs, so this is held only while steps run.
 */
export async function holdInputFocus(tabId: number): Promise<() => Promise<void>> {
  const holds = focusHolds.get(tabId) ?? 0;
  if (holds === 0) {
    const state = await sendCommand<{ result?: { value?: unknown } }>(tabId, 'Runtime.evaluate', {
      expression: 'document.visibilityState',
      returnByValue: true,
    });
    if (state.result?.value === 'visible' && (focusHolds.get(tabId) ?? 0) === 0) return async () => undefined;
    if ((focusHolds.get(tabId) ?? 0) === 0) {
      await sendCommand(tabId, 'Emulation.setFocusEmulationEnabled', { enabled: true });
    }
  }
  focusHolds.set(tabId, (focusHolds.get(tabId) ?? 0) + 1);
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    const left = (focusHolds.get(tabId) ?? 1) - 1;
    if (left > 0) {
      focusHolds.set(tabId, left);
      return;
    }
    focusHolds.delete(tabId);
    if (!attached.has(tabId)) return;
    if (dialogs.has(tabId)) {
      focusReleaseDue.add(tabId);
      return;
    }
    await send(tabId, 'Emulation.setFocusEmulationEnabled', { enabled: false }).catch(() => undefined);
  };
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
export async function mainWorldContext(tabId: number): Promise<{ id: number; uniqueId: string; origin: string }> {
  await ensureAttached(tabId);
  const tree = await sendCommand<{ frameTree?: { frame?: { id?: unknown } } }>(tabId, 'Page.getFrameTree');
  const mainFrameId = tree.frameTree?.frame?.id;
  if (typeof mainFrameId !== 'string') throw new Error('The browser did not report the page frame');
  let found: PageContext | undefined;
  for (const context of contexts.get(tabId)?.values() ?? []) {
    if (context.isDefault && context.frameId === mainFrameId) found = context;
  }
  if (found === undefined) throw new Error('The page has no JavaScript context yet; try again once it has loaded.');
  return { id: found.id, uniqueId: found.uniqueId, origin: found.origin };
}

/** Runs one DevTools protocol command on a tab, attaching the debugger first when needed. */
export async function sendCommand<T = Record<string, unknown>>(
  tabId: number,
  method: string,
  params?: Record<string, unknown>,
): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await ensureAttached(tabId);
      return await send<T>(tabId, method, params);
    } catch (error) {
      // The debugger can be detached behind our back (the user closes the banner, DevTools opens, another
      // extension's frame appears), and again while the session is being restored.
      if (!isNotAttached(error) || attempt >= MAX_COMMAND_ATTEMPTS) throw error;
      attached.delete(tabId);
      // The detach event can arrive after the reattach, so it cannot be what marks the session as lost.
      detached.add(tabId);
      // Input that was in flight has already reached the page (a click that focuses a login field is what
      // brings a password manager's frame in), so sending it again would press twice.
      if (method.startsWith('Input.') && /while handling command/i.test(error instanceof Error ? error.message : '')) {
        await ensureAttached(tabId);
        return {} as T;
      }
    }
  }
}

async function send<T>(tabId: number, method: string, params?: Record<string, unknown>): Promise<T> {
  // The one command the browser answers itself; every other waits on a page that a dialog has paused.
  const reachesPage = method !== 'Page.handleJavaScriptDialog';
  const waiting = reachesPage ? dialogs.get(tabId) : undefined;
  if (waiting !== undefined) throw new DialogOpenError(dialogNotice(tabId, waiting));
  const result = chrome.debugger.sendCommand({ tabId }, method, params) as Promise<unknown>;
  if (!reachesPage) return (await withTimeout(result, COMMAND_TIMEOUT_MS, `${method} timed out`)) as T;
  let stop = (): void => undefined;
  const paused = new Promise<never>((_resolve, reject) => {
    stop = onDialogOpen(tabId, () => {
      const dialog = dialogs.get(tabId);
      if (dialog !== undefined) reject(new DialogOpenError(dialogNotice(tabId, dialog)));
    });
  });
  try {
    return (await withTimeout(Promise.race([result, paused]), COMMAND_TIMEOUT_MS, `${method} timed out`)) as T;
  } finally {
    stop();
  }
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
  const reused = await attachDebugger(tabId);
  let sameDocument = false;
  try {
    contexts.delete(tabId);
    // `Runtime.enable` reports the existing contexts only when it turns the domain on.
    if (reused) await attachCommand(tabId, 'Runtime.disable');
    await attachCommand(tabId, 'Page.enable');
    await attachCommand(tabId, 'Network.enable');
    // Reports every existing context before it answers, then each new or destroyed one.
    await attachCommand(tabId, 'Runtime.enable');
    await attachCommand(tabId, 'DOM.enable');
    if ((focusHolds.get(tabId) ?? 0) > 0) {
      await attachCommand(tabId, 'Emulation.setFocusEmulationEnabled', { enabled: true });
    }
    const tree = (await attachCommand(tabId, 'Page.getFrameTree')) as { frameTree?: { frame?: { loaderId?: unknown; url?: unknown } } };
    const { loaderId, url } = tree.frameTree?.frame ?? {};
    sameDocument = detached.has(tabId) && typeof loaderId === 'string' && mainDocuments.get(tabId)?.loaderId === loaderId;
    if (typeof loaderId === 'string') mainDocuments.set(tabId, { loaderId, url: typeof url === 'string' ? url : '' });
    else mainDocuments.delete(tabId);
  } catch (error) {
    await chrome.debugger.detach({ tabId }).catch(() => undefined);
    throw error;
  }
  detached.delete(tabId);
  // Losing the debugger and getting it back on the same document leaves held refs valid.
  if (!sameDocument) bumpEpoch(tabId);
  attached.add(tabId);
}

/** Attaches, and says whether this extension's debugger was on the tab already. */
async function attachDebugger(tabId: number): Promise<boolean> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await chrome.debugger.attach({ tabId }, PROTOCOL);
      return false;
    } catch (error) {
      // Only this extension's own session gives this error: its detach event can arrive after the reattach
      // that followed it, and a restarted service worker has forgotten the session it left.
      if (error instanceof Error && /already attached/i.test(error.message)) return true;
      if (!isForeignFrameError(error)) throw error;
      if (attempt >= FOREIGN_FRAME_ATTEMPTS) {
        throw new Error("Another extension's frame on this page keeps blocking the browser debugger. Close its popup and try again.");
      }
      await clearForeignFrames(tabId);
      await new Promise((resolve) => setTimeout(resolve, 100 * attempt));
    }
  }
}

/** A page paused on a dialog from before the debugger came never answers these. */
async function attachCommand(tabId: number, method: string, params?: Record<string, unknown>): Promise<unknown> {
  const sent = chrome.debugger.sendCommand({ tabId }, method, params) as Promise<unknown>;
  return await withTimeout(
    sent,
    ATTACH_COMMAND_TIMEOUT_MS,
    `Tab ${tabId} is not responding. It may be showing a dialog from before T3-Tab connected: ask the owner to answer it, or close the tab.`,
  );
}

function bumpEpoch(tabId: number): void {
  epochs.set(tabId, documentEpoch(tabId) + 1);
}

function isNotAttached(error: unknown): boolean {
  return error instanceof Error && (/not attached|detached/i.test(error.message) || isForeignFrameError(error));
}

function isForeignFrameError(error: unknown): boolean {
  return error instanceof Error && /chrome-extension:\/\/ URL of different extension/.test(error.message);
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
