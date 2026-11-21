import { randomUUID } from 'node:crypto';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { BrowserStatus, ToolContent, ToolMethod } from '@t3-tab/protocol';

import { callTool, getStatus } from './client.js';
import { readShape, screenshotShape, tabsShape } from './tool-schemas.js';

export async function runMcpServer(): Promise<void> {
  const server = new McpServer({ name: 't3-tab', version: '0.1.0' });
  // This process is one agent's session: the daemon keeps its read baselines apart from other agents'.
  const session = randomUUID();

  server.registerTool(
    'status',
    { description: 'Show connected browsers and their tab counts.' },
    async () => {
      try {
        return { content: [{ type: 'text', text: formatStatus(await getStatus()) }] };
      } catch (error) {
        return failure(error);
      }
    },
  );

  const browserTool = (method: ToolMethod) => async (params: Record<string, unknown>) => {
    try {
      return { content: await callTool(method, params, session) satisfies ToolContent[] };
    } catch (error) {
      return failure(error);
    }
  };

  server.registerTool(
    'tabs',
    { description: 'List, open, switch to or close browser tabs.', inputSchema: tabsShape },
    browserTool('tabs'),
  );
  server.registerTool(
    'read',
    {
      description:
        'Read a page as text: interactive elements with refs (e12), plus headings. Later reads return only changes.',
      inputSchema: readShape,
    },
    browserTool('read'),
  );
  server.registerTool(
    'screenshot',
    { description: "JPEG of a tab's viewport, downscaled.", inputSchema: screenshotShape },
    browserTool('screenshot'),
  );
  await server.connect(new StdioServerTransport());
}

function failure(error: unknown): { content: ToolContent[]; isError: true } {
  return {
    content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
    isError: true,
  };
}

export function formatStatus(browsers: BrowserStatus[]): string {
  const count = browsers.length;
  const lines = [`Browsers: ${count}`];
  if (count === 0) lines.push('No browser connected.');
  for (const browser of browsers) {
    const tabs = browser.tabCount === 1 ? '1 tab' : `${browser.tabCount} tabs`;
    lines.push(`- ${browser.name}: ${tabs}`);
  }
  return lines.join('\n');
}
