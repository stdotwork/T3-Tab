// One adapter per tool: how to start its MCP server, and the scripted calls it takes for each task.
// A script is what a capable agent would send: the tool's own look-then-act habit, refs taken from its own
// replies, nothing the tool does not offer. bench/compare/README.md lists the same sequences in words.
//
// Every task starts with the tool opening the page itself, so opening is part of every task's cost.
// `t.call(tool, args)` sends a call, records it and returns the reply's text; `t.site` is the page server.
import { execFile } from 'node:child_process';
import { access, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import {
  assert,
  connectMcp,
  createHome,
  extensionWorker,
  installNativeHost,
  launchBrowser,
  refFor,
  requireBuild,
  setSite,
  stopDaemon,
  text,
  waitForBrowser,
} from '../../e2e/harness.mjs';
import { STATE_EXPRESSION, connectServer, grab, kill, listenerOf, pidsMatching } from './lib.mjs';

const execFileAsync = promisify(execFile);

const root = new URL('../../', import.meta.url).pathname;
const bin = (name) => join(root, 'node_modules', '.bin', name);

/** The sentence the search task looks for: it must be in what the agent was sent. */
export const SEARCH_ANSWER = 'sixty requests per minute';

// Page text only: the agent has not seen the page's markup, so no selector is assumed.
const SEARCH_JS =
  "document.body.innerText.split('\\n').filter((line) => /rate limit/i.test(line)).join('\\n')";

/** The first line of `text` that holds `label`, and `pattern`'s group 1 on that line. */
function refOn(replyText, label, pattern) {
  const line = replyText.split('\n').find((candidate) => candidate.includes(label));
  assert(line !== undefined, `No line with ${label} in:\n${replyText.slice(0, 1500)}`);
  return grab(line, pattern, `${label} reference`);
}

// -------------------------------------------------------------------------------------------------- T3-Tab

const t3tab = {
  id: 't3tab',
  label: 'T3-Tab',
  package: '@t3-tab/server',
  versionOf: async () => JSON.parse(await readFile(join(root, 'packages/server/package.json'), 'utf8')).version,
  notes: 'Built extension in headless Chromium, real daemon, site set to allow (the same setup as `pnpm bench`).',
  async start({ site }) {
    const home = await createHome();
    await requireBuild(home);
    await installNativeHost(home);
    const browserContext = await launchBrowser(home);
    const { serviceWorker } = await extensionWorker(browserContext);
    const { client } = await connectMcp(home, 't3-tab-compare');
    await waitForBrowser(home);
    await setSite(serviceWorker, site, 'allow');
    return {
      client,
      // Playwright holds this browser, so its pages answer directly.
      states: async () => {
        const states = [];
        for (const page of browserContext.pages()) {
          if (page.url().startsWith(site)) states.push(await page.evaluate(STATE_EXPRESSION).catch(() => undefined));
        }
        return states.filter((state) => state !== undefined);
      },
      async stop() {
        await client.close().catch(() => undefined);
        await browserContext.close().catch(() => undefined);
        await stopDaemon(home.statePath);
        await rm(home.tempHome, { recursive: true, force: true });
      },
    };
  },
  tasks: {
    async form(t) {
      await t.call('tabs', { action: 'open', url: `${t.site}/form` });
      const page = await t.call('read', {});
      await t.call('act', {
        steps: [
          { action: 'fill', ref: refFor(page, 'textbox "Name"'), text: 'Ada Lovelace' },
          { action: 'fill', ref: refFor(page, 'textbox "Email"'), text: 'ada@example.com' },
          { action: 'select', ref: refFor(page, 'combobox "Country"'), text: 'Brazil' },
          { action: 'click', ref: refFor(page, 'button "Create account"') },
        ],
      });
    },
    async hidden(t) {
      await t.call('tabs', { action: 'open', url: `${t.site}/form` });
      const page = await t.call('read', {});
      await t.call('act', { steps: [{ action: 'click', ref: refFor(page, 'button "Show details"') }] });
    },
    async navigate(t) {
      await t.call('tabs', { action: 'open', url: `${t.site}/products` });
      const page = await t.call('read', {});
      await t.call('act', { steps: [{ action: 'click', ref: refFor(page, 'link "Day pack"') }] });
    },
    async long(t) {
      await t.call('tabs', { action: 'open', url: `${t.site}/docs` });
      await t.call('read', { find: 'rate limit' });
    },
    async 'long-full'(t) {
      await t.call('tabs', { action: 'open', url: `${t.site}/docs` });
      await t.call('read', { all: true });
    },
    async 'long-js'(t) {
      await t.call('tabs', { action: 'open', url: `${t.site}/docs` });
      await t.call('run_js', { expression: SEARCH_JS });
    },
    async screenshot(t) {
      await t.call('tabs', { action: 'open', url: `${t.site}/docs` });
      await t.call('screenshot', {});
    },
  },
};

// ---------------------------------------------------------------------------------------- Playwright MCP

function playwrightMcp(id, label, extraArgs, notes) {
  return {
    id,
    label,
    package: '@playwright/mcp',
    notes,
    async start({ port, dir, env }) {
      const { client } = await connectServer({
        command: bin('playwright-mcp'),
        args: ['--cdp-endpoint', `http://127.0.0.1:${port}`, ...extraArgs],
        env,
        cwd: dir,
      });
      return { client, stop: () => client.close().catch(() => undefined) };
    },
    tasks: {
      async form(t) {
        await t.call('browser_navigate', { url: `${t.site}/form` });
        const page = await t.call('browser_snapshot', {});
        const ref = (label) => refOn(page, label, /\[ref=(\w+)\]/);
        await t.call('browser_fill_form', {
          fields: [
            { name: 'Name', type: 'textbox', target: ref('textbox "Name"'), value: 'Ada Lovelace' },
            { name: 'Email', type: 'textbox', target: ref('textbox "Email"'), value: 'ada@example.com' },
            { name: 'Country', type: 'combobox', target: ref('combobox "Country"'), value: 'Brazil' },
          ],
        });
        await t.call('browser_click', { target: ref('button "Create account"') });
        await t.call('browser_snapshot', {});
      },
      async hidden(t) {
        await t.call('browser_navigate', { url: `${t.site}/form` });
        const page = await t.call('browser_snapshot', {});
        await t.call('browser_click', { target: refOn(page, 'button "Show details"', /\[ref=(\w+)\]/) });
        await t.call('browser_snapshot', {});
      },
      async navigate(t) {
        await t.call('browser_navigate', { url: `${t.site}/products` });
        const page = await t.call('browser_snapshot', {});
        await t.call('browser_click', { target: refOn(page, 'link "Day pack"', /\[ref=(\w+)\]/) });
        await t.call('browser_snapshot', {});
      },
      async long(t) {
        await t.call('browser_navigate', { url: `${t.site}/docs` });
        await t.call('browser_find', { text: 'rate limit' });
      },
      async 'long-full'(t) {
        await t.call('browser_navigate', { url: `${t.site}/docs` });
        await t.call('browser_snapshot', {});
      },
      async 'long-js'(t) {
        await t.call('browser_navigate', { url: `${t.site}/docs` });
        await t.call('browser_evaluate', { function: `() => ${SEARCH_JS}` });
      },
      async screenshot(t) {
        await t.call('browser_navigate', { url: `${t.site}/docs` });
        await t.call('browser_take_screenshot', {});
      },
    },
  };
}

const pw = playwrightMcp('pw', 'Playwright MCP', [], 'Attached over CDP to the shared Chromium. Default capabilities and snapshot mode.');
const pwNone = playwrightMcp(
  'pw-none',
  'Playwright MCP --snapshot-mode none',
  ['--snapshot-mode', 'none'],
  'Same scripts as the default; actions return no page section, and `browser_snapshot` is still the explicit read.',
);

// ---------------------------------------------------------------------------------------- chrome-devtools

function chromeDevtools(id, label, extraArgs, tasks, notes) {
  return {
    id,
    label,
    package: 'chrome-devtools-mcp',
    notes,
    async start({ port, dir, env }) {
      const { client } = await connectServer({
        command: bin('chrome-devtools-mcp'),
        args: [...extraArgs, '--browserUrl', `http://127.0.0.1:${port}`, '--no-usage-statistics', '--no-performance-crux'],
        env: { ...env, CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: '1' },
        cwd: dir,
      });
      return { client, stop: () => client.close().catch(() => undefined) };
    },
    tasks,
  };
}

/** `new_page` replies with the page list; the new page is the selected one. */
async function openPage(t, path) {
  const reply = await t.call('new_page', { url: `${t.site}${path}` });
  return Number(grab(reply, /^(\d+): .*\[selected\]/m, 'the new page id'));
}

const devtoolsTasks = {
  async form(t) {
    const pageId = await openPage(t, '/form');
    const page = await t.call('take_snapshot', { pageId });
    const uid = (label) => grab(page, new RegExp(`uid=(\\S+) ${label}`), label);
    await t.call('fill_form', {
      pageId,
      elements: [
        { uid: uid('textbox "Name"'), value: 'Ada Lovelace' },
        { uid: uid('textbox "Email"'), value: 'ada@example.com' },
        { uid: uid('combobox "Country"'), value: 'Brazil' },
      ],
    });
    await t.call('click', { pageId, uid: uid('button "Create account"') });
    await t.call('take_snapshot', { pageId });
  },
  async hidden(t) {
    const pageId = await openPage(t, '/form');
    const page = await t.call('take_snapshot', { pageId });
    await t.call('click', { pageId, uid: grab(page, /uid=(\S+) button "Show details"/, 'Show details') });
    await t.call('take_snapshot', { pageId });
  },
  async navigate(t) {
    const pageId = await openPage(t, '/products');
    const page = await t.call('take_snapshot', { pageId });
    await t.call('click', { pageId, uid: grab(page, /uid=(\S+) link "Day pack"/, 'Day pack') });
    await t.call('take_snapshot', { pageId });
  },
  // No search tool: the page is read whole.
  async long(t) {
    const pageId = await openPage(t, '/docs');
    await t.call('take_snapshot', { pageId });
  },
  async 'long-full'(t) {
    const pageId = await openPage(t, '/docs');
    await t.call('take_snapshot', { pageId });
  },
  async 'long-js'(t) {
    const pageId = await openPage(t, '/docs');
    await t.call('evaluate_script', { pageId, function: `() => ${SEARCH_JS}` });
  },
  async screenshot(t) {
    const pageId = await openPage(t, '/docs');
    await t.call('take_screenshot', { pageId });
  },
};

const dt = chromeDevtools(
  'dt',
  'chrome-devtools-mcp',
  [],
  devtoolsTasks,
  'Attached over CDP (`--browserUrl`). Default tools. It has no search tool, so `long` reads the whole snapshot.',
);

// The three slim tools: navigate, evaluate, screenshot. Reading and acting are JavaScript the agent writes.
const dtSlim = chromeDevtools(
  'dt-slim',
  'chrome-devtools-mcp --slim',
  ['--slim'],
  {
    async form(t) {
      await t.call('navigate', { url: `${t.site}/form` });
      await t.call('evaluate', {
        script: "[...document.querySelectorAll('input,select,textarea,button')].map((e) => `${e.tagName.toLowerCase()} ${e.name || e.textContent.trim()}`).join('\\n')",
      });
      await t.call('evaluate', {
        script: `(() => { const f = document.forms[0]; f.elements.namedItem('name').value = 'Ada Lovelace'; f.elements.namedItem('email').value = 'ada@example.com'; f.elements.namedItem('country').value = 'Brazil'; [...f.querySelectorAll('button')].find((b) => b.textContent.includes('Create account')).click(); return document.body.innerText.slice(-120); })()`,
      });
    },
    async hidden(t) {
      await t.call('navigate', { url: `${t.site}/form` });
      await t.call('evaluate', { script: 'document.body.innerText' });
      await t.call('evaluate', {
        script: "(() => { [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Show details').click(); return document.body.innerText.slice(-120); })()",
      });
    },
    async navigate(t) {
      await t.call('navigate', { url: `${t.site}/products` });
      const links = await t.call('evaluate', {
        script: "[...document.links].map((a) => `${a.textContent.trim()} ${a.getAttribute('href')}`).join('\\n')",
      });
      await t.call('navigate', { url: `${t.site}${grab(links, /Day pack (\/products\/\d+)/, 'the Day pack link')}` });
      await t.call('evaluate', { script: 'document.body.innerText' });
    },
    async long(t) {
      await t.call('navigate', { url: `${t.site}/docs` });
      await t.call('evaluate', { script: SEARCH_JS });
    },
    async 'long-full'(t) {
      await t.call('navigate', { url: `${t.site}/docs` });
      await t.call('evaluate', { script: 'document.body.innerText' });
    },
    async 'long-js'(t) {
      await t.call('navigate', { url: `${t.site}/docs` });
      await t.call('evaluate', { script: SEARCH_JS });
    },
    async screenshot(t) {
      await t.call('navigate', { url: `${t.site}/docs` });
      await t.call('screenshot', {});
    },
  },
  'Three tools only, so the agent writes JavaScript to read and act; `long` and `long-js` are the same one-liner.',
);

// ---------------------------------------------------------------------------------------- agent-browser

const agentBrowser = {
  id: 'ab',
  label: 'agent-browser',
  package: 'agent-browser',
  notes: '`agent-browser mcp`, default `core` tool profile, attached over CDP (`AGENT_BROWSER_CDP`). Interactive-only snapshots by default; `read` returns the page text.',
  async start({ port, dir, env }) {
    const before = new Set(await pidsMatching('agent-browser-linux-x64'));
    const { client } = await connectServer({
      command: bin('agent-browser'),
      args: ['mcp'],
      env: {
        ...env,
        AGENT_BROWSER_CDP: `http://127.0.0.1:${port}`,
        AGENT_BROWSER_SESSION: `compare-${process.pid}`,
        AGENT_BROWSER_SCREENSHOT_DIR: join(dir, 'shots'),
      },
      cwd: dir,
    });
    return {
      client,
      async stop() {
        await client.callTool({ name: 'agent_browser_close', arguments: {} }).catch(() => undefined);
        await client.close().catch(() => undefined);
        for (const pid of await pidsMatching('agent-browser-linux-x64')) if (!before.has(pid)) kill(pid);
      },
    };
  },
  tasks: {
    async form(t) {
      await t.call('agent_browser_open', { url: `${t.site}/form` });
      const page = await t.call('agent_browser_snapshot', {});
      const ref = (label) => `@${refOn(page, label, /ref=(\w+)/)}`;
      await t.call('agent_browser_fill', { selector: ref('textbox "Name"'), text: 'Ada Lovelace' });
      await t.call('agent_browser_fill', { selector: ref('textbox "Email"'), text: 'ada@example.com' });
      await t.call('agent_browser_select', { selector: ref('combobox "Country"'), values: ['Brazil'] });
      await t.call('agent_browser_click', { selector: ref('button "Create account"') });
      await t.call('agent_browser_read', {});
    },
    async hidden(t) {
      await t.call('agent_browser_open', { url: `${t.site}/form` });
      const page = await t.call('agent_browser_snapshot', {});
      await t.call('agent_browser_click', { selector: `@${refOn(page, 'button "Show details"', /ref=(\w+)/)}` });
      await t.call('agent_browser_read', {});
    },
    async navigate(t) {
      await t.call('agent_browser_open', { url: `${t.site}/products` });
      const page = await t.call('agent_browser_snapshot', {});
      await t.call('agent_browser_click', { selector: `@${refOn(page, 'link "Day pack"', /ref=(\w+)/)}` });
      await t.call('agent_browser_read', {});
    },
    async long(t) {
      await t.call('agent_browser_open', { url: `${t.site}/docs` });
      await t.call('agent_browser_read', { filter: 'rate limit' });
    },
    async 'long-full'(t) {
      await t.call('agent_browser_open', { url: `${t.site}/docs` });
      await t.call('agent_browser_read', {});
    },
    async 'long-js'(t) {
      await t.call('agent_browser_open', { url: `${t.site}/docs` });
      await t.call('agent_browser_eval', { script: SEARCH_JS });
    },
    async screenshot(t) {
      await t.call('agent_browser_open', { url: `${t.site}/docs` });
      await t.call('agent_browser_screenshot', { format: 'jpeg' });
    },
  },
};

// ------------------------------------------------------------------------------------------- dev-browser

const run = (script) => ({ script: `const p = await browser.getPage("main");\n${script}` });

const devBrowser = {
  id: 'db',
  label: 'dev-browser',
  package: 'dev-browser',
  notes: '`dev-browser mcp --connect`: five tools, scripts run in its Puppeteer runtime. Named page `main`, snapshots tracked so a re-read is an increment.',
  async start({ port, dir, env }) {
    // The launcher downloads its 96 MB native binary on the first run of any command (pnpm blocks the install script).
    const binary = join(root, 'node_modules', 'dev-browser', 'bin', 'dev-browser-bin');
    if (await access(binary).then(() => false, () => true)) {
      console.error('dev-browser: fetching its native binary from GitHub (first run only)...');
      await execFileAsync(bin('dev-browser'), ['--version'], { timeout: 30 * 60_000, env: { ...process.env, ...env } });
    }
    const { client } = await connectServer({
      command: bin('dev-browser'),
      args: ['mcp', '--connect', `http://127.0.0.1:${port}`],
      env,
      cwd: dir,
    });
    return {
      client,
      async stop() {
        await client.callTool({ name: 'dev_browser_stop', arguments: {} }).catch(() => undefined);
        await client.close().catch(() => undefined);
      },
    };
  },
  tasks: {
    async form(t) {
      const page = await t.call(
        'dev_browser_run',
        run(`await p.goto(${JSON.stringify(`${t.site}/form`)});\n(await p.snapshot({ track: "m" })).full`),
      );
      const ref = (label) => `ref/${refOn(page, label, /\[ref=(\w+)\]/)}`;
      await t.call(
        'dev_browser_run',
        run(`await p.fill("${ref('textbox "Name"')}", "Ada Lovelace");
await p.fill("${ref('textbox "Email"')}", "ada@example.com");
await p.select("${ref('combobox "Country"')}", "Brazil");
await p.click("${ref('button "Create account"')}");
(await p.snapshot({ track: "m" })).incremental`),
      );
    },
    async hidden(t) {
      const page = await t.call(
        'dev_browser_run',
        run(`await p.goto(${JSON.stringify(`${t.site}/form`)});\n(await p.snapshot({ track: "m" })).full`),
      );
      await t.call(
        'dev_browser_run',
        run(`await p.click("ref/${refOn(page, 'button "Show details"', /\[ref=(\w+)\]/)}");\n(await p.snapshot({ track: "m" })).incremental`),
      );
    },
    async navigate(t) {
      const page = await t.call(
        'dev_browser_run',
        run(`await p.goto(${JSON.stringify(`${t.site}/products`)});\n(await p.snapshot({ track: "m" })).full`),
      );
      await t.call(
        'dev_browser_run',
        run(`await p.click("ref/${refOn(page, 'link "Day pack"', /\[ref=(\w+)\]/)}");\nawait p.waitForLoad();\nawait p.snapshot()`),
      );
    },
    async long(t) {
      await t.call(
        'dev_browser_run',
        run(`await p.goto(${JSON.stringify(`${t.site}/docs`)});\nawait p.snapshot()`),
      );
    },
    async 'long-full'(t) {
      await t.call(
        'dev_browser_run',
        run(`await p.goto(${JSON.stringify(`${t.site}/docs`)});\nawait p.snapshot()`),
      );
    },
    async 'long-js'(t) {
      await t.call(
        'dev_browser_run',
        run(`await p.goto(${JSON.stringify(`${t.site}/docs`)});\nawait p.evaluate(() => ${SEARCH_JS})`),
      );
    },
    async screenshot(t) {
      await t.call(
        'dev_browser_run',
        run(`await p.goto(${JSON.stringify(`${t.site}/docs`)});\nawait p.shot()`),
      );
    },
  },
};

// ---------------------------------------------------------------------------------------------- Playwriter

const PW_PORT = 19_000 + (process.pid % 900);

const playwriter = {
  id: 'pwr',
  label: 'Playwriter',
  package: 'playwriter',
  notes:
    'Its own CDP relay; `session_new` with `direct` attaches to the shared Chromium (the extension path needs a click on each tab, so it cannot run headless). One `execute` tool that runs Playwright code. `session_new` is setup and not counted.',
  async start({ port, dir, env }) {
    const { client } = await connectServer({
      command: bin('playwriter'),
      args: [],
      env: { ...env, PLAYWRITER_PORT: String(PW_PORT), PLAYWRITER_TELEMETRY: '0', DO_NOT_TRACK: '1' },
      cwd: dir,
    });
    const created = await client.callTool({ name: 'session_new', arguments: { direct: `127.0.0.1:${port}` } });
    assert(created.isError !== true, `session_new failed: ${text(created)}`);
    return {
      client,
      async stop() {
        await client.close().catch(() => undefined);
        const relay = await listenerOf(PW_PORT);
        if (relay !== undefined) kill(relay);
      },
    };
  },
  tasks: {
    async form(t) {
      await t.call('execute', {
        code: `state.page = await context.newPage(); await state.page.goto(${JSON.stringify(`${t.site}/form`)}); console.log(await snapshot({ page: state.page }))`,
      });
      await t.call('execute', {
        code: `const p = state.page; await p.locator('role=textbox[name="Name"i]').fill('Ada Lovelace'); await p.locator('role=textbox[name="Email"i]').fill('ada@example.com'); await p.locator('role=combobox[name="Country"i]').selectOption('Brazil'); await p.locator('role=button[name="Create account"i]').click(); console.log(await snapshot({ page: p, showDiffSinceLastCall: true }))`,
      });
    },
    async hidden(t) {
      await t.call('execute', {
        code: `state.page = await context.newPage(); await state.page.goto(${JSON.stringify(`${t.site}/form`)}); console.log(await snapshot({ page: state.page }))`,
      });
      await t.call('execute', {
        code: `await state.page.locator('#toggle').click(); console.log(await snapshot({ page: state.page, showDiffSinceLastCall: true }))`,
      });
    },
    async navigate(t) {
      await t.call('execute', {
        code: `state.page = await context.newPage(); await state.page.goto(${JSON.stringify(`${t.site}/products`)}); console.log(await snapshot({ page: state.page }))`,
      });
      await t.call('execute', {
        code: `await state.page.locator('role=link[name="Day pack"i]').click(); await waitForPageLoad({ page: state.page }); console.log(await snapshot({ page: state.page }))`,
      });
    },
    async long(t) {
      await t.call('execute', {
        code: `state.page = await context.newPage(); await state.page.goto(${JSON.stringify(`${t.site}/docs`)}); console.log(await snapshot({ page: state.page, search: /rate limit/i }))`,
      });
    },
    async 'long-full'(t) {
      await t.call('execute', {
        code: `state.page = await context.newPage(); await state.page.goto(${JSON.stringify(`${t.site}/docs`)}); console.log(await snapshot({ page: state.page }))`,
      });
    },
    async 'long-js'(t) {
      await t.call('execute', {
        code: `state.page = await context.newPage(); await state.page.goto(${JSON.stringify(`${t.site}/docs`)}); console.log(await state.page.evaluate(() => ${SEARCH_JS}))`,
      });
    },
    async screenshot(t) {
      await t.call('execute', {
        code: `state.page = await context.newPage(); await state.page.goto(${JSON.stringify(`${t.site}/docs`)}); await screenshotWithAccessibilityLabels({ page: state.page })`,
      });
    },
  },
};

export const adapters = [t3tab, pw, pwNone, dt, dtSlim, agentBrowser, devBrowser, playwriter];

export const TASKS = ['form', 'hidden', 'navigate', 'long', 'long-full', 'long-js', 'screenshot'];

export const TASK_TITLES = {
  form: 'Fill and submit a form',
  hidden: 'Open a hidden section',
  navigate: 'Follow a link',
  long: 'Search a long page',
  'long-full': 'Read a long page whole',
  'long-js': 'Search a long page with one line of JavaScript',
  screenshot: 'One screenshot',
};
