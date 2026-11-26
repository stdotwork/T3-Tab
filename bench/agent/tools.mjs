// The browser tools an agent can be given, one at a time. Each entry starts what the tool needs (a browser, and for
// T3-Tab its extension and daemon) and returns the MCP server entry that Claude Code is told to start. The servers
// are started the way bench/compare starts them. Every browser has a debugging port so the harness can read the
// page itself after the run, whatever the tool says.
import { spawn } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { connectMcp, createHome, installNativeHost, launchUndrivenBrowser, requireBuild, sleep, stopDaemon, waitForBrowser } from '../../e2e/harness.mjs';
import { chromium } from 'playwright';

import { pageStates } from '../compare/lib.mjs';

const root = new URL('../../', import.meta.url).pathname;
const bin = (name) => join(root, 'node_modules', '.bin', name);

/** Environment variables that must not reach a run's processes: the caller's agent and T3 sessions. */
const dropped = (key) => /^(CLAUDE|CODEX|T3CODE_|T3_TAB_|OMARCHY_AGENT|AI_AGENT)/.test(key) || key === 'CLAUDECODE';

/**
 * Headless Chromium with a debugging port, like bench/compare's, plus `--disable-extensions`: this machine registers
 * Claude in Chrome system-wide (/usr/share/chromium/extensions), so a browser with a new profile installs it from the
 * web store and, a few seconds in, opens a claude.ai sign-in tab that a tool would list and a model would trip over.
 */
async function plainBrowser({ dir, env }) {
  const profileDir = join(dir, 'profile');
  const child = spawn(
    chromium.executablePath(),
    ['--headless=new', '--no-sandbox', '--no-first-run', '--no-default-browser-check', '--disable-extensions', `--user-data-dir=${profileDir}`, '--remote-debugging-port=0', '--window-size=1600,1000', 'about:blank'],
    // A short TMPDIR: a long one makes Chromium abort on its socket path.
    { env: { ...process.env, ...env, TMPDIR: '/tmp' }, stdio: 'ignore' },
  );
  const close = async () => {
    if (child.exitCode !== null) return;
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill('SIGTERM');
    await Promise.race([exited, sleep(3_000)]);
    if (child.exitCode === null) child.kill('SIGKILL');
  };
  try {
    for (let attempt = 0; attempt < 150; attempt += 1) {
      const port = await readFile(join(profileDir, 'DevToolsActivePort'), 'utf8').then((content) => content.split('\n')[0], () => undefined);
      if (port !== undefined) return { port: Number(port), close };
      await sleep(100);
    }
    throw new Error('Chromium did not report a debugging port');
  } catch (error) {
    await close();
    throw error;
  }
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
    id: 't3tab',
    label: 'T3-Tab',
    server: 't3-tab',
    notes: 'Built extension in headless Chromium that only the extension debugs, real daemon, the task site set to allow (no prompt waits).',
    async start({ site, env }) {
      const home = await createHome();
      home.childEnv.T3TAB_AGENT_RUN = env.T3TAB_AGENT_RUN;
      await requireBuild(home);
      await installNativeHost(home);
      const browser = await launchUndrivenBrowser(home, 'about:blank');
      try {
        // Ready when the daemon reports a browser with a tab; this client only looks and is closed again.
        const watcher = await connectMcp(home, 't3-tab-agent-bench-watch');
        await waitForBrowser(watcher.client);
        await watcher.client.close().catch(() => undefined);
        await browser.panel({ type: 'panel.setSite', origin: site, setting: 'allow' });
        const port = Number((await readFile(join(home.profileDir, 'DevToolsActivePort'), 'utf8')).split('\n')[0]);
        const childEnv = Object.fromEntries(Object.entries(home.childEnv).filter(([key]) => !dropped(key) && !key.startsWith('ANTHROPIC_')));
        return {
          mcp: { command: process.execPath, args: [home.cliPath, 'mcp'], env: childEnv },
          states: () => pageStates(port, site),
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
