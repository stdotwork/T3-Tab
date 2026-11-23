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

interface LoadWaiter {
  since: number;
  /** For a move through history, which may stay within the document and then fires no load event. */
  sameDocumentSince: number | undefined;
  wake: () => void;
}

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
const mainDocuments = new Map<number, { loaderId: string; url: string; frameId?: string }>();
/** Tabs the debugger left since their last attach. */
const detached = new Set<number>();
/** Per tab: how many running batches need the page to take input while it is in the background. */
const focusHolds = new Map<number, number>();
const focusReleaseDue = new Set<number>();
/** Per tab: top-frame commits, counted apart from the debugger so those made while it is off are seen too. */
const topCommits = new Map<number, number>();
const commitsAtDetach = new Map<number, number>();
/** Per tab: the origin the running tool call was approved for, the only one whose frames recovery may touch. */
const recoveryOrigins = new Map<number, string>();
/** Per tab: the end of the queue of dialog answers. */
const dialogAnswers = new Map<number, Promise<unknown>>();
/** Per tab: the epoch of the last document that finished loading. */
const loadedEpochs = new Map<number, number>();
const loadWaiters = new Map<number, Set<LoadWaiter>>();
/** Per tab: how many times the main frame moved within one document (a fragment or `pushState` entry). */
const sameDocumentMoves = new Map<number, number>();
/** Per tab: the HTTP method of the document request in flight, by loader, and of the document showing. */
const pendingMethods = new Map<number, Map<string, string>>();
const documentMethods = new Map<number, string>();
const MAX_PENDING_METHODS = 32;
/** Per tab: T3-Tab's own JavaScript world for the current document, which the page's scripts cannot see. */
const privateWorlds = new Map<number, { epoch: number; contextId: number }>();

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
      if (method === 'Network.requestWillBeSent') trackDocumentRequest(source.tabId, params);
      return;
    }
    if (method === 'Page.loadEventFired') {
      documentLoaded(source.tabId);
      return;
    }
    if (method === 'Page.navigatedWithinDocument') {
      movedWithinDocument(source.tabId, params);
      return;
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
    const navigated = params as { type?: unknown; frame?: { id?: unknown; parentId?: unknown; url?: unknown; loaderId?: unknown } } | undefined;
    const frame = navigated?.frame;
    // Only the top frame replaces the document the held refs point into.
    if (frame !== undefined && frame.parentId === undefined) {
      bumpEpoch(source.tabId);
      const url = typeof frame.url === 'string' ? frame.url : '';
      logNavigation(source.tabId, url);
      if (typeof frame.loaderId === 'string') {
        mainDocuments.set(source.tabId, { loaderId: frame.loaderId, url, ...(typeof frame.id === 'string' ? { frameId: frame.id } : {}) });
      } else {
        mainDocuments.delete(source.tabId);
      }
      commitDocumentMethod(source.tabId, frame.loaderId);
      // A page restored from the back-forward cache is already loaded and fires no load event.
      if (navigated?.type === 'BackForwardCacheRestore') documentLoaded(source.tabId);
    }
  });
  chrome.webNavigation.onCommitted.addListener((details) => {
    if (details.frameId === 0) topCommits.set(details.tabId, (topCommits.get(details.tabId) ?? 0) + 1);
  });
  chrome.debugger.onDetach.addListener((source) => {
    if (source.tabId === undefined) return;
    attached.delete(source.tabId);
    contexts.delete(source.tabId);
    dialogs.delete(source.tabId);
    focusReleaseDue.delete(source.tabId);
    privateWorlds.delete(source.tabId);
    // A document may commit while the debugger is off, so its method is no longer known.
    pendingMethods.delete(source.tabId);
    documentMethods.delete(source.tabId);
    wakeLoadWaiters(source.tabId);
    // The epoch moves on the next attach, and only if a different document is showing by then.
    markDetached(source.tabId);
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
    topCommits.delete(tabId);
    commitsAtDetach.delete(tabId);
    recoveryOrigins.delete(tabId);
    dialogAnswers.delete(tabId);
    loadedEpochs.delete(tabId);
    sameDocumentMoves.delete(tabId);
    pendingMethods.delete(tabId);
    documentMethods.delete(tabId);
    privateWorlds.delete(tabId);
    wakeLoadWaiters(tabId);
    notifyDialogWaiters(tabId);
  });
}

function trackDocumentRequest(tabId: number, params: unknown): void {
  const sent = params as { type?: unknown; loaderId?: unknown; request?: { method?: unknown } } | undefined;
  if (sent?.type !== 'Document' || typeof sent.loaderId !== 'string' || typeof sent.request?.method !== 'string') return;
  const methods = pendingMethods.get(tabId) ?? new Map<string, string>();
  // A redirect sends the same loader again: the last method is the one that made the document.
  methods.delete(sent.loaderId);
  methods.set(sent.loaderId, sent.request.method);
  for (const loader of methods.keys()) {
    if (methods.size <= MAX_PENDING_METHODS) break;
    methods.delete(loader);
  }
  pendingMethods.set(tabId, methods);
}

function commitDocumentMethod(tabId: number, loaderId: unknown): void {
  const method = typeof loaderId === 'string' ? pendingMethods.get(tabId)?.get(loaderId) : undefined;
  pendingMethods.delete(tabId);
  if (method === undefined) documentMethods.delete(tabId);
  else documentMethods.set(tabId, method);
}

/** The HTTP method that fetched the document showing, when the debugger saw it happen. */
export function documentMethod(tabId: number): string | undefined {
  return documentMethods.get(tabId);
}

function documentLoaded(tabId: number): void {
  const epoch = documentEpoch(tabId);
  loadedEpochs.set(tabId, epoch);
  for (const waiter of loadWaiters.get(tabId) ?? []) {
    if (waiter.since < epoch) waiter.wake();
  }
}

function movedWithinDocument(tabId: number, params: unknown): void {
  const frameId = (params as { frameId?: unknown } | undefined)?.frameId;
  if (frameId !== mainDocuments.get(tabId)?.frameId) return;
  const moves = sameDocumentMoveCount(tabId) + 1;
  sameDocumentMoves.set(tabId, moves);
  for (const waiter of loadWaiters.get(tabId) ?? []) {
    if (waiter.sameDocumentSince !== undefined && waiter.sameDocumentSince < moves) waiter.wake();
  }
}

/** Taken before a move through history, and passed to `waitForDocumentLoad`. */
export function sameDocumentMoveCount(tabId: number): number {
  return sameDocumentMoves.get(tabId) ?? 0;
}

function wakeLoadWaiters(tabId: number): void {
  for (const waiter of loadWaiters.get(tabId) ?? []) waiter.wake();
}

/**
 * Resolves when a document newer than epoch `since` has loaded, the tab opens a dialog (which holds the load open
 * until the agent answers it), the tab or debugger goes away, or the time is up: a slow page is still returned. With
 * `sameDocumentSince`, a move within the document since that count also ends the wait.
 */
export async function waitForDocumentLoad(tabId: number, since: number, timeoutMs: number, sameDocumentSince?: number): Promise<void> {
  if ((loadedEpochs.get(tabId) ?? -1) > since || dialogs.has(tabId)) return;
  if (sameDocumentSince !== undefined && sameDocumentMoveCount(tabId) > sameDocumentSince) return;
  await new Promise<void>((resolve) => {
    const waiters = loadWaiters.get(tabId) ?? new Set<LoadWaiter>();
    loadWaiters.set(tabId, waiters);
    const waiter: LoadWaiter = {
      since,
      sameDocumentSince,
      wake: (): void => {
        clearTimeout(timer);
        stopDialog();
        waiters.delete(waiter);
        if (waiters.size === 0 && loadWaiters.get(tabId) === waiters) loadWaiters.delete(tabId);
        resolve();
      },
    };
    const timer = setTimeout(waiter.wake, timeoutMs);
    const stopDialog = onDialogOpen(tabId, waiter.wake);
    waiters.add(waiter);
  });
}

/**
 * An isolated JavaScript world in the tab's main frame, for T3-Tab's own probes: it shares the DOM with the page, but
 * nothing kept there (a MutationObserver, a counter) is visible to the page's scripts.
 */
export async function privateWorld(tabId: number): Promise<number> {
  await ensureAttached(tabId);
  const epoch = documentEpoch(tabId);
  const known = privateWorlds.get(tabId);
  if (known?.epoch === epoch) return known.contextId;
  const tree = await sendCommand<{ frameTree?: { frame?: { id?: unknown } } }>(tabId, 'Page.getFrameTree');
  const frameId = tree.frameTree?.frame?.id;
  if (typeof frameId !== 'string') throw new Error('The browser did not report the page frame');
  const world = await sendCommand<{ executionContextId?: unknown }>(tabId, 'Page.createIsolatedWorld', { frameId, worldName: 'probe' });
  if (typeof world.executionContextId !== 'number') throw new Error('The browser did not create a world');
  privateWorlds.set(tabId, { epoch, contextId: world.executionContextId });
  return world.executionContextId;
}

/** Forgets the private world after a command found it gone (a document replaced it). */
export function forgetPrivateWorld(tabId: number): void {
  privateWorlds.delete(tabId);
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
  if (focusReleaseDue.delete(tabId) && (focusHolds.get(tabId) ?? 0) === 0) void turnFocusOff(tabId);
}

/** A dialog that opens first pauses the page, so the release is kept for when it closes. */
async function turnFocusOff(tabId: number): Promise<void> {
  try {
    await send(tabId, 'Emulation.setFocusEmulationEnabled', { enabled: false });
  } catch (error) {
    if (error instanceof DialogOpenError) focusReleaseDue.add(tabId);
  }
}

function markDetached(tabId: number): void {
  if (detached.has(tabId)) return;
  detached.add(tabId);
  commitsAtDetach.set(tabId, topCommits.get(tabId) ?? 0);
}

/** Names the origin a tool call was approved for, before it attaches. */
export function setRecoveryOrigin(tabId: number, origin: string): void {
  recoveryOrigins.set(tabId, origin);
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

/**
 * Answers the tab's open dialog, one answer at a time. `expected` is the dialog the caller checked: if it has
 * gone the answer is dropped, and if another took its place the call fails rather than answer that one. The
 * browser's command names no dialog, so one that replaces it in the moment before the command lands is not caught.
 */
export async function answerDialog(tabId: number, accept: boolean, promptText?: string, expected?: OpenDialog): Promise<void> {
  const answer = async (): Promise<void> => {
    const current = dialogs.get(tabId);
    if (current === undefined) return;
    if (expected !== undefined && current !== expected) throw new Error(dialogNotice(tabId, current));
    try {
      await send(tabId, 'Page.handleJavaScriptDialog', { accept, ...(promptText === undefined ? {} : { promptText }) });
    } catch (error) {
      if (!(error instanceof Error && /No dialog is showing/.test(error.message))) throw error;
    }
    if (dialogs.get(tabId) === current) dialogClosed(tabId);
  };
  const queued = (dialogAnswers.get(tabId) ?? Promise.resolve()).then(answer, answer);
  dialogAnswers.set(tabId, queued.catch(() => undefined));
  await queued;
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
    await turnFocusOff(tabId);
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
      markDetached(tabId);
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
  if (!reachesPage) {
    const answered = chrome.debugger.sendCommand({ tabId }, method, params) as Promise<unknown>;
    return (await withTimeout(answered, COMMAND_TIMEOUT_MS, `${method} timed out`)) as T;
  }
  let stop = (): void => undefined;
  const paused = new Promise<never>((_resolve, reject) => {
    stop = onDialogOpen(tabId, () => {
      const dialog = dialogs.get(tabId);
      if (dialog !== undefined) reject(new DialogOpenError(dialogNotice(tabId, dialog)));
    });
  });
  const result = chrome.debugger.sendCommand({ tabId }, method, params) as Promise<unknown>;
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
    const tree = (await attachCommand(tabId, 'Page.getFrameTree')) as { frameTree?: { frame?: { id?: unknown; loaderId?: unknown; url?: unknown } } };
    const { id: frameId, loaderId, url } = tree.frameTree?.frame ?? {};
    // The same loader alone is not enough: a page restored from the back-forward cache keeps its loader.
    sameDocument =
      detached.has(tabId) &&
      commitsAtDetach.get(tabId) === (topCommits.get(tabId) ?? 0) &&
      typeof loaderId === 'string' &&
      mainDocuments.get(tabId)?.loaderId === loaderId;
    if (typeof loaderId === 'string') {
      mainDocuments.set(tabId, { loaderId, url: typeof url === 'string' ? url : '', ...(typeof frameId === 'string' ? { frameId } : {}) });
    } else {
      mainDocuments.delete(tabId);
    }
  } catch (error) {
    await chrome.debugger.detach({ tabId }).catch(() => undefined);
    throw error;
  }
  detached.delete(tabId);
  commitsAtDetach.delete(tabId);
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
      const approved = recoveryOrigins.get(tabId);
      const actual = originOf((await chrome.tabs.get(tabId)).url ?? '');
      if (approved === undefined || actual !== approved) {
        throw new Error(`The page moved to ${actual ?? 'an unknown origin'}. Read the new page and approve it first.`);
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
