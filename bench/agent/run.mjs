// Agent benchmark: a real model solves the same browser tasks with each browser tool, and what it costs end to end
// is measured (tokens, USD, calls, turns, time), with success checked on the page and the site, not on the model's claim.
// Each run is a headless `claude -p` with one MCP server, no built-in tools, a temporary HOME and a fresh browser.
//
//   pnpm bench:agent                                  every tool and task, Haiku 5.5, 3 repeats
//   pnpm bench:agent --tools t3tab,dt-slim --tasks form,login --repeats 1
//   pnpm bench:agent --model claude-sonnet-5-5 --repeats 1 --label sonnet --tasks login,wizard,table
//   options: --concurrency N (default 2, the most browsers at once) --out DIR --label NAME --max-turns N --timeout-min N --fresh
//
// Needs `pnpm build` first (T3-Tab's extension and daemon) and a model route in the environment
// (ANTHROPIC_BASE_URL and ANTHROPIC_AUTH_TOKEN, or CLAUDE_CODE_OAUTH_TOKEN). Runs already in <out>/<label>/runs.jsonl are not repeated.
import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CLAUDE_BIN, PROMPT, claudeEnv, runClaude } from './claude.mjs';
import { startTaskSite } from './pages/index.mjs';
import { markdown, renderTranscript } from './report.mjs';
import { TASKS } from './tasks.mjs';
import { TOOLS } from './tools.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const options = parseArgs(process.argv.slice(2));
const outDir = join(options.out ?? join(here, 'results'), options.label);
await mkdir(join(outDir, 'transcripts'), { recursive: true });
const runsFile = join(outDir, 'runs.jsonl');
if (options.fresh) await rm(runsFile, { force: true });

const tools = TOOLS.filter((tool) => options.tools === undefined || options.tools.includes(tool.id));
const tasks = TASKS.filter((task) => options.tasks === undefined || options.tasks.includes(task.id));
for (const [name, known, picked] of [['tool', TOOLS, options.tools], ['task', TASKS, options.tasks]]) {
  const unknown = (picked ?? []).filter((id) => !known.some((entry) => entry.id === id));
  if (unknown.length > 0) throw new Error(`Unknown ${name} ${unknown.join(', ')}; known: ${known.map((entry) => entry.id).join(', ')}`);
}

const done = new Set((await readRuns()).map((run) => `${run.tool}/${run.task}/${run.rep}`));
const jobs = [];
for (let rep = 1; rep <= options.repeats; rep += 1) for (const tool of tools) for (const task of tasks) if (!done.has(`${tool.id}/${task.id}/${rep}`)) jobs.push({ tool, task, rep });
// A fixed shuffle, so no tool's runs sit together in time and the load of the machine falls on all of them alike.
shuffle(jobs, 20261126);
console.error(`${jobs.length} runs to do (${done.size} already in ${runsFile}), ${options.concurrency} at a time, model ${options.model}, claude ${CLAUDE_BIN}`);

let next = 0;
let finished = 0;
await Promise.all(
  Array.from({ length: options.concurrency }, async (_, worker) => {
    for (;;) {
      const job = jobs[next++];
      if (job === undefined) return;
      const run = await runJob(job, worker);
      await appendFile(runsFile, `${JSON.stringify(run)}\n`);
      finished += 1;
      console.error(`[${finished}/${jobs.length}] ${job.tool.id} ${job.task.id} #${job.rep}: ${run.ok ? 'ok' : `FAIL (${run.why ?? run.error})`}  calls ${run.toolCalls} turns ${run.turns} tokens ${run.usage.input + run.usage.output} $${run.costUsd.toFixed(4)} ${(run.wallMs / 1000).toFixed(1)}s`);
    }
  }),
);

const runs = await readRuns();
const report = markdown({ runs, tools: TOOLS, tasks: TASKS, model: options.model });
await writeFile(join(outDir, 'results.md'), report);
await writeFile(join(outDir, 'results.json'), `${JSON.stringify({ model: options.model, date: new Date().toISOString(), runs }, null, 2)}\n`);
console.log(report);
console.error(`Results in ${outDir} (results.md, results.json, runs.jsonl, transcripts/)`);
process.exit(0);

// ------------------------------------------------------------------------------------------------ one run

async function runJob({ tool, task, rep }, worker) {
  const id = `${tool.id}__${task.id}__${rep}`;
  const base = { tool: tool.id, task: task.id, rep, model: options.model };
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const run = await attemptJob({ tool, task, rep }, worker, id, attempt);
    // A tool server that did not connect is the harness's failure, not the tool's: try once more.
    if (run.infra === undefined || attempt === 2) return { ...base, ...run, attempts: attempt };
    console.error(`${id}: ${run.infra}; trying again`);
  }
  throw new Error('unreachable');
}

async function attemptJob({ tool, task }, worker, id, attempt) {
  const dir = await mkdtemp('/tmp/ab-');
  const run = 1000 * (worker + 1) + Math.floor(Math.random() * 1000);
  const env = {
    HOME: dir,
    XDG_CONFIG_HOME: join(dir, '.config'),
    XDG_DATA_HOME: join(dir, '.local', 'share'),
    XDG_STATE_HOME: join(dir, '.local', 'state'),
    XDG_CACHE_HOME: join(dir, '.cache'),
    T3TAB_AGENT_RUN: dir,
  };
  let site;
  let session;
  const empty = { usage: { input: 0, output: 0, uncached: 0, cacheRead: 0, cacheWrite: 0 }, first: { input: 0 }, toolCalls: 0, toolErrors: 0, turns: 0, costUsd: 0, wallMs: 0 };
  try {
    site = await startTaskSite();
    session = await tool.start({ dir, env, site: site.url, run });
    if (session.mcp.env.T3TAB_AGENT_RUN === undefined) session.mcp.env.T3TAB_AGENT_RUN = dir;
    const prompt = PROMPT(task.goal(site.url), session.hint);
    const transcriptFile = join(outDir, 'transcripts', `${id}.jsonl`);
    const result = await runClaude({
      dir,
      model: options.model,
      prompt,
      serverName: tool.server,
      mcpEntry: session.mcp,
      env: claudeEnv(dir, dir),
      transcriptFile,
      maxTurns: options.maxTurns,
      timeoutMs: options.timeoutMin * 60_000,
    });
    const server = result.init?.mcpServers.find((entry) => entry.name === tool.server);
    if (server?.status !== 'connected') {
      return { ...empty, ...result, ok: false, why: `MCP server ${tool.server} was ${server?.status ?? 'not listed'}`, infra: `MCP server ${tool.server} was ${server?.status ?? 'not listed'}` };
    }
    const checked = await withTimeout(
      task.check({ site, pageStates: () => withTimeout(session.states(), 15_000, 'reading the page'), answer: result.answer }),
      30_000,
      'the end-state check',
    ).catch((error) => ({ ok: false, why: `check failed: ${error.message}` }));
    const ok = checked.ok && result.finished && !result.isError && !result.timedOut;
    const why = ok ? undefined : checked.why ?? (result.timedOut ? 'the run hit the time limit' : `the run ended with ${result.subtype ?? 'no result'}`);
    const stream = (await readFile(transcriptFile, 'utf8')).split('\n').filter(Boolean);
    const header = `# ${tool.label} · ${task.id} · run ${attempt === 1 ? '' : `(attempt ${attempt}) `}${ok ? 'ok' : `FAILED: ${why}`}\n\nModel ${options.model}. ${result.toolCalls} tool calls, ${result.turns} turns, ${result.usage.input + result.usage.output} tokens, $${result.costUsd.toFixed(4)}, ${(result.wallMs / 1000).toFixed(1)} s.\n\nPrompt:\n\n> ${prompt.replace(/\n/g, '\n> ')}`;
    await writeFile(join(outDir, 'transcripts', `${id}.md`), renderTranscript(stream, header));
    const { init: _init, stderr, ...numbers } = result;
    return { ...numbers, ok, why: checked.ok && !ok ? why : checked.why ?? why, answer: result.answer.slice(0, 500), mcpStatus: server.status, stderr: stderr === '' ? undefined : stderr.slice(-500) };
  } catch (error) {
    return { ...empty, ok: false, why: `harness error: ${error instanceof Error ? error.message : String(error)}`, error: String(error), infra: undefined };
  } finally {
    await session?.stop?.().catch(() => undefined);
    await site?.close().catch(() => undefined);
    await killMarked(dir);
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => undefined);
  }
}

/** Kills every process that carries this run's marker in its environment: tool servers, their daemons, browsers. */
async function killMarked(mark) {
  const needle = `T3TAB_AGENT_RUN=${mark}\0`;
  for (let pass = 0; pass < 3; pass += 1) {
    let found = 0;
    for (const entry of await readdir('/proc').catch(() => [])) {
      if (!/^\d+$/.test(entry) || Number(entry) === process.pid) continue;
      const environ = await readFile(`/proc/${entry}/environ`, 'latin1').catch(() => '');
      if (!environ.includes(needle)) continue;
      found += 1;
      try {
        process.kill(Number(entry), 'SIGKILL');
      } catch {
        // Gone already.
      }
    }
    if (found === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
}

function withTimeout(promise, ms, what) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => (timer = setTimeout(() => reject(new Error(`timed out ${what}`)), ms)))]).finally(() => clearTimeout(timer));
}

async function readRuns() {
  const text = await readFile(runsFile, 'utf8').catch(() => '');
  return text.split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

function shuffle(list, seed) {
  let state = seed;
  const random = () => ((state = (state * 1664525 + 1013904223) % 4294967296) / 4294967296);
  for (let index = list.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1));
    [list[index], list[other]] = [list[other], list[index]];
  }
}

function parseArgs(argv) {
  const parsed = { model: 'claude-haiku-5-5', repeats: 3, concurrency: 2, maxTurns: 60, timeoutMin: 12, label: undefined, fresh: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = () => {
      const next = argv[index + 1];
      if (next === undefined) throw new Error(`${flag} needs a value`);
      index += 1;
      return next;
    };
    if (flag === '--tools') parsed.tools = value().split(',');
    else if (flag === '--tasks') parsed.tasks = value().split(',');
    else if (flag === '--model') parsed.model = value();
    else if (flag === '--repeats') parsed.repeats = Number(value());
    else if (flag === '--concurrency') parsed.concurrency = Number(value());
    else if (flag === '--max-turns') parsed.maxTurns = Number(value());
    else if (flag === '--timeout-min') parsed.timeoutMin = Number(value());
    else if (flag === '--out') parsed.out = value();
    else if (flag === '--label') parsed.label = value();
    else if (flag === '--fresh') parsed.fresh = true;
    else throw new Error(`Unknown option ${flag}`);
  }
  parsed.label ??= parsed.model.replace(/^claude-/, '').replace(/-5-5$/, '');
  for (const key of ['repeats', 'concurrency', 'maxTurns', 'timeoutMin']) if (!Number.isInteger(parsed[key]) || parsed[key] < 1) throw new Error(`--${key} takes a whole number of 1 or more`);
  return parsed;
}
