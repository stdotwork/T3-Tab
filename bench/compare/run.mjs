// Head-to-head benchmark: T3-Tab's browser tools against other browser MCP servers, on the pages of `pnpm bench`
// (bench/pages.mjs), with no model in the loop. Each tool runs a fixed, scripted call sequence per task
// (adapters.mjs); the harness counts what the agent would be sent and checks the page itself to see whether
// the task's end state was reached.
//
//   pnpm bench:compare                       every tool, one run
//   pnpm bench:compare --runs 2              repeat the whole run and report how far the numbers moved
//   pnpm bench:compare --tools t3tab,pw      only these tools (ids from adapters.mjs)
//   pnpm bench:compare --out some/dir        write the results there (default bench/compare/results)
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

import { closeServer, listen, sleep } from '../../e2e/harness.mjs';
import { benchPage } from '../pages.mjs';
import { estimateImageTokens, estimateTokens, TOKEN_ESTIMATE } from '../report.mjs';
import { SEARCH_ANSWER, TASKS, adapters } from './adapters.mjs';
import { imageSize, launchChromium, pageStates } from './lib.mjs';
import { markdown, measureDefinitionOnly } from './report.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const options = parseArgs(process.argv.slice(2));
const outDir = options.out ?? join(here, 'results');

const selected = adapters.filter((adapter) => options.tools === undefined || options.tools.includes(adapter.id));
if (selected.length === 0) throw new Error(`No tool matches ${options.tools}; known: ${adapters.map((adapter) => adapter.id).join(', ')}`);

const pageServer = createServer((request, response) => {
  const { status, body } = benchPage(new URL(request.url ?? '/', 'http://127.0.0.1').pathname);
  response.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
  response.end(body);
});
await listen(pageServer);
const address = pageServer.address();
const site = `http://127.0.0.1:${address.port}`;

const runs = [];
try {
  for (let index = 0; index < options.runs; index += 1) {
    const tools = [];
    for (const adapter of selected) {
      console.error(`run ${index + 1}/${options.runs}: ${adapter.label}`);
      tools.push(await measureTool(adapter));
    }
    runs.push(tools);
  }
} finally {
  await closeServer(pageServer);
}
const definitionOnly = options.tools === undefined ? await measureDefinitionOnly(root) : [];

const merged = merge(runs);
const results = {
  version: 1,
  environment: {
    chromium: await chromiumVersion(),
    node: process.version,
    tokenizer: 'o200k_base (gpt-tokenizer)',
    runs: options.runs,
    date: new Date().toISOString(),
  },
  tokenEstimate: TOKEN_ESTIMATE,
  tools: merged.tools,
  definitionOnly,
  transcript: merged.transcript,
};
await mkdir(outDir, { recursive: true });
const { transcript, ...saved } = results;
await writeFile(join(outDir, 'latest.json'), `${JSON.stringify(saved, null, 2)}\n`);
await writeFile(join(outDir, 'latest.replies.txt'), `${transcript}\n`);
const report = markdown(saved);
await writeFile(join(outDir, 'latest.md'), `${report}\n`);
console.log(report);
console.log(`Results written to ${outDir}/latest.json (replies in latest.replies.txt, table in latest.md)`);
process.exit(0);

// ------------------------------------------------------------------------------------------------ one tool

async function measureTool(adapter) {
  const dir = await mkdtemp(join(tmpdir(), 'cmp-'));
  const env = {
    HOME: dir,
    XDG_CACHE_HOME: join(dir, '.cache'),
    XDG_CONFIG_HOME: join(dir, '.config'),
    XDG_DATA_HOME: join(dir, '.local', 'share'),
    XDG_STATE_HOME: join(dir, '.local', 'state'),
    TMPDIR: dir,
  };
  const result = { id: adapter.id, label: adapter.label, package: adapter.package, notes: adapter.notes, tasks: {} };
  let browser;
  let session;
  try {
    result.version = adapter.versionOf !== undefined ? await adapter.versionOf() : await packageVersion(adapter.package);
    if (adapter.id !== 't3tab') {
      // A short folder for Chromium's socket (a long TMPDIR made it abort in the end-to-end harness).
      browser = await launchChromium({ profileDir: join(dir, 'profile'), env: { ...process.env, ...env, TMPDIR: '/tmp' } });
    }
    session = await adapter.start({ site, port: browser?.port, dir, env });
    const listed = (await session.client.listTools()).tools;
    result.definitions = {
      count: listed.length,
      chars: JSON.stringify(listed).length,
      tokens: estimateTokens(JSON.stringify(listed)),
      tools: Object.fromEntries(listed.map((tool) => [tool.name, { chars: JSON.stringify(tool).length, tokens: estimateTokens(JSON.stringify(tool)) }])),
    };
    result.transcript = [];
    const states = session.states ?? (() => pageStates(browser.port, site));
    // One pass nobody measures first, so the first task does not pay for a server that starts its browser
    // connection on the first call. Every task opens its own page, so the pass leaves nothing the next depends on.
    for (const task of TASKS) await runTask(adapter, session, task, states, []);
    for (const task of TASKS) result.tasks[task] = await runTask(adapter, session, task, states, result.transcript);
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
    console.error(`${adapter.label} could not run: ${result.error}`);
  } finally {
    await session?.stop?.().catch(() => undefined);
    await browser?.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => undefined);
  }
  return result;
}

async function runTask(adapter, session, task, states, transcript) {
  const steps = [];
  const call = async (tool, args) => {
    const started = performance.now();
    const reply = await session.client.callTool({ name: tool, arguments: args }, undefined, { timeout: 330_000 });
    const ms = performance.now() - started;
    const replyText = reply.content
      .filter((item) => item.type === 'text')
      .map((item) => item.text)
      .join('\n');
    const step = {
      tool,
      callTokens: estimateTokens(JSON.stringify(args)),
      chars: replyText.length,
      tokens: estimateTokens(replyText),
      ms: Math.round(ms),
    };
    const image = reply.content.find((item) => item.type === 'image');
    if (image !== undefined) {
      const bytes = Buffer.from(image.data, 'base64');
      const size = imageSize(bytes);
      step.image = { mime: image.mimeType, bytes: bytes.length, ...size };
      step.image.tokens = size === undefined ? 0 : estimateImageTokens(size.width, size.height);
    }
    else if (/^\/\S+\.(png|jpe?g|webp)$/.test(replyText.trim())) {
      // A tool that saves the picture and answers with its path: the agent has to open the file to see it.
      const bytes = await readFile(replyText.trim()).catch(() => undefined);
      const size = bytes === undefined ? undefined : imageSize(bytes);
      if (bytes !== undefined) {
        step.image = { mime: 'file', viaFile: true, bytes: bytes.length, ...size };
        step.image.tokens = size === undefined ? 0 : estimateImageTokens(size.width, size.height);
      }
    }
    if (reply.isError === true) step.error = true;
    steps.push({ ...step, text: replyText });
    transcript.push(`=== ${task}/${steps.length}: ${tool} ${JSON.stringify(args)}${step.error ? ' (ERROR)' : ''} ===\n${replyText}`);
    if (step.error) throw new Error(`${tool} failed: ${replyText.slice(0, 300)}`);
    return replyText;
  };
  let error;
  const started = performance.now();
  try {
    await adapter.tasks[task]({ site, call });
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  }
  const ms = Math.round(performance.now() - started);
  await sleep(300);
  let ok = false;
  if (error === undefined) ok = await reached(task, steps, states).catch((caught) => ((error = `check failed: ${caught}`), false));
  return {
    ok,
    ...(error === undefined ? {} : { error }),
    calls: steps.length,
    ms,
    callTokens: sum(steps, (step) => step.callTokens),
    replyChars: sum(steps, (step) => step.chars),
    replyTokens: sum(steps, (step) => step.tokens),
    imageTokens: sum(steps, (step) => step.image?.tokens ?? 0),
    steps: steps.map((step) => ({ ...step, text: undefined })),
  };
}

/** Did the task end where it should? The page is asked, not the tool. */
async function reached(task, steps, states) {
  if (task === 'long' || task === 'long-full' || task === 'long-js') {
    // Information tasks: the answer has to have been sent to the agent.
    return steps.some((step) => step.text.includes(SEARCH_ANSWER));
  }
  if (task === 'screenshot') return steps.some((step) => (step.image?.width ?? 0) > 0 && (step.image?.height ?? 0) > 0);
  const all = await states();
  if (task === 'form') {
    return all.some((state) => state.path === '/form' && state.result === 'Welcome Ada Lovelace (ada@example.com)' && state.country === 'Brazil');
  }
  if (task === 'hidden') return all.some((state) => state.path === '/form' && state.detailsHidden === false);
  if (task === 'navigate') return all.some((state) => state.path === '/products/3');
  throw new Error(`No end-state check for ${task}`);
}

// ---------------------------------------------------------------------------------------------- the runs

/** One result set from the runs: the first run's numbers, with how far the others moved from them. */
function merge(allRuns) {
  const [first, ...rest] = allRuns;
  const transcript = [];
  const tools = first.map((tool, toolIndex) => {
    const { transcript: toolTranscript, ...kept } = tool;
    transcript.push(`##### ${tool.label}\n\n${(toolTranscript ?? []).join('\n\n')}`);
    for (const [task, result] of Object.entries(kept.tasks)) {
      const others = rest.map((run) => run[toolIndex].tasks[task]).filter((other) => other !== undefined);
      const all = [result, ...others];
      const times = all.map((one) => one.ms);
      // The time shown is the median of the runs (the mean of the middle two for an even number).
      const sorted = [...times].sort((a, b) => a - b);
      result.ms = Math.round((sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2);
      const totals = all.map((one) => one.callTokens + one.replyTokens + one.imageTokens);
      result.variation = {
        runs: all.length,
        okInEveryRun: all.every((one) => one.ok),
        msMin: Math.min(...times),
        msMax: Math.max(...times),
        tokensMin: Math.min(...totals),
        tokensMax: Math.max(...totals),
        callsEqual: all.every((one) => one.calls === result.calls),
      };
    }
    return kept;
  });
  return { tools, transcript: transcript.join('\n\n') };
}

function sum(items, pick) {
  return items.reduce((total, item) => total + pick(item), 0);
}

async function packageVersion(name) {
  const manifest = JSON.parse(await readFile(join(root, 'node_modules', name, 'package.json'), 'utf8'));
  return manifest.version;
}

async function chromiumVersion() {
  const browser = await chromium.launch({ headless: true });
  try {
    return browser.version();
  } finally {
    await browser.close();
  }
}

function parseArgs(argv) {
  const parsed = { runs: 1 };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = () => {
      const next = argv[index + 1];
      if (next === undefined) throw new Error(`${flag} needs a value`);
      index += 1;
      return next;
    };
    if (flag === '--runs') parsed.runs = Number(value());
    else if (flag === '--tools') parsed.tools = value().split(',');
    else if (flag === '--out') parsed.out = value();
    else throw new Error(`Unknown option ${flag}`);
  }
  if (!Number.isInteger(parsed.runs) || parsed.runs < 1) throw new Error('--runs takes a whole number of 1 or more');
  return parsed;
}
