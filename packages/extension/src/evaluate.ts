import type { BrowserMethods } from '@t3-tab/protocol';

import { ensureAttached, mainWorldContext, sendCommand } from './cdp';
import { originOf, restrictedPageError } from './permissions';
import type { StoredSession } from './sessions';
import { resolveSessionTab } from './tabs';

interface RuntimeResult {
  result?: { value?: unknown; description?: string; type?: string };
  exceptionDetails?: { text?: string; exception?: { description?: string } };
}

/** A returned element would serialise to `{}`; it comes back as a short name such as `input#email.wide`. */
const DESCRIBE_NODES = `(value) => {
  if (typeof Node === 'undefined') return value;
  const name = (item) => {
    if (!(item instanceof Node)) return item;
    if (!(item instanceof Element)) return item.nodeName;
    const classes = Array.from(item.classList, (entry) => '.' + entry).join('');
    return item.localName + (item.id ? '#' + item.id : '') + classes;
  };
  if (value instanceof NodeList || value instanceof HTMLCollection) return Array.from(value, name);
  return Array.isArray(value) ? value.map(name) : name(value);
}`;

/**
 * Evaluates an expression or an async function body in the page and returns a JSON value. The call is
 * pinned to the main frame's JavaScript context after the browser reports that context's origin as the
 * approved one: a navigation that replaces the context makes the evaluation fail instead of running in the
 * new document. The agent's text is never part of a check.
 */
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
  const context = await mainWorldContext(tabId);
  if (context.origin !== expectedOrigin) {
    throw new Error(
      `The page's JavaScript context belongs to ${context.origin}, not the approved ${expectedOrigin}; read the page and approve it first.`,
    );
  }
  // Whatever parses as one expression returns its value; anything else is a function body.
  const describe = `const __t3TabDescribe = ${DESCRIBE_NODES};`;
  const asExpression = `(async () => {\n${describe}\nconst __t3TabValue = await (${expression.replace(/[;\s]+$/, '')}\n);\nreturn __t3TabDescribe(__t3TabValue);\n})()`;
  const asBody = `(async () => {\n${describe}\nreturn __t3TabDescribe(await (async () => {\n${expression}\n})());\n})()`;
  const wrapped = (await compiles(tabId, context.id, asExpression)) ? asExpression : asBody;
  let evaluated: RuntimeResult;
  try {
    evaluated = await sendCommand<RuntimeResult>(tabId, 'Runtime.evaluate', {
      expression: wrapped,
      uniqueContextId: context.uniqueId,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
      includeCommandLineAPI: true,
    });
  } catch (error) {
    if (error instanceof Error && /uniqueContextId not found|Cannot find context/i.test(error.message)) {
      throw new Error('The page changed before run_js could start; read the new page and approve it before continuing.');
    }
    throw error;
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

/** Parses without running, in the page's context; the page's content security policy does not apply. */
async function compiles(tabId: number, executionContextId: number, expression: string): Promise<boolean> {
  const compiled = await sendCommand<{ exceptionDetails?: unknown }>(tabId, 'Runtime.compileScript', {
    expression,
    sourceURL: '',
    persistScript: false,
    executionContextId,
  });
  return compiled.exceptionDetails === undefined;
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
