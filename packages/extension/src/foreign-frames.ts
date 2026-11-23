/**
 * Chromium refuses and drops `chrome.debugger` on a tab while any frame in it belongs to another extension,
 * such as a password manager's autofill menu. This points those frames at about:blank so the debugger can
 * attach again. It runs one fixed function, takes no text from the agent or the page, and leaves the frame
 * elements in place, so the other extension's own bookkeeping still finds them.
 */
export async function clearForeignFrames(tabId: number): Promise<void> {
  await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    world: 'ISOLATED',
    func: blankForeignFrames,
    args: [chrome.runtime.id],
  });
}

/** Runs in the page's isolated world. Closed shadow roots are reachable there through `chrome.dom`. */
export function blankForeignFrames(ownId: string): number {
  const MAX_ELEMENTS = 100_000;
  let visited = 0;
  let blanked = 0;
  const roots: ParentNode[] = [document];
  while (roots.length > 0 && visited < MAX_ELEMENTS) {
    const root = roots.pop();
    if (root === undefined) break;
    for (const element of Array.from(root.querySelectorAll('*'))) {
      visited += 1;
      const shadow = chrome.dom.openOrClosedShadowRoot(element as HTMLElement);
      if (shadow !== null && shadow !== undefined) roots.push(shadow);
      if (!(element instanceof HTMLIFrameElement || element instanceof HTMLFrameElement)) continue;
      let url: URL;
      try {
        url = new URL(element.src);
      } catch {
        continue;
      }
      if (url.protocol === 'chrome-extension:' && url.hostname !== ownId) {
        element.src = 'about:blank';
        blanked += 1;
      }
    }
  }
  return blanked;
}
