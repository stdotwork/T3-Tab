import type { BrowserMethods } from '@t3-tab/protocol';

import { ensureAttached, sendCommand } from './cdp';
import type { StoredSession } from './sessions';
import { assertTabOrigin, resolveSessionTab } from './tabs';

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
): Promise<BrowserMethods['page.eval']['result']> {
  const expression = source.trim();
  if (expression === '') throw new Error('run_js needs an expression');
  const found = await resolveSessionTab(session, tab);
  const tabId = found.id ?? -1;
  await ensureAttached(tabId);
  await assertTabOrigin(tabId, expectedOrigin);
  const wrapped = BODY_START.test(expression) ? `(async () => {\n${expression}\n})()` : expression;
  const evaluated = await sendCommand<RuntimeResult>(tabId, 'Runtime.evaluate', {
    expression: wrapped,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
    includeCommandLineAPI: true,
  });
  if (evaluated.exceptionDetails !== undefined) {
    const message = evaluated.exceptionDetails.exception?.description ?? evaluated.exceptionDetails.text ?? 'JavaScript failed';
    throw new Error(`run_js failed: ${message}`);
  }
  if (evaluated.result === undefined) return { value: null };
  if (evaluated.result.value !== undefined) return { value: evaluated.result.value };
  if (evaluated.result.type === 'undefined') return { value: null };
  throw new Error(`run_js result cannot be returned as JSON (${evaluated.result.description ?? evaluated.result.type ?? 'unknown'})`);
}
