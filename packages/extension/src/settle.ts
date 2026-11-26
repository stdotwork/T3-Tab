import { documentEpoch, forgetPrivateWorld, networkRevision, openDialog, privateWorld, sendCommand } from './cdp';

const QUIET_MS = 150;
const POLL_MS = 50;
const MAX_SETTLE_MS = 4_000;

export interface SettleSnapshot {
  ready: boolean;
  /** Bumped by a MutationObserver inside the page. */
  revision: number;
  /** Viewport, document size and URL; any difference means layout or document changed. */
  layout: string;
  /** Bumped by any CDP Network event for the tab. */
  networkRevision: number;
}

export interface SettleResult {
  settled: boolean;
  timedOut: boolean;
  elapsedMs: number;
}

interface PageProbe {
  ready: boolean;
  revision: number;
  width: number;
  height: number;
  scrollWidth: number;
  scrollHeight: number;
  url: string;
}

/** Tracks whether a page has stayed still for long enough, independently of timers, for unit tests. */
export class SettleTracker {
  private previous: SettleSnapshot | undefined;
  private lastChangeAt: number;

  constructor(
    private readonly startedAt: number,
    private readonly quietMs = QUIET_MS,
    private readonly maxMs = MAX_SETTLE_MS,
  ) {
    this.lastChangeAt = startedAt;
  }

  observe(snapshot: SettleSnapshot, now: number): 'changed' | 'settled' | 'waiting' {
    const previous = this.previous;
    this.previous = snapshot;
    if (previous === undefined || !snapshot.ready || !sameSnapshot(previous, snapshot)) {
      this.lastChangeAt = now;
    }
    if (snapshot.ready && now - this.lastChangeAt >= this.quietMs) return 'settled';
    if (now - this.startedAt >= this.maxMs) return 'settled';
    return previous === undefined || !sameSnapshot(previous, snapshot) || !snapshot.ready ? 'changed' : 'waiting';
  }

  timedOut(now: number): boolean {
    return now - this.startedAt >= this.maxMs;
  }
}

/** Waits for network quiet and no DOM or layout changes for a short window, capped in duration. */
export async function settlePage(tabId: number): Promise<SettleResult> {
  const startedAt = Date.now();
  const tracker = new SettleTracker(startedAt);
  while (true) {
    // A dialog pauses the page, so there is nothing to wait for until it is answered.
    if (openDialog(tabId) !== undefined) return { settled: true, timedOut: false, elapsedMs: Date.now() - startedAt };
    // The tab closed: its epoch is forgotten, and there is nothing left to wait for.
    if (documentEpoch(tabId) === 0) return { settled: false, timedOut: false, elapsedMs: Date.now() - startedAt };
    const snapshot = await settleSnapshot(tabId);
    const now = Date.now();
    const state = tracker.observe(snapshot, now);
    if (state === 'settled') {
      return { settled: now - startedAt < MAX_SETTLE_MS, timedOut: tracker.timedOut(now), elapsedMs: now - startedAt };
    }
    if (tracker.timedOut(now)) return { settled: false, timedOut: true, elapsedMs: now - startedAt };
    await sleep(POLL_MS);
  }
}

/**
 * The page's state as the settle wait compares it: two snapshots that are the same mean nothing in the document, its
 * layout or its network traffic moved between them. A load's reply uses it to see whether the page moved while it was read.
 */
export async function settleSnapshot(tabId: number): Promise<SettleSnapshot> {
  const probe = await probePage(tabId);
  return {
    ready: probe.ready && probe.url !== '',
    revision: probe.revision,
    layout: `${documentEpoch(tabId)}|${probe.width}|${probe.height}|${probe.scrollWidth}|${probe.scrollHeight}|${probe.url}`,
    networkRevision: networkRevision(tabId),
  };
}

/** How many characters of text the page shows (`innerText` of its body), read in T3-Tab's own world; 0 when it cannot say. */
export async function pageTextLength(tabId: number): Promise<number> {
  try {
    const evaluated = await sendCommand<{ result?: { value?: unknown } }>(tabId, 'Runtime.evaluate', {
      contextId: await privateWorld(tabId),
      expression: 'document.body ? document.body.innerText.length : 0',
      returnByValue: true,
    });
    return numberOrZero(evaluated.result?.value);
  } catch {
    return 0;
  }
}

async function probePage(tabId: number): Promise<PageProbe> {
  try {
    // In T3-Tab's own world: the observer and its counter must not be something a site can find.
    const contextId = await privateWorld(tabId);
    const evaluated = await sendCommand<{ result?: { value?: unknown } }>(tabId, 'Runtime.evaluate', {
      contextId,
      expression: `(() => {
        const state = globalThis.settleState ||= { revision: 0, observer: null };
        if (state.observer === null && document.documentElement) {
          state.observer = new MutationObserver(() => { state.revision += 1; });
          state.observer.observe(document.documentElement, {
            subtree: true, childList: true, attributes: true, characterData: true
          });
        }
        return {
          ready: document.readyState === 'complete',
          revision: state.revision,
          width: innerWidth,
          height: innerHeight,
          scrollWidth: document.documentElement?.scrollWidth || 0,
          scrollHeight: document.documentElement?.scrollHeight || 0,
          url: location.href
        };
      })()`,
      returnByValue: true,
    });
    const value = evaluated.result?.value;
    if (typeof value !== 'object' || value === null) return emptyProbe();
    const record = value as Record<string, unknown>;
    return {
      ready: record.ready === true,
      revision: numberOrZero(record.revision),
      width: numberOrZero(record.width),
      height: numberOrZero(record.height),
      scrollWidth: numberOrZero(record.scrollWidth),
      scrollHeight: numberOrZero(record.scrollHeight),
      url: typeof record.url === 'string' ? record.url : '',
    };
  } catch {
    // A navigation can destroy the execution context between two probes.
    forgetPrivateWorld(tabId);
    return emptyProbe();
  }
}

function sameSnapshot(a: SettleSnapshot, b: SettleSnapshot): boolean {
  return (
    a.ready === b.ready &&
    a.revision === b.revision &&
    a.layout === b.layout &&
    a.networkRevision === b.networkRevision
  );
}

function emptyProbe(): PageProbe {
  return { ready: false, revision: 0, width: 0, height: 0, scrollWidth: 0, scrollHeight: 0, url: '' };
}

function numberOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

export function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
