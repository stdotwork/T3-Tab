import {
  type ActFollowThrough,
  type ActStep,
  actStepRef,
  DEFAULT_SCREENSHOT_MAX_EDGE,
  NO_TAB_MESSAGE,
  type TabInfo,
  type TabLoadResult,
  type TabNavigation,
  type ToolContent,
  type ToolMethod,
  type ToolSession,
} from '@t3-tab/protocol';
import type { z } from 'zod';

import type { BrowserLink } from './browser-link.js';
import type { SetValue } from './reader/echo.js';
import { truncate } from './reader/format.js';
import { formatRead, LOAD_REPLY_MAX, MAX_OUTPUT_CHARS, type ReadOptions } from './reader/page.js';
import { actParams, convertStep, MAX_FIND, readParams, runJsParams, screenshotParams, tabsParams } from './tool-schemas.js';

const MAX_TAB_TITLE = 80;
const MAX_TAB_URL = 150;
const NAVIGATED: Record<TabNavigation, string> = { goto: 'Loaded', back: 'Back in', forward: 'Forward in', reload: 'Reloaded' };

/** Runs one browser tool call and returns what the agent sees. Throws a readable message on a bad call or a failure. */
export async function runTool(
  link: BrowserLink,
  session: ToolSession,
  method: ToolMethod,
  params: Record<string, unknown>,
): Promise<ToolContent[]> {
  switch (method) {
    case 'tabs':
      return [{ type: 'text', text: await runTabs(link, session, parse(tabsParams, params)) }];
    case 'read':
      return [{ type: 'text', text: await runRead(link, session, parse(readParams, params)) }];
    case 'screenshot':
      return await runScreenshot(link, session, parse(screenshotParams, params));
    case 'act':
      return [{ type: 'text', text: await runAct(link, session, parse(actParams, params)) }];
    case 'run_js':
      return [{ type: 'text', text: await runJs(link, session, parse(runJsParams, params)) }];
  }
}

async function runTabs(
  link: BrowserLink,
  session: ToolSession,
  params: z.infer<typeof tabsParams>,
): Promise<string> {
  // The owner's tabs for a thread started from the side panel; its first message carries the code.
  if (params.claim !== undefined) await link.request(session, 'session.claim', { code: params.claim, route: 'message' });
  const action = params.action ?? 'list';
  switch (action) {
    case 'list': {
      const { tabs } = await link.request(session, 'tabs.list', {});
      return tabs.length === 0 ? NO_TAB_MESSAGE : tabs.map(tabLine).join('\n');
    }
    case 'open': {
      if (params.url === undefined) throw new Error('open needs a url');
      const opened = await link.request(session, 'tabs.open', { url: params.url, ...skipLongPage(params.find) });
      return await loadReply(link, session, 'Opened', opened, { find: params.find, load: true });
    }
    case 'goto':
    case 'back':
    case 'forward':
    case 'reload': {
      if (action === 'goto' && params.url === undefined) throw new Error('goto needs a url');
      const moved = await link.request(session, 'tabs.navigate', {
        action,
        ...(params.tab === undefined ? {} : { tab: params.tab }),
        ...(action !== 'goto' || params.url === undefined ? {} : { url: params.url }),
        ...skipLongPage(params.find),
      });
      return await loadReply(link, session, moved.opened === true ? 'Opened' : NAVIGATED[action], moved, { find: params.find, load: true });
    }
    case 'switch': {
      if (params.tab === undefined) throw new Error('switch needs a tab id');
      const { tab } = await link.request(session, 'tabs.switch', { tab: params.tab });
      return `Switched to tab ${tabLine(tab)}`;
    }
    case 'close': {
      if (params.tab === undefined) throw new Error('close needs a tab id');
      const { closed } = await link.request(session, 'tabs.close', { tab: params.tab });
      link.forgetTab(closed);
      return `Closed tab ${closed}.`;
    }
  }
}

async function runRead(link: BrowserLink, session: ToolSession, params: z.infer<typeof readParams>): Promise<string> {
  const { url, ...options } = params;
  if (url !== undefined) {
    // Refs belong to the document they came from, and a new tab is a new document.
    if (options.ref !== undefined) throw new Error('Invalid arguments: ref does not go with url');
    // A tab of the session already at the address is read as it is; no tab is ever moved or loaded again.
    const found = await link.request(session, 'tabs.open', { url, reuse: true, ...(params.tab === undefined ? {} : { tab: params.tab }) });
    if (found.reused === true && found.page !== undefined) return await formatRead(link.tabState(found.page.tab), session.id, found.page, options);
    return await loadReply(link, session, 'Opened', found, options);
  }
  const page = await link.request(session, 'page.read', params.tab === undefined ? {} : { tab: params.tab });
  return await formatRead(link.tabState(page.tab), session.id, page, options);
}

/**
 * The reply to a page loaded by `tabs` (and to `read` with a url, which is a read): the page as a `read` with the same
 * options would show it, which is also the baseline the next read is diffed against. For a `tabs` load, a page over
 * `LOAD_REPLY_MAX` characters is left to the `read` an agent sends with it. A tab a redirect took to an origin nobody
 * approved shows only its origin, and how to ask.
 */
async function loadReply(
  link: BrowserLink,
  session: ToolSession,
  verb: string,
  loaded: TabLoadResult,
  options: ReadOptions,
): Promise<string> {
  if (loaded.page === undefined) {
    if (loaded.textLength !== undefined) {
      const size = loaded.textLength.toLocaleString('en-US');
      return `${verb} tab ${tabLine(loaded.tab)}${redirectNote(loaded)}\n(${size} characters of text, too long for this reply: read shows it, find searches it.)`;
    }
    const why = loaded.unread === undefined ? '' : `\n${loaded.unread}`;
    const note = redirectNote(loaded) || (loaded.tab.needsApproval === true || why !== '' ? '' : '\nread it for the page.');
    return `${verb} tab ${tabLine(loaded.tab)}${note}${why}`;
  }
  const read = await formatRead(link.tabState(loaded.page.tab), session.id, loaded.page, options);
  // The read's header is `tab <id>` and its title and address; the reply marks the current tab as `tabs list` does.
  const header = `tab ${loaded.page.tab}`;
  const marked = loaded.tab.active && read.startsWith(header) ? `${header} [current]${read.slice(header.length)}` : read;
  const lineEnd = marked.indexOf('\n');
  const [first, rest] = lineEnd === -1 ? [marked, ''] : [marked.slice(0, lineEnd), marked.slice(lineEnd)];
  return `${verb} ${first}${redirectNote(loaded)}${rest}`;
}

/**
 * A load without `find` replies with the whole page only up to `LOAD_REPLY_MAX`, so the browser need not read a page whose
 * text alone is longer: the agent reads it anyway.
 */
function skipLongPage(find: string | undefined): { skipReadOver?: number } {
  return find === undefined ? { skipReadOver: LOAD_REPLY_MAX } : {};
}

async function runScreenshot(
  link: BrowserLink,
  session: ToolSession,
  params: z.infer<typeof screenshotParams>,
): Promise<ToolContent[]> {
  const shot = await link.request(session, 'page.screenshot', {
    ...(params.tab === undefined ? {} : { tab: params.tab }),
    maxEdge: Math.round(params.maxEdge ?? DEFAULT_SCREENSHOT_MAX_EDGE),
  });
  const scaled = shot.width !== shot.viewportWidth || shot.height !== shot.viewportHeight;
  const size = `${shot.width}x${shot.height}${scaled ? ` (viewport ${shot.viewportWidth}x${shot.viewportHeight})` : ''}`;
  return [
    { type: 'text', text: `tab ${shot.tab}: ${size}` },
    { type: 'image', data: shot.data, mimeType: 'image/jpeg' },
  ];
}

async function runAct(
  link: BrowserLink,
  session: ToolSession,
  params: z.infer<typeof actParams>,
): Promise<string> {
  // Checked here, not in the schema the agent reads on every turn. An empty find is no find, as for `read`.
  if ((params.find?.length ?? 0) > MAX_FIND) throw new Error(`Invalid arguments: find: at most ${MAX_FIND} characters`);
  const find = params.find === '' ? undefined : params.find;
  const tabId = params.tab ?? (await currentTabId(link, session));
  const state = link.tabState(tabId);
  const steps = params.steps.map((flat) => {
    const step = convertStep(flat);
    if (typeof step === 'string') throw new Error(`Invalid arguments: ${step}`);
    return step;
  });
  const backendIds = steps.map((step) => {
    const ref = actStepRef(step);
    if (ref === undefined) return null;
    const backendId = state.refTable.backendIdOf(ref);
    if (backendId === undefined) throw new Error(`Unknown ref ${ref}: read the page again`);
    return backendId;
  });
  const page = await link.request(session, 'page.act', {
    tab: tabId,
    steps,
    backendIds,
    epoch: state.currentEpoch,
    skipReadOver: LOAD_REPLY_MAX,
  });
  // The tabs the batch opened are told after its own reply, so that reply leaves them their room under the cap.
  const cap = MAX_OUTPUT_CHARS - openedRoom(page);
  // A page paused on a dialog has nothing to read, and its refs and diff baselines stay as they were. A search, as `read`
  // with `find` gives it, answers only a batch that went through.
  const reply =
    page.dialog !== undefined
      ? `tab ${page.tab}\n${page.dialog}`
      : page.failure === undefined && find !== undefined
        ? await formatRead(state, session.id, page, { find, cap })
        : await formatRead(state, session.id, page, {
            echoed: setValues(steps.slice(0, page.failure === undefined ? undefined : page.failure.step - 1)),
            cap,
          });
  const whole = `${reply}${await openedLines(link, session, page)}`;
  if (page.failure !== undefined) {
    throw new Error(`Step ${page.failure.step} (${page.failure.action}) failed: ${page.failure.error}\n${whole}`);
  }
  return whole;
}

/** Most characters one opened tab's line takes when it comes without its page: the tab, and why it was not read. */
const OPENED_LINE_MAX = 500;
const OPENED_ELSEWHERE_MAX = 100;
const MAX_UNREAD = 240;

/** What the lines about a batch's opened tabs can take of the cap: each tab's line, and one page. */
function openedRoom(page: ActFollowThrough): number {
  const opened = page.opened ?? [];
  const withPage = opened.some((tab) => tab.page !== undefined || tab.textLength !== undefined);
  return opened.length * OPENED_LINE_MAX + (withPage ? LOAD_REPLY_MAX : 0) + ((page.openedElsewhere ?? 0) > 0 ? OPENED_ELSEWHERE_MAX : 0);
}

/**
 * The tabs a batch opened, each as a load's reply shows it: by origin, with `[needs approval]`, until the session may
 * read it, and the first readable one with its page, within the room `openedRoom` kept for them.
 */
async function openedLines(link: BrowserLink, session: ToolSession, page: ActFollowThrough): Promise<string> {
  let lines = '';
  for (const opened of page.opened ?? []) {
    const shown = opened.unread === undefined ? opened : { ...opened, unread: truncate(opened.unread, MAX_UNREAD) };
    lines += `\n${await loadReply(link, session, 'Opened', shown, { load: true })}`;
  }
  const elsewhere = page.openedElsewhere ?? 0;
  if (elsewhere > 0) lines += `\n${elsewhere === 1 ? '1 more tab' : `${elsewhere} more tabs`} opened that this session does not hold.`;
  return lines;
}

/** The values a batch's steps set on elements, for the reply to leave out what the page shows back. */
function setValues(steps: ActStep[]): SetValue[] {
  const sets: SetValue[] = [];
  for (const step of steps) {
    if ('fill' in step) sets.push({ ref: step.fill.ref, kind: 'value', text: step.fill.value });
    else if ('type' in step && step.type.ref !== undefined) sets.push({ ref: step.type.ref, kind: 'value', text: step.type.text, appends: true });
    else if ('select' in step) sets.push({ ref: step.select.ref, kind: 'select', text: step.select.value });
  }
  return sets;
}

async function runJs(link: BrowserLink, session: ToolSession, params: z.infer<typeof runJsParams>): Promise<string> {
  const result =
    params.tab === undefined
      ? await link.request(session, 'page.eval', { expression: params.expression })
      : await link.request(session, 'page.eval', { tab: params.tab, expression: params.expression });
  const json = JSON.stringify(result.value);
  return limitJson(json === undefined ? 'null' : json);
}

async function currentTabId(link: BrowserLink, session: ToolSession): Promise<number> {
  const { tabs } = await link.request(session, 'tabs.list', {});
  const front = tabs.find((tab) => tab.active) ?? tabs[0];
  if (front === undefined) throw new Error(NO_TAB_MESSAGE);
  return front.id;
}

function limitJson(text: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  return `${text.slice(0, MAX_OUTPUT_CHARS)}\n… truncated at ${MAX_OUTPUT_CHARS} characters. Use a narrower expression.`;
}

function tabLine(tab: TabInfo): string {
  const current = tab.active ? ' [current]' : '';
  if (tab.needsApproval === true) return `${tab.id}${current} [needs approval] ${truncate(tab.url, MAX_TAB_URL)}`;
  return `${tab.id}${current} ${truncate(tab.title, MAX_TAB_TITLE)} — ${truncate(tab.url, MAX_TAB_URL)}`;
}

/** Where a load was redirected from, and, for an origin nobody approved yet, how to ask for it. */
function redirectNote(moved: { tab: TabInfo; redirectedFrom?: string }): string {
  if (moved.redirectedFrom === undefined) return '';
  if (moved.tab.needsApproval !== true) return `\nRedirected from ${moved.redirectedFrom}.`;
  return `\nRedirected from ${moved.redirectedFrom}. read this tab to ask the owner for access.`;
}

function parse<S extends z.ZodType>(schema: S, params: Record<string, unknown>): z.infer<S> {
  const result = schema.safeParse(params);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  const path = issue === undefined || issue.path.length === 0 ? '' : `${issue.path.join('.')}: `;
  throw new Error(`Invalid arguments: ${path}${issue?.message ?? 'unexpected input'}`);
}
