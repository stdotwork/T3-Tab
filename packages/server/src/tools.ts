import {
  DEFAULT_SCREENSHOT_MAX_EDGE,
  type ActStep,
  type TabInfo,
  type ToolContent,
  type ToolMethod,
  type ToolSession,
} from '@t3-tab/protocol';
import type { z } from 'zod';

import type { BrowserLink } from './browser-link.js';
import { formatRead, MAX_OUTPUT_CHARS } from './reader/page.js';
import { actParams, convertStep, readParams, runJsParams, screenshotParams, tabsParams } from './tool-schemas.js';

const MAX_TAB_TITLE = 80;
const MAX_TAB_URL = 150;

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
  if (params.claim !== undefined) await link.request(session, 'session.claim', { code: params.claim });
  switch (params.action ?? 'list') {
    case 'list': {
      const { tabs } = await link.request(session, 'tabs.list', {});
      return tabs.length === 0 ? 'No tabs.' : tabs.map(tabLine).join('\n');
    }
    case 'open': {
      if (params.url === undefined) throw new Error('open needs a url');
      const { tab } = await link.request(session, 'tabs.open', { url: params.url });
      return `Opened tab ${tabLine(tab)}`;
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
    const ref = refOf(step);
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
  const reply = await formatRead(state, session.id, page, {});
  if (page.failure !== undefined) {
    throw new Error(`Step ${page.failure.step} (${page.failure.action}) failed: ${page.failure.error}\n${reply}`);
  }
  return reply;
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
  if (front === undefined) throw new Error('No tab is open');
  return front.id;
}

function refOf(step: ActStep): string | undefined {
  if ('click' in step) return step.click.ref;
  if ('type' in step) return step.type.ref;
  if ('fill' in step) return step.fill.ref;
  if ('select' in step) return step.select.ref;
  if ('scroll' in step) return step.scroll.ref;
  if ('hover' in step) return step.hover.ref;
  return undefined;
}

function limitJson(text: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  return `${text.slice(0, MAX_OUTPUT_CHARS)}\n… truncated at ${MAX_OUTPUT_CHARS} characters. Use a narrower expression.`;
}

function tabLine(tab: TabInfo): string {
  const front = tab.active ? ' [front]' : '';
  if (tab.needsApproval === true) return `${tab.id}${front} [needs approval] ${truncate(tab.url, MAX_TAB_URL)}`;
  return `${tab.id}${front} ${truncate(tab.title, MAX_TAB_TITLE)} — ${truncate(tab.url, MAX_TAB_URL)}`;
}

function parse<S extends z.ZodType>(schema: S, params: Record<string, unknown>): z.infer<S> {
  const result = schema.safeParse(params);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  const path = issue === undefined || issue.path.length === 0 ? '' : `${issue.path.join('.')}: `;
  throw new Error(`Invalid arguments: ${path}${issue?.message ?? 'unexpected input'}`);
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}
