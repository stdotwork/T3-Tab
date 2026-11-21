import {
  DEFAULT_SCREENSHOT_MAX_EDGE,
  type ActStep,
  type TabInfo,
  type ToolContent,
  type ToolMethod,
} from '@t3-tab/protocol';
import type { z } from 'zod';

import type { BrowserLink } from './browser-link.js';
import { formatRead, MAX_OUTPUT_CHARS } from './reader/page.js';
import { actParams, readParams, runJsParams, screenshotParams, tabsParams } from './tool-schemas.js';

const MAX_TAB_TITLE = 80;
const MAX_TAB_URL = 150;

/** Runs one browser tool call and returns what the agent sees. Throws a readable message on a bad call or a failure. */
export async function runTool(
  link: BrowserLink,
  session: string,
  method: ToolMethod,
  params: Record<string, unknown>,
): Promise<ToolContent[]> {
  switch (method) {
    case 'tabs':
      return [{ type: 'text', text: await runTabs(link, parse(tabsParams, params)) }];
    case 'read':
      return [{ type: 'text', text: await runRead(link, session, parse(readParams, params)) }];
    case 'screenshot':
      return await runScreenshot(link, parse(screenshotParams, params));
    case 'act':
      return [{ type: 'text', text: await runAct(link, session, parse(actParams, params)) }];
    case 'run_js':
      return [{ type: 'text', text: await runJs(link, parse(runJsParams, params)) }];
  }
}

async function runTabs(link: BrowserLink, params: z.infer<typeof tabsParams>): Promise<string> {
  switch (params.action ?? 'list') {
    case 'list': {
      const { tabs } = await link.request('tabs.list', {});
      return tabs.length === 0 ? 'No tabs.' : tabs.map(tabLine).join('\n');
    }
    case 'open': {
      if (params.url === undefined) throw new Error('open needs a url');
      const { tab } = await link.request('tabs.open', { url: params.url });
      return `Opened tab ${tabLine(tab)}`;
    }
    case 'switch': {
      if (params.tab === undefined) throw new Error('switch needs a tab id');
      const { tab } = await link.request('tabs.switch', { tab: params.tab });
      return `Switched to tab ${tabLine(tab)}`;
    }
    case 'close': {
      if (params.tab === undefined) throw new Error('close needs a tab id');
      const { closed } = await link.request('tabs.close', { tab: params.tab });
      link.forgetTab(closed);
      return `Closed tab ${closed}.`;
    }
  }
}

async function runRead(link: BrowserLink, session: string, params: z.infer<typeof readParams>): Promise<string> {
  const page = await link.request('page.read', params.tab === undefined ? {} : { tab: params.tab });
  return formatRead(link.tabState(page.tab), session, page, params);
}

async function runScreenshot(link: BrowserLink, params: z.infer<typeof screenshotParams>): Promise<ToolContent[]> {
  const shot = await link.request('page.screenshot', {
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
  session: string,
  params: z.infer<typeof actParams>,
): Promise<string> {
  const tabId = params.tab ?? (await currentTabId(link));
  const state = link.tabState(tabId);
  const backendIds = params.steps.map((step) => {
    const ref = refOf(step);
    if (ref === undefined) return null;
    const backendId = state.refTable.backendIdOf(ref);
    if (backendId === undefined) throw new Error(`Unknown ref ${ref}: read the page again`);
    return backendId;
  });
  const page = await link.request('page.act', {
    tab: tabId,
    steps: params.steps,
    backendIds,
    epoch: state.currentEpoch,
  });
  const reply = formatRead(state, session, page, {});
  if (page.failure !== undefined) {
    throw new Error(`Step ${page.failure.step} (${page.failure.action}) failed: ${page.failure.error}\n${reply}`);
  }
  return reply;
}

async function runJs(link: BrowserLink, params: z.infer<typeof runJsParams>): Promise<string> {
  const result =
    params.tab === undefined
      ? await link.request('page.eval', { expression: params.expression })
      : await link.request('page.eval', { tab: params.tab, expression: params.expression });
  const json = JSON.stringify(result.value);
  return limitJson(json === undefined ? 'null' : json);
}

async function currentTabId(link: BrowserLink): Promise<number> {
  const { tabs } = await link.request('tabs.list', {});
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
  return `${tab.id}${tab.active ? ' [front]' : ''} ${truncate(tab.title, MAX_TAB_TITLE)} — ${truncate(tab.url, MAX_TAB_URL)}`;
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
