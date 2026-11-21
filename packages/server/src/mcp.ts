import { randomUUID } from 'node:crypto';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { BrowserStatus, ToolContent, ToolMethod, ToolSession } from '@t3-tab/protocol';

import { callTool, getStatus, registerSession } from './client.js';
import { actShape, readShape, runJsShape, screenshotShape, tabsShape } from './tool-schemas.js';

export async function runMcpServer(): Promise<void> {
  const server = new McpServer({ name: 't3-tab', version: '0.1.0' });
  // This process is one agent's session and owns its tabs and read baselines.
  const sessionId = randomUUID();
  let session = makeSession(sessionId);

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
  server.registerTool(
    'act',
    { description: 'Run ordered page steps; returns the page diff.', inputSchema: actShape },
    browserTool('act'),
  );
  server.registerTool(
    'run_js',
    {
      description: 'Evaluate an expression or async function body in the page. Escape hatch; prefer act.',
      inputSchema: runJsShape,
    },
    browserTool('run_js'),
  );
  server.server.oninitialized = () => {
    session = makeSession(sessionId, server.server.getClientVersion()?.name);
    void registerSession(session).catch(() => undefined);
  };
  await server.connect(new StdioServerTransport());
}

/** A readable MCP-client name plus a short id, as shown on the tab group and in the side panel. */
export function makeSession(id: string, clientName?: string): ToolSession {
  const visible = [...(clientName ?? 'MCP client')]
    .map((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 32 || code === 127 ? ' ' : character;
    })
    .join('');
  const base = visible.replace(/\s+/g, ' ').trim().slice(0, 80) || 'MCP client';
  return { id, name: `${base} · ${id.replace(/[^a-z0-9]/gi, '').slice(0, 8) || 'session'}` };
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
