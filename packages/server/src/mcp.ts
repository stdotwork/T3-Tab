import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { BrowserStatus, ToolContent, ToolMethod } from '@t3-tab/protocol';

import { claimFileNotice, takeClaimFile } from './agents/claim-file.js';
import { DaemonSession, getStatus } from './client.js';
import { ThreadPrompts } from './prompt-elicitation.js';
import { actShape, readShape, runJsShape, screenshotShape, tabsShape } from './tool-schemas.js';

/**
 * The SDK stamps every tool with `execution: { taskSupport: 'forbidden' }`, which is what an absent value
 * means, so the tool list does without it (about 40 characters a tool).
 */
function withoutExecution<T extends { execution?: unknown }>(tool: T): T {
  delete tool.execution;
  return tool;
}

/** Said once, in the first reply after a new session replaced one that ended. */
export const SESSION_RESTARTED_NOTICE =
  'T3-Tab: your earlier browser session ended (the background program restarted or the connection dropped). This is a new session: its tabs and approvals are gone, so open tabs again or ask the owner to share one.';

export async function runMcpServer(options: { claimFile?: string } = {}): Promise<void> {
  const server = new McpServer({ name: 't3-tab', version: '0.1.0' });
  // A direct run from the side panel names a private file with its claim code; it is read once and deleted.
  const taken = options.claimFile === undefined ? undefined : await takeClaimFile(options.claimFile);
  const claim = taken !== undefined && 'code' in taken ? taken.code : undefined;
  const problem =
    options.claimFile !== undefined && taken !== undefined && 'problem' in taken ? { file: options.claimFile, problem: taken.problem } : undefined;
  // This process is one agent's session and owns its tabs and read baselines.
  const control = new DaemonSession(process.env, claim, problem);
  // The agent was meant to have the owner's tabs and does not: its first browser tool reply says so.
  let notice = problem === undefined ? undefined : claimFileNotice(problem.problem);
  const takeNotice = (): ToolContent[] => {
    if (notice === undefined) return [];
    const content: ToolContent[] = [{ type: 'text', text: notice }];
    notice = undefined;
    return content;
  };

  withoutExecution(
    server.registerTool('status', { description: 'Show connected browsers and their tab counts.' }, async () => {
      try {
        return { content: [{ type: 'text', text: `${formatStatus(await getStatus())}\n${formatLink(control.link())}` }] };
      } catch (error) {
        return failure(error);
      }
    }),
  );

  const browserTool = browserToolHandler(control, takeNotice);

  withoutExecution(
    server.registerTool(
      'tabs',
      { description: 'List, open, switch to or close tabs. Loads (open, goto, back, forward, reload) reply with the page.', inputSchema: tabsShape },
      browserTool('tabs'),
    ),
  );
  withoutExecution(
    server.registerTool(
      'read',
      {
        description:
          "Read a page as text: interactive elements with refs (e12), headings, and the page's text up to a budget. Later reads return only changes.",
        inputSchema: readShape,
      },
      browserTool('read'),
    ),
  );
  withoutExecution(
    server.registerTool(
      'screenshot',
      { description: "JPEG of a tab's viewport, downscaled.", inputSchema: screenshotShape },
      browserTool('screenshot'),
    ),
  );
  withoutExecution(
    server.registerTool(
      'act',
      { description: 'Run ordered page steps; settles, returns the change and new tabs. No read needed.', inputSchema: actShape },
      browserTool('act'),
    ),
  );
  withoutExecution(
    server.registerTool(
      'run_js',
      {
        description: 'Evaluate JavaScript in the page. Escape hatch; prefer act.',
        inputSchema: runJsShape,
      },
      browserTool('run_js'),
    ),
  );
  // A permission prompt for this session is also put to the agent's own thread (see `prompt-elicitation.ts`).
  const threadPrompts = new ThreadPrompts(server.server, async (promptId, decision) => await control.answerPrompt(promptId, decision));
  control.onEvent((event) => threadPrompts.handle(event));
  server.server.oninitialized = () => {
    control.setClientName(server.server.getClientVersion()?.name);
    void control.register().catch(() => undefined);
  };
  await server.connect(new StdioServerTransport());
}

/**
 * A browser tool's handler. A notice the server holds, then one saying a new session replaced one that ended, go
 * ahead of the daemon's reply; the reconnect happens inside the call, so the second is read after it, whether the
 * call worked or not.
 */
export function browserToolHandler(
  control: Pick<DaemonSession, 'callTool' | 'takeReconnected'>,
  takeNotice: () => ToolContent[],
): (method: ToolMethod) => (params: Record<string, unknown>) => Promise<{ content: ToolContent[]; isError?: true }> {
  return (method) => async (params) => {
    const before = takeNotice();
    const restarted = (): ToolContent[] =>
      control.takeReconnected() ? [{ type: 'text', text: SESSION_RESTARTED_NOTICE }] : [];
    try {
      const content = await control.callTool(method, params);
      return { content: [...restarted(), ...before, ...content] };
    } catch (error) {
      const failed = failure(error);
      return { ...failed, content: [...restarted(), ...before, ...failed.content] };
    }
  };
}

function failure(error: unknown): { content: ToolContent[]; isError: true } {
  return {
    content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
    isError: true,
  };
}

export function formatLink(link: ReturnType<DaemonSession['link']>): string {
  if (link === 'connected') return 'This MCP server\'s session: connected.';
  if (link === 'ended') {
    return "This MCP server's session: ended (the background program restarted or the connection dropped). The next browser tool call starts a new session without the old tabs.";
  }
  return "This MCP server's session: not started yet; the first browser tool call starts it.";
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
