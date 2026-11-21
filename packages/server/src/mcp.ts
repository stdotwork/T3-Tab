import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { BrowserStatus } from '@t3-tab/protocol';

import { getStatus } from './client.js';

export async function runMcpServer(): Promise<void> {
  const server = new McpServer({ name: 't3-tab', version: '0.1.0' });
  server.registerTool(
    'status',
    { description: 'Show connected browsers and their tab counts.' },
    async () => {
      try {
        return { content: [{ type: 'text', text: formatStatus(await getStatus()) }] };
      } catch (error) {
        return {
          content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
          isError: true,
        };
      }
    },
  );
  await server.connect(new StdioServerTransport());
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
