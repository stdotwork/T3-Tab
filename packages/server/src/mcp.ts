import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { ToolContent, ToolMethod } from '@t3-tab/protocol';
import type { ZodRawShape } from 'zod';

import { claimFileNotice, takeClaimFile } from './agents/claim-file.js';
import { DaemonSession } from './client.js';
import { ThreadPrompts } from './prompt-elicitation.js';
import { actShape, listedSchema, READ_UNLISTED, readShape, runJsShape, screenshotShape, tabsShape } from './tool-schemas.js';

/**
 * The tools as the agent reads them. `read`'s description says once what `tab` defaults to for every tool. Wording a
 * model was seen to react to (`tabs`' "the page", `read`'s first sentence and `full`, `act`'s description) is kept as
 * measured; change it only with an agent benchmark.
 */
const TOOLS: Array<{ name: ToolMethod; description: string; shape: ZodRawShape; unlisted?: readonly string[] }> = [
  {
    name: 'tabs',
    description: 'List, open, switch to or close tabs. Loads (open, goto, back, forward, reload) reply with the page.',
    shape: tabsShape,
  },
  {
    name: 'read',
    description:
      "Read a page as text: interactive elements with refs (e12), headings, and the page's text up to a budget. Later reads return only changes. tab defaults to the current tab in every tool.",
    shape: readShape,
    unlisted: READ_UNLISTED,
  },
  { name: 'screenshot', description: "JPEG of a tab's viewport, downscaled.", shape: screenshotShape },
  { name: 'act', description: 'Run ordered page steps; returns the page diff.', shape: actShape },
  { name: 'run_js', description: 'Evaluate JavaScript in the page. Escape hatch; prefer act.', shape: runJsShape },
];

/**
 * What `tools/list` answers: each tool's name, description and listed schema (`listedSchema`). The SDK's own list
 * would add the JSON Schema dialect and every checked keyword to each tool, and `execution: { taskSupport:
 * 'forbidden' }`, which is what an absent value means.
 */
export function listedTools(): Array<{ name: string; description: string; inputSchema: ReturnType<typeof listedSchema> }> {
  return TOOLS.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: listedSchema(tool.shape, tool.unlisted) }));
}

/** Said once, in the first reply after a new session replaced one that ended. */
export const SESSION_RESTARTED_NOTICE =
  'T3-Tab: your earlier browser session ended (the background program restarted or the connection dropped). This is a new session: its tabs and approvals are gone, so open tabs again or ask the owner to share one.';

export async function runMcpServer(options: { claimFile?: string } = {}): Promise<void> {
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

  await createMcpServer(control, takeNotice).connect(new StdioServerTransport());
}

/** The MCP server for one session: its tools, its tool list, and its permission prompts put to the agent's thread. */
export function createMcpServer(
  control: Pick<DaemonSession, 'callTool' | 'takeReconnected' | 'answerPrompt' | 'onEvent' | 'setClientName' | 'register'>,
  takeNotice: () => ToolContent[],
): McpServer {
  const server = new McpServer({ name: 't3-tab', version: '0.1.0' });
  const browserTool = browserToolHandler(control, takeNotice);
  // The SDK checks each call against the whole shape, `read`'s unlisted parameters included; the list is lean.
  for (const tool of TOOLS) server.registerTool(tool.name, { description: tool.description, inputSchema: tool.shape }, browserTool(tool.name));
  const listed = listedTools();
  server.server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: listed }));
  // A permission prompt for this session is also put to the agent's own thread (see `prompt-elicitation.ts`).
  const threadPrompts = new ThreadPrompts(server.server, async (promptId, decision) => await control.answerPrompt(promptId, decision));
  control.onEvent((event) => threadPrompts.handle(event));
  server.server.oninitialized = () => {
    control.setClientName(server.server.getClientVersion()?.name);
    void control.register().catch(() => undefined);
  };
  return server;
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
