import {
  type ActStep,
  actStepRef,
  DEFAULT_SCREENSHOT_MAX_EDGE,
  type TabInfo,
  type TabNavigation,
  type ToolContent,
  type ToolMethod,
  type ToolSession,
} from '@t3-tab/protocol';
import type { z } from 'zod';

import type { BrowserLink } from './browser-link.js';
import type { SetValue } from './reader/echo.js';
import { truncate } from './reader/format.js';
import { formatRead, MAX_OUTPUT_CHARS } from './reader/page.js';
import { actParams, convertStep, readParams, runJsParams, screenshotParams, tabsParams } from './tool-schemas.js';

const MAX_TAB_TITLE = 80;
const MAX_TAB_URL = 150;
const NO_TABS = 'No tabs in this session. Open one with action "open" and a url, or ask the owner to share one from the T3-Tab panel.';
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
      return tabs.length === 0 ? NO_TABS : tabs.map(tabLine).join('\n');
    }
    case 'open': {
      if (params.url === undefined) throw new Error('open needs a url');
      const opened = await link.request(session, 'tabs.open', { url: params.url });
      return `Opened tab ${tabLine(opened.tab)}${redirectNote(opened)}`;
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
      });
      return `${NAVIGATED[action]} tab ${tabLine(moved.tab)}${redirectNote(moved)}`;
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
  const page = await link.request(session, 'page.read', params.tab === undefined ? {} : { tab: params.tab });
  return await formatRead(link.tabState(page.tab), session.id, page, params);
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
  });
  // A page paused on a dialog has nothing to read, and its refs and diff baselines stay as they were.
  const reply =
    page.dialog === undefined
      ? await formatRead(state, session.id, page, { echoed: setValues(steps.slice(0, page.failure === undefined ? undefined : page.failure.step - 1)) })
      : `tab ${page.tab}\n${page.dialog}`;
  if (page.failure !== undefined) {
    throw new Error(`Step ${page.failure.step} (${page.failure.action}) failed: ${page.failure.error}\n${reply}`);
  }
  return reply;
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
  if (front === undefined) throw new Error(NO_TABS);
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

/** Said only when the agent has to do something about it: a redirect to an origin nobody approved yet. */
function redirectNote(moved: { tab: TabInfo; redirectedFrom?: string }): string {
  if (moved.redirectedFrom === undefined || moved.tab.needsApproval !== true) return '';
  return `\nRedirected from ${moved.redirectedFrom}. read this tab to ask the owner for access.`;
}

function parse<S extends z.ZodType>(schema: S, params: Record<string, unknown>): z.infer<S> {
  const result = schema.safeParse(params);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  const path = issue === undefined || issue.path.length === 0 ? '' : `${issue.path.join('.')}: `;
  throw new Error(`Invalid arguments: ${path}${issue?.message ?? 'unexpected input'}`);
}
