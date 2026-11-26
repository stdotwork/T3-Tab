import { forgetPrivateWorld, privateWorld, sendCommand } from './cdp';
import { sleep } from './settle';

/** How long a wheel scroll may take to move something. A page the browser draws starts within a frame or two. */
export const SCROLL_MOVE_WAIT_MS = 600;
const SCROLL_POLL_MS = 40;

/** Where everything the wheel can move sits, and whether it can move further the way the wheel turned. */
export interface ScrollProbe {
  /** The page's scroll position, then the position of every scrollable ancestor of the element at the pointer. */
  positions: number[];
  /** Whether the page or one of those elements has room left in the direction of the scroll. */
  room: boolean;
}

/**
 * Scrolls the page with the mouse wheel at the middle of the viewport and checks that something moved. A page that is
 * not drawn (a tab in the background) takes the wheel event and moves nothing, and the step used to report success.
 * It fails only when the wheel moved nothing though the page or the element under the pointer had room to scroll; a
 * page already at its end, or one that does not scroll, is not an error. When the position cannot be read (the
 * pointer is over another document's frame, the page's script world is gone) nothing is checked.
 */
export async function scrollWithWheel(tabId: number, dx: number, dy: number, waitMs = SCROLL_MOVE_WAIT_MS): Promise<void> {
  const metrics = await sendCommand<{ cssLayoutViewport?: { clientWidth?: number; clientHeight?: number } }>(tabId, 'Page.getLayoutMetrics');
  const x = (metrics.cssLayoutViewport?.clientWidth ?? 800) / 2;
  const y = (metrics.cssLayoutViewport?.clientHeight ?? 600) / 2;
  const before = await probeScroll(tabId, x, y, dx, dy);
  await sendCommand(tabId, 'Input.dispatchMouseEvent', {
    type: 'mouseWheel',
    x,
    y,
    deltaX: dx,
    deltaY: dy,
  });
  if (before === undefined || !before.room) return;
  const deadline = Date.now() + waitMs;
  while (true) {
    const after = await probeScroll(tabId, x, y, dx, dy);
    // Unreadable now (the page was replaced, say): the next step's checks deal with that.
    if (after === undefined || moved(before, after)) return;
    if (Date.now() >= deadline) break;
    await sleep(SCROLL_POLL_MS);
  }
  throw new Error(
    `The page did not scroll: the mouse wheel moved nothing in ${waitMs / 1_000} seconds, though the page can scroll further. A tab in the background is not drawn and may ignore the wheel. Bring the tab to the front with tabs switch and scroll again, or use a scroll step with the ref of the element to bring into view.`,
  );
}

function moved(before: ScrollProbe, after: ScrollProbe): boolean {
  if (before.positions.length !== after.positions.length) return true;
  return before.positions.some((value, index) => value !== after.positions[index]);
}

async function probeScroll(tabId: number, x: number, y: number, dx: number, dy: number): Promise<ScrollProbe | undefined> {
  try {
    // In T3-Tab's own world: nothing here is visible to the page's scripts.
    const contextId = await privateWorld(tabId);
    const evaluated = await sendCommand<{ result?: { value?: unknown }; exceptionDetails?: unknown }>(tabId, 'Runtime.evaluate', {
      contextId,
      expression: `(${PROBE})(${x}, ${y}, ${dx}, ${dy})`,
      returnByValue: true,
    });
    return parseProbe(evaluated.result?.value);
  } catch {
    // A navigation can destroy the world between two probes.
    forgetPrivateWorld(tabId);
    return undefined;
  }
}

/** Reads a probe's answer; anything else (a script error, no answer) is "cannot tell". */
export function parseProbe(value: unknown): ScrollProbe | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const { positions, room } = value as { positions?: unknown; room?: unknown };
  if (!Array.isArray(positions) || typeof room !== 'boolean') return undefined;
  if (!positions.every((item) => typeof item === 'number' && Number.isFinite(item))) return undefined;
  return { positions: positions as number[], room };
}

/**
 * Runs in the page's document, in T3-Tab's own world. Walks from the deepest element at the pointer (through open
 * shadow roots) up through its ancestors, noting each scroll position and whether that element, or the page, can
 * scroll further the way the wheel turned. Over a frame of another document nothing can be read, so it says there is
 * no room and nothing is checked.
 */
const PROBE = `(x, y, dx, dy) => {
  const roomOn = (position, size, view, delta) => (delta > 0 ? position + view < size - 1 : delta < 0 ? position > 0 : false);
  const scrolls = (style) => style === 'auto' || style === 'scroll' || style === 'overlay';
  const positions = [scrollX, scrollY];
  const root = document.documentElement;
  const scroller = document.scrollingElement || root;
  const rootStyle = (axis) => {
    const own = getComputedStyle(root)[axis];
    return own !== 'visible' || !document.body ? own : getComputedStyle(document.body)[axis];
  };
  let room =
    (rootStyle('overflowY') !== 'hidden' && roomOn(scrollY, scroller.scrollHeight, innerHeight, dy)) ||
    (rootStyle('overflowX') !== 'hidden' && roomOn(scrollX, scroller.scrollWidth, innerWidth, dx));
  let element = document.elementFromPoint(x, y);
  while (element && element.shadowRoot) {
    const inner = element.shadowRoot.elementFromPoint(x, y);
    if (!inner || inner === element) break;
    element = inner;
  }
  if (element && (element.tagName === 'IFRAME' || element.tagName === 'FRAME')) return { positions, room: false };
  for (let depth = 0; element && depth < 60; depth += 1) {
    positions.push(element.scrollLeft, element.scrollTop);
    if (element !== root) {
      const style = getComputedStyle(element);
      if (scrolls(style.overflowY) && roomOn(element.scrollTop, element.scrollHeight, element.clientHeight, dy)) room = true;
      if (scrolls(style.overflowX) && roomOn(element.scrollLeft, element.scrollWidth, element.clientWidth, dx)) room = true;
    }
    element = element.parentElement || (element.getRootNode() && element.getRootNode().host) || null;
  }
  return { positions, room };
}`;
