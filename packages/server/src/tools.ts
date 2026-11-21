import { DEFAULT_SCREENSHOT_MAX_EDGE, type TabInfo, type ToolContent, type ToolMethod } from '@t3-tab/protocol';
import type { z } from 'zod';

import type { BrowserLink } from './browser-link.js';
import { formatRead } from './reader/page.js';
import { readParams, screenshotParams, tabsParams } from './tool-schemas.js';

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
