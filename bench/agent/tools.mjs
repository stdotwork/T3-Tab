// The browser tools an agent can be given, one at a time. Each entry starts what the tool needs (a browser, and for
// T3-Tab its extension and daemon) and returns the MCP server entry that Claude Code is told to start. The servers
// are started the way bench/compare starts them. Every browser has a debugging port so the harness can read the
// page itself after the run, whatever the tool says.
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { connectMcp, createHome, installNativeHost, launchUndrivenBrowser, requireBuild, sleep, stopDaemon, waitForBrowser } from '../../e2e/harness.mjs';
import { evaluateOver, launchChromium, pageStates } from '../compare/lib.mjs';

const root = new URL('../../', import.meta.url).pathname;
const bin = (name) => join(root, 'node_modules', '.bin', name);

/** Environment variables that must not reach a run's processes: the caller's agent and T3 sessions. */
const dropped = (key) => /^(CLAUDE|CODEX|T3CODE_|T3_TAB_|OMARCHY_AGENT|AI_AGENT)/.test(key) || key === 'CLAUDECODE';

/**
 * The headless Chromium of bench/compare: a debugging port and `--disable-extensions`. This machine registers Claude in
 * Chrome system-wide (/usr/share/chromium/extensions), so a browser with a new profile would install it and, a few
 * seconds in, open a claude.ai sign-in tab that a tool would list and a model would trip over.
 */
// A short TMPDIR: a long one makes Chromium abort on its socket path.
const plainBrowser = ({ dir, env }) => launchChromium({ profileDir: join(dir, 'profile'), env: { ...process.env, ...env, TMPDIR: '/tmp' } });

/**
 * What a real-site check reads: `expression`, run in every page whose address is on one of `origins`, over a short-lived
 * debugging connection each, whatever the tool says. A page that does not answer is left out.
 */
export async function probePages(port, origins, expression) {
  const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());
  const values = [];
  for (const target of targets) {
    if (target.type !== 'page' || !origins.some((origin) => target.url.startsWith(`${origin}/`))) continue;
    values.push(await evaluateOver(target.webSocketDebuggerUrl, expression).catch(() => undefined));
  }
  return values.filter((value) => value !== undefined && value !== null);
}

function cdpTool({ id, label, server, command, args, extraEnv, hint, notes }) {
  return {
    id,
    label,
    server,
    notes,
    async start({ dir, env, site, run }) {
      const browser = await plainBrowser({ dir, env });
      const port = browser.port;
      const url = `http://127.0.0.1:${port}`;
      return {
        mcp: { command: bin(command), args: args({ url, port }), env: { ...env, ...extraEnv?.({ dir, run, port }) } },
        hint: hint?.({ port }),
        states: () => pageStates(port, site),
        probe: (origins, expression) => probePages(port, origins, expression),
        stop: () => browser.close(),
      };
    },
  };
}

const chromeDevtools = (id, label, slim, notes) =>
  cdpTool({
    id,
    label,
    server: 'chrome-devtools',
    command: 'chrome-devtools-mcp',
    args: ({ url }) => [...(slim ? ['--slim'] : []), '--browserUrl', url, '--no-usage-statistics', '--no-performance-crux'],
    extraEnv: () => ({ CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: '1' }),
    notes,
  });

export const TOOLS = [
  {
    // The no-tool baseline: Claude Code with no browser server at all, run on every task with the same prompt. What a run
    // of any tool spends beyond this (system prompt, task, answer) is what the tool is responsible for.
    id: 'none',
    label: 'No tools (baseline)',
    server: undefined,
    baseline: true,
    notes: 'Claude Code with no MCP server and no tools; the same prompt. It cannot do the task, so its success is not counted.',
    async start() {
      return { mcp: undefined, states: async () => [], probe: async () => [], stop: async () => undefined };
    },
  },
  {
    id: 't3tab',
    label: 'T3-Tab',
    server: 't3-tab',
    notes: 'Built extension in headless Chromium that only the extension debugs, real daemon, the task site set to allow (no prompt waits).',
    async start({ site, env, origins = [site] }) {
      const home = await createHome();
      home.childEnv.T3TAB_AGENT_RUN = env.T3TAB_AGENT_RUN;
      await requireBuild(home);
      await installNativeHost(home);
      const browser = await launchUndrivenBrowser(home, 'about:blank', [], { httpsUpgrades: false });
      try {
        // Ready when the daemon reports a browser with a tab; this client only looks and is closed again.
        const watcher = await connectMcp(home, 't3-tab-agent-bench-watch');
        await waitForBrowser(watcher.client);
        await watcher.client.close().catch(() => undefined);
        // `allow` for every origin the task may touch, so no permission prompt waits (the same for the local site and the real ones).
        for (const origin of origins) await browser.panel({ type: 'panel.setSite', origin, setting: 'allow' });
        const port = Number((await readFile(join(home.profileDir, 'DevToolsActivePort'), 'utf8')).split('\n')[0]);
        const childEnv = Object.fromEntries(Object.entries(home.childEnv).filter(([key]) => !dropped(key) && !key.startsWith('ANTHROPIC_')));
        return {
          mcp: { command: process.execPath, args: [home.cliPath, 'mcp'], env: childEnv },
          states: () => pageStates(port, site),
          probe: (origins, expression) => probePages(port, origins, expression),
          async stop() {
            await browser.close().catch(() => undefined);
            await stopDaemon(home.statePath);
            await rm(home.tempHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => undefined);
          },
        };
      } catch (error) {
        await browser.close().catch(() => undefined);
        await stopDaemon(home.statePath);
        throw error;
      }
    },
  },
  chromeDevtools('dt-slim', 'chrome-devtools-mcp --slim', true, 'Three tools (navigate, evaluate, screenshot): the agent writes JavaScript to read and act. Attached with --browserUrl.'),
  chromeDevtools('dt', 'chrome-devtools-mcp', false, 'Default tool set. Attached with --browserUrl.'),
  cdpTool({
    id: 'pw',
    label: 'Playwright MCP',
    server: 'playwright',
    command: 'playwright-mcp',
    args: ({ url }) => ['--cdp-endpoint', url],
    notes: 'Default capabilities and snapshot mode, attached with --cdp-endpoint.',
  }),
  cdpTool({
    id: 'ab',
    label: 'agent-browser',
    server: 'agent-browser',
    command: 'agent-browser',
    args: () => ['mcp'],
    extraEnv: ({ dir, run, port }) => ({
      AGENT_BROWSER_CDP: `http://127.0.0.1:${port}`,
      AGENT_BROWSER_SESSION: `agent-bench-${run}`,
      AGENT_BROWSER_SCREENSHOT_DIR: join(dir, 'shots'),
    }),
    notes: 'agent-browser mcp, default core profile, attached with AGENT_BROWSER_CDP.',
  }),
  cdpTool({
    id: 'pwr',
    label: 'Playwriter',
    server: 'playwriter',
    command: 'playwriter',
    args: () => [],
    extraEnv: ({ run }) => ({ PLAYWRITER_PORT: String(19_000 + (run % 900)), PLAYWRITER_TELEMETRY: '0', DO_NOT_TRACK: '1' }),
    // Its extension path needs a click on each tab, which cannot run headless. Without it the tool has to be told
    // where the browser is, through session_new's `direct` option; its first call is the model's, and is counted.
    hint: ({ port }) => `The browser is already running with remote debugging. Connect to it by calling the session_new tool with {"direct": "127.0.0.1:${port}"}.`,
    notes: 'One execute tool that runs Playwright code, over its own relay. The prompt says where the browser is (a headless run has no extension click).',
  }),
];

export const TOOL_IDS = TOOLS.map((tool) => tool.id);
export { sleep };
