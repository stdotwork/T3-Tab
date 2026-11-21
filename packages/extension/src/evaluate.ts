import type { BrowserMethods } from '@t3-tab/protocol';

import { ensureAttached, sendCommand } from './cdp';
import { originOf, restrictedPageError } from './permissions';
import type { StoredSession } from './sessions';
import { beginPopupCapture, resolveSessionTab } from './tabs';

interface RuntimeResult {
  result?: { value?: unknown; description?: string; type?: string };
  exceptionDetails?: { text?: string; exception?: { description?: string } };
}

const BODY_START = /^\s*(?:await\b|const\b|let\b|var\b|return\b|if\b|for\b|while\b|try\b|throw\b|\{)/;

/** Evaluates an expression or an async function body in the page and returns a JSON value. */
export async function evaluatePage(
  session: StoredSession,
  tab: number | undefined,
  source: string,
  expectedOrigin: string,
  reloadSession: () => Promise<StoredSession>,
): Promise<BrowserMethods['page.eval']['result']> {
  const expression = source.trim();
  if (expression === '') throw new Error('run_js needs an expression');
  const found = await resolveSessionTab(session, tab);
  const tabId = found.id ?? -1;
  await ensureAttached(tabId);
  const latest = await reloadSession();
  const current = await resolveSessionTab(latest, tabId);
  assertCurrentOrigin(current, expectedOrigin);
  const permissionCheck = `if (location.origin !== ${JSON.stringify(expectedOrigin)}) { throw new Error('The page origin changed before run_js; read it and approve the new origin.'); }`;
  const wrapped = BODY_START.test(expression)
    ? `(async () => {\n${permissionCheck}\n${expression}\n})()`
    : `(async () => {\n${permissionCheck}\nreturn await (${expression});\n})()`;
  const releasePopupCapture = /\bwindow\s*\.\s*open\s*\(/.test(expression)
    ? beginPopupCapture(session)
    : undefined;
  let evaluated: RuntimeResult;
  try {
    evaluated = await sendCommand<RuntimeResult>(tabId, 'Runtime.evaluate', {
      expression: wrapped,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
      includeCommandLineAPI: true,
    });
  } finally {
    if (releasePopupCapture !== undefined) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      releasePopupCapture();
    }
  }
  if (evaluated.exceptionDetails !== undefined) {
    const message = evaluated.exceptionDetails.exception?.description ?? evaluated.exceptionDetails.text ?? 'JavaScript failed';
    throw new Error(`run_js failed: ${message}`);
  }
  if (evaluated.result === undefined) return { value: null };
  if (evaluated.result.value !== undefined) return { value: evaluated.result.value };
  if (evaluated.result.type === 'undefined') return { value: null };
  throw new Error(`run_js result cannot be returned as JSON (${evaluated.result.description ?? evaluated.result.type ?? 'unknown'})`);
}

function assertCurrentOrigin(tab: chrome.tabs.Tab, expectedOrigin: string): void {
  const url = tab.url ?? tab.pendingUrl ?? '';
  const error = restrictedPageError(url);
  if (error !== undefined) throw new Error(error);
  const actual = originOf(url);
  if (actual !== expectedOrigin) {
    throw new Error(`The page moved from ${expectedOrigin} to ${actual ?? 'an unknown origin'}; approve the new origin first.`);
  }
}
