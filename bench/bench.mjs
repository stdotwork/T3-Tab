// Token benchmark: drives the real tools (built extension in headless Chromium, the real daemon and an
// MCP client over stdio) through a few fixed tasks on fixed local pages, and measures what an agent would
// be sent: the `tools/list` payload and each tool reply.
//
//   pnpm bench                          run, print a markdown table, write bench/results/latest.json,
//                                       and fail when a number is over bench/budget.json
//   pnpm bench --compare before.json    also show the change from an earlier results file
//   pnpm bench --update-budget          rewrite bench/budget.json from this run (commit it with the reason)
//   pnpm bench --check results.json     judge a saved results file against the budget; no browser
import { createServer } from 'node:http';
import { appendFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  assert,
  closeServer,
  connectMcp,
  createHome,
  extensionWorker,
  installNativeHost,
  jpegSize,
  launchBrowser,
  listen,
  refFor,
  requireBuild,
  setSite,
  stopDaemon,
  text,
  waitForBrowser,
} from '../e2e/harness.mjs';
import { benchPage } from './pages.mjs';
import { budgetFrom, checkBudget, estimateImageTokens, estimateTokens, markdown, TOKEN_ESTIMATE } from './report.mjs';

const benchDir = dirname(fileURLToPath(import.meta.url));
const options = parseArgs(process.argv.slice(2));
const budgetPath = options.budget ?? join(benchDir, 'budget.json');
const outPath = options.out ?? join(benchDir, 'results', 'latest.json');

if (options.check !== undefined) {
  const results = JSON.parse(await readFile(options.check, 'utf8'));
  process.exit(await judge(results));
}

const results = await measure();
await mkdir(dirname(outPath), { recursive: true });
const { transcript, ...saved } = results;
await writeFile(outPath, `${JSON.stringify(saved, null, 2)}\n`);
await writeFile(outPath.replace(/\.json$/, '.replies.txt'), `${transcript}\n`);
const before = options.compare === undefined ? undefined : JSON.parse(await readFile(options.compare, 'utf8'));
const report = markdown(results, before);
console.log(report);
console.log(`Results written to ${outPath}, the replies to ${outPath.replace(/\.json$/, '.replies.txt')}`);
if (process.env.GITHUB_STEP_SUMMARY) {
  await appendFile(process.env.GITHUB_STEP_SUMMARY, `## Token benchmark\n\n${report}\n`);
}
if (options.updateBudget) {
  await writeFile(budgetPath, `${JSON.stringify(budgetFrom(results), null, 2)}\n`);
  console.log(`Budget rewritten at ${budgetPath}`);
  process.exit(0);
}
process.exit(await judge(results));

async function judge(measured) {
  const budget = JSON.parse(await readFile(budgetPath, 'utf8'));
  const problems = checkBudget(measured, budget);
  if (problems.length === 0) {
    console.log(`Budget: every measured number is within ${budgetPath}`);
    return 0;
  }
  console.error(`Budget exceeded (${budgetPath}):\n${problems.map((problem) => `- ${problem}`).join('\n')}`);
  return 1;
}

async function measure() {
  const home = await createHome();
  let browserContext;
  let mcp;
  let pageServer;
  try {
    await requireBuild(home);
    pageServer = createServer((request, response) => {
      const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
      const { status, body } = benchPage(path);
      response.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
      response.end(body);
    });
    await listen(pageServer);
    const address = pageServer.address();
    assert(address !== null && typeof address !== 'string', 'The page server did not bind to a TCP port');
    const siteUrl = `http://127.0.0.1:${address.port}`;

    await installNativeHost(home);
    browserContext = await launchBrowser(home);
    const { serviceWorker } = await extensionWorker(browserContext);
    mcp = (await connectMcp(home, 't3-tab-bench')).client;
    await waitForBrowser(home);
    // Allow the bench site so no prompt waits on a person: the replies measured are the tools' own.
    await setSite(serviceWorker, siteUrl, 'allow');

    const steps = [];
    const transcript = [];
    const run = async (task, step, tool, args) => {
      const result = await mcp.callTool({ name: tool, arguments: args });
      const reply = text(result);
      assert(result.isError !== true, `${task}/${step}: ${tool} failed: ${reply}`);
      const record = {
        task,
        step,
        tool,
        callTokens: estimateTokens(JSON.stringify(args)),
        chars: reply.length,
        tokens: estimateTokens(reply),
      };
      const image = result.content.find((item) => item.type === 'image');
      if (image !== undefined) {
        const bytes = Buffer.from(image.data, 'base64');
        const size = jpegSize(bytes);
        assert(size !== undefined, `${task}/${step}: the screenshot is not a JPEG`);
        record.image = { width: size.width, height: size.height, bytes: bytes.length, tokens: estimateImageTokens(size.width, size.height) };
      }
      steps.push(record);
      transcript.push(`=== ${task}/${step}: ${tool} ${JSON.stringify(args)} ===\n${reply}`);
      return reply;
    };

    const tools = (await mcp.listTools()).tools;
    const definitions = {
      total: sizeOf(JSON.stringify(tools)),
      tools: Object.fromEntries(tools.map((tool) => [tool.name, sizeOf(JSON.stringify(tool))])),
    };

    // 1. Fill and submit a form. A load replies with the page, so its refs come from the open.
    const formRead = await run('form', 'open', 'tabs', { action: 'open', url: `${siteUrl}/form` });
    const refs = {
      name: need(formRead, 'textbox "Name"'),
      email: need(formRead, 'textbox "Email"'),
      country: need(formRead, 'combobox "Country"'),
      submit: need(formRead, 'button "Create account"'),
    };
    await run('form', 'act-fill-submit', 'act', {
      steps: [
        { action: 'fill', ref: refs.name, text: 'Ada Lovelace' },
        { action: 'fill', ref: refs.email, text: 'ada@example.com' },
        { action: 'select', ref: refs.country, text: 'Brazil' },
        { action: 'click', ref: refs.submit },
      ],
    });
    await run('form', 'screenshot', 'screenshot', {});

    // 2. Open a hidden section: the click through `act`, then a change made behind the agent's back so
    // the next `read` is a diff.
    const hiddenRead = await run('hidden', 'open', 'tabs', { action: 'open', url: `${siteUrl}/form` });
    await run('hidden', 'act-click', 'act', { steps: [{ action: 'click', ref: need(hiddenRead, 'button "Show details"') }] });
    await run('hidden', 'run_js', 'run_js', { expression: "document.getElementById('toggle').click()" });
    await run('hidden', 'read-diff', 'read', {});
    await run('hidden', 'read-unchanged', 'read', {});

    // 3. Follow a link: the reply to the click is the new page, so a full read sent with it is answered in one line.
    const productsRead = await run('navigate', 'open', 'tabs', { action: 'open', url: `${siteUrl}/products` });
    await run('navigate', 'act-click-link', 'act', { steps: [{ action: 'click', ref: need(productsRead, 'link "Day pack"') }] });
    const repeated = await run('navigate', 'read-full', 'read', { full: true });
    assert(/^tab \d+\nNo changes since the act's reply, which showed the whole page\.$/.test(repeated), `navigate/read-full: not the one line:\n${repeated}`);
    await run('navigate', 'tabs-list', 'tabs', {});

    // 4. Search a longer page: on the load itself, then in the page it holds. Its load reply leaves the page to the read.
    await run('long', 'read-url-find', 'read', { url: `${siteUrl}/docs`, find: 'rate limit' });
    await run('long', 'open', 'tabs', { action: 'open', url: `${siteUrl}/docs` });
    const longRead = await run('long', 'read-first', 'read', {});
    await run('long', 'find', 'read', { find: 'rate limit' });
    await run('long', 'read-subtree', 'read', { ref: need(longRead, 'region "Topic 12: Tokens"') });
    await run('long', 'read-all', 'read', { all: true });
    await run('long', 'screenshot', 'screenshot', {});

    // 5. A page too long to send whole: a read gets its outline, an order sent with a bad address comes back as a new page
    // with the error inside the form, and find reaches an item the outline left out.
    const outline = await run('outline', 'read-url', 'read', { url: `${siteUrl}/catalogue` });
    assert(outline.includes('(Outline of a long page'), `outline/read-url: not an outline:\n${outline}`);
    const ordered = await run('outline', 'act-order', 'act', {
      steps: [
        { action: 'fill', ref: need(outline, 'textbox "Email"'), text: 'ada.example.com' },
        { action: 'click', ref: need(outline, 'button "Place order"') },
      ],
    });
    assert(ordered.includes('(Outline of a long page') && /textbox "Email"[^\n]*\[invalid\]/.test(ordered) && ordered.includes('Enter an email address with an @ in it.'), `outline/act-order: the error is not in the outline:\n${ordered}`);
    await run('outline', 'find', 'read', { find: 'Item 61:' });
    // The act's reply was an outline, so a full read is the whole view.
    const whole = await run('outline', 'read-full', 'read', { full: true });
    assert(!whole.includes('Outline of a long page') && !whole.includes('No changes since') && whole.includes('textbox "Email"'), `outline/read-full: not the whole view:\n${whole.slice(0, 400)}`);

    // 6. A combobox's list opens and closes: the act that opens it shows every option, the one that picks a state counts
    // the options that went in one line.
    const delivery = await run('combobox', 'open', 'tabs', { action: 'open', url: `${siteUrl}/delivery` });
    const opened = await run('combobox', 'act-open', 'act', { steps: [{ action: 'click', ref: need(delivery, 'button "States"') }] });
    const picked = await run('combobox', 'act-pick', 'act', { steps: [{ action: 'click', ref: need(opened.replace(/^[+-]/gm, ' '), 'option "Kansas"') }] });
    assert(/\(\d+ lines removed: "Alabama", … "Maryland"\)/.test(picked) && picked.includes('value="Kansas"'), `combobox/act-pick: the options that went are not counted:\n${picked}`);

    const version = browserContext.browser()?.version() ?? (await serviceWorker.evaluate(() => navigator.userAgent));
    return {
      version: 1,
      environment: { browser: `Chromium ${version}`, node: process.version, tokenizer: 'o200k_base (gpt-tokenizer)' },
      tokenEstimate: TOKEN_ESTIMATE,
      definitions,
      steps,
      transcript: transcript.join('\n\n'),
    };
  } finally {
    if (mcp !== undefined) await mcp.close().catch(() => undefined);
    if (browserContext !== undefined) await browserContext.close().catch(() => undefined);
    if (pageServer !== undefined) await closeServer(pageServer);
    await stopDaemon(home.statePath);
    await rm(home.tempHome, { recursive: true, force: true });
  }
}

function sizeOf(json) {
  return { chars: json.length, tokens: estimateTokens(json) };
}

function need(readText, label) {
  const ref = refFor(readText, label);
  assert(ref !== undefined, `No ref for ${label} in:\n${readText}`);
  return ref;
}

function parseArgs(argv) {
  const parsed = { updateBudget: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = () => {
      const next = argv[index + 1];
      if (next === undefined) throw new Error(`${flag} needs a value`);
      index += 1;
      return next;
    };
    if (flag === '--compare') parsed.compare = value();
    else if (flag === '--out') parsed.out = value();
    else if (flag === '--budget') parsed.budget = value();
    else if (flag === '--check') parsed.check = value();
    else if (flag === '--update-budget') parsed.updateBudget = true;
    else throw new Error(`Unknown option ${flag}`);
  }
  return parsed;
}
