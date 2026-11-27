// Turns the runs of the agent benchmark into tables and into readable transcripts.
import { attributable, headToHead, median, medianToolBusy, medianToolLatency, requestsOf, tokensOf } from './stats.mjs';

const sum = (values) => values.reduce((total, value) => total + value, 0);
const int = (value) => (value === undefined ? '-' : Math.round(value).toLocaleString('en-US'));
const usd = (value) => (value === undefined ? '-' : `$${value.toFixed(4)}`);
const secs = (ms) => (ms === undefined ? '-' : (ms / 1000).toFixed(1));
const ratio = (value, base) => (value === undefined || base === undefined || base === 0 ? '-' : `${(value / base).toFixed(2)}x`);
const x2 = (value) => (value === undefined || !Number.isFinite(value) ? '-' : `${value.toFixed(2)}x`);
const interval = (entry) => (entry === undefined ? '-' : `${x2(entry.geomean)} [${x2(entry.low)}–${x2(entry.high)}]`);

/** The baseline's number for each task: the median input of the no-tool runs' first request (the fixed cost of a run). */
function baselineTokens(runs, baselineId) {
  const byTask = new Map();
  for (const run of runs.filter((entry) => entry.tool === baselineId)) byTask.set(run.task, [...(byTask.get(run.task) ?? []), run.first.input]);
  return new Map([...byTask].map(([task, tokens]) => [task, median(tokens)]));
}

function summarise(runs, baseline) {
  const ok = runs.filter((run) => run.ok);
  const attr = runs.map((run) => (baseline.has(run.task) ? attributable(tokensOf(run), baseline.get(run.task)) : undefined)).filter((value) => value !== undefined);
  return {
    runs: runs.length,
    ok: ok.length,
    inputMedian: median(runs.map((run) => run.usage.input)),
    outputMedian: median(runs.map((run) => run.usage.output)),
    tokensMedian: median(runs.map(tokensOf)),
    attrMedian: median(attr),
    costMedian: median(runs.map((run) => run.costUsd)),
    wallMedian: median(runs.map((run) => run.wallMs)),
    callsMedian: median(runs.map((run) => run.toolCalls)),
    requestsMedian: median(runs.map(requestsOf)),
    turnsMedian: median(runs.map((run) => run.turns)),
    latencyMedian: medianToolLatency(runs),
    busyMedian: medianToolBusy(runs),
    tokensTotal: sum(runs.map(tokensOf)),
    inputTotal: sum(runs.map((run) => run.usage.input)),
    outputTotal: sum(runs.map((run) => run.usage.output)),
    costTotal: sum(runs.map((run) => run.costUsd)),
    wallTotal: sum(runs.map((run) => run.wallMs)),
    callsTotal: sum(runs.map((run) => run.toolCalls)),
    requestsTotal: sum(runs.map(requestsOf)),
    turnsTotal: sum(runs.map((run) => run.turns)),
    errorsTotal: sum(runs.map((run) => run.toolErrors)),
    firstInputMedian: median(runs.map((run) => run.first.input)),
    cacheWriteMedian: median(runs.map((run) => run.usage.cacheWrite)),
    costPerSuccess: ok.length === 0 ? undefined : sum(runs.map((run) => run.costUsd)) / ok.length,
  };
}

/** Markdown for a set of runs: against T3-Tab, per tool, then per task. `tools` and `tasks` give the order and the labels. */
export function markdown({ runs: allRuns, tools: allTools, tasks, model, sites = 'local', base = 't3tab', baselineId = 'none' }) {
  // A baseline run that never finished (a stalled model request) says nothing about the fixed cost of a run.
  const runs = allRuns.filter((run) => !(run.baseline === true && run.finished !== true));
  const tools = allTools.filter((tool) => runs.some((run) => run.tool === tool.id));
  const lines = [`# Agent benchmark: ${model}, ${sites === 'real' ? 'held-out public-site tasks' : 'local tasks'}`, ''];
  const baseline = baselineTokens(runs, baselineId);
  const competitors = tools.filter((tool) => tool.baseline !== true);
  const toolRuns = new Map(competitors.map((tool) => [tool.id, runs.filter((run) => run.tool === tool.id)]));
  const summaries = new Map([...toolRuns].map(([id, list]) => [id, summarise(list, baseline)]));
  const reference = summaries.get(base);
  const repeats = Math.max(0, ...competitors.map((tool) => (toolRuns.get(tool.id) ?? []).length)) / Math.max(1, tasks.length);

  // ---- against T3-Tab
  const versus = headToHead({ runs, tools: competitors, reference: base, baselineId });
  lines.push('## Against T3-Tab', '');
  lines.push(
    `Each cell is the geometric mean over tasks of (T3-Tab's median) / (the tool's median), with a 90% bootstrap interval (2,000 resamples of the runs of every task cell): below 1.00x, T3-Tab used less. Tool-attributable tokens are a run's tokens minus the no-tool baseline's number for the same task (never below 1): the median input of the baseline's first request, which is Claude Code's own system prompt and the task, so that is not counted for any tool. Model requests are the API responses of a run. Failed runs count with what they spent. About ${repeats.toFixed(1)} runs per task and tool.`,
    '',
  );
  lines.push('Targets: tool-attributable tokens and model requests at most 0.50x the best competitor; total tokens at most 0.65x `chrome-devtools-mcp --slim`; success on every task; median tool latency not worse than the best.', '');
  if (baseline.size === 0) lines.push('No baseline runs are in these results, so tool-attributable tokens are not shown.', '');
  lines.push('| Tool | Success | Tool-attributable tokens | Model requests | Total tokens | Cost | Time | Median tool latency (ms) | Median tool-busy time per run (s) | Median wall time per run (s) |');
  lines.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
  if (reference !== undefined && reference.runs > 0) {
    lines.push(`| T3-Tab (reference) | ${reference.ok}/${reference.runs} | median ${int(reference.attrMedian)} | median ${int(reference.requestsMedian)} | median ${int(reference.tokensMedian)} | median ${usd(reference.costMedian)} | median ${secs(reference.wallMedian)} s | ${int(reference.latencyMedian)} | ${secs(reference.busyMedian)} | ${secs(reference.wallMedian)} |`);
  }
  for (const row of versus) {
    const tool = competitors.find((entry) => entry.id === row.tool);
    const s = summaries.get(row.tool);
    lines.push(
      `| ${tool.label} | ${s.ok}/${s.runs} | ${interval(row.metrics.attributable)} | ${interval(row.metrics.requests)} | ${interval(row.metrics.tokens)} | ${interval(row.metrics.cost)} | ${interval(row.metrics.time)} | ${int(s.latencyMedian)} | ${secs(s.busyMedian)} | ${secs(s.wallMedian)} |`,
    );
  }
  lines.push('');
  lines.push(
    'A call\'s latency is from its request to its reply in the stream, so calls sent in one message, which run one after another, each count the wait for the ones before; tools differ in what one call does. Tool-busy time is per run, with the time such calls share counted once. Wall time is from starting `claude` to its exit, model time included.',
    '',
  );
  const closest = (metric) => versus.filter((row) => row.metrics[metric] !== undefined).sort((a, b) => b.metrics[metric].geomean - a.metrics[metric].geomean)[0];
  for (const [metric, label] of [['attributable', 'tool-attributable tokens'], ['requests', 'model requests'], ['tokens', 'total tokens']]) {
    const row = closest(metric);
    if (row === undefined) continue;
    lines.push(`- Best competitor on ${label}: ${competitors.find((tool) => tool.id === row.tool).label}, T3-Tab at ${interval(row.metrics[metric])} of it.`);
  }
  lines.push('');

  // ---- per tool
  lines.push('## Per tool, over every run', '');
  lines.push('Medians are over runs (a failed run counts with what it spent). Tokens are input (uncached + cache read + cache write) plus output, as the stream reports them. Ratios are against T3-Tab.', '');
  lines.push('| Tool | Runs | Success | Median tokens | vs T3-Tab | Median tool-attributable tokens | vs T3-Tab | Median requests | Median calls | Median cost | vs T3-Tab | Median time (s) | vs T3-Tab | Total cost | Cost per success |');
  lines.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
  for (const tool of competitors) {
    const s = summaries.get(tool.id);
    if (s === undefined || s.runs === 0) continue;
    lines.push(
      `| ${tool.label} | ${s.runs} | ${s.ok}/${s.runs} (${Math.round((100 * s.ok) / s.runs)}%) | ${int(s.tokensMedian)} | ${ratio(s.tokensMedian, reference?.tokensMedian)} | ${int(s.attrMedian)} | ${ratio(s.attrMedian, reference?.attrMedian)} | ${int(s.requestsMedian)} | ${int(s.callsMedian)} | ${usd(s.costMedian)} | ${ratio(s.costMedian, reference?.costMedian)} | ${secs(s.wallMedian)} | ${ratio(s.wallMedian, reference?.wallMedian)} | ${usd(s.costTotal)} | ${usd(s.costPerSuccess)} |`,
    );
  }
  lines.push('', '### Totals', '');
  lines.push('| Tool | Input tokens | Output tokens | Tokens | vs T3-Tab | Cost | vs T3-Tab | Time (s) | vs T3-Tab | Model requests | Tool calls | Tool errors | Turns |');
  lines.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
  for (const tool of competitors) {
    const s = summaries.get(tool.id);
    if (s === undefined || s.runs === 0) continue;
    lines.push(
      `| ${tool.label} | ${int(s.inputTotal)} | ${int(s.outputTotal)} | ${int(s.tokensTotal)} | ${ratio(s.tokensTotal, reference?.tokensTotal)} | ${usd(s.costTotal)} | ${ratio(s.costTotal, reference?.costTotal)} | ${secs(s.wallTotal)} | ${ratio(s.wallTotal, reference?.wallTotal)} | ${int(s.requestsTotal)} | ${int(s.callsTotal)} | ${int(s.errorsTotal)} | ${int(s.turnsTotal)} |`,
    );
  }
  lines.push('', '### First call of a run', '');
  lines.push('The first model call writes the prompt cache (system prompt, tool definitions, task), so it is the most expensive one; later calls read it. Median over runs.', '');
  lines.push('| Tool | Median input of the first call | Median cache-write tokens in a run |');
  lines.push('| --- | ---: | ---: |');
  for (const tool of tools) {
    const list = runs.filter((run) => run.tool === tool.id);
    if (list.length === 0) continue;
    const s = summarise(list, baseline);
    lines.push(`| ${tool.label} | ${int(s.firstInputMedian)} | ${int(s.cacheWriteMedian)} |`);
  }

  // ---- the no-tool baseline
  const baselineRuns = runs.filter((run) => run.tool === baselineId);
  if (baselineRuns.length > 0) {
    lines.push('', '### No-tool baseline', '');
    lines.push('Claude Code with no browser server, the same prompt. The input of its first request is what every run pays whatever the tool, and is subtracted from each run for the tool-attributable tokens. Its whole run is shown for reference only: with no tools the model improvises and Claude Code continues it, so it makes several requests.', '');
    lines.push('| Task | Runs | Median first-request input (subtracted) | Median tokens of the whole run | Median requests | Median cost |');
    lines.push('| --- | ---: | ---: | ---: | ---: | ---: |');
    for (const task of tasks) {
      const list = baselineRuns.filter((run) => run.task === task.id);
      if (list.length === 0) continue;
      lines.push(`| \`${task.id}\` | ${list.length} | ${int(median(list.map((run) => run.first.input)))} | ${int(median(list.map(tokensOf)))} | ${int(median(list.map(requestsOf)))} | ${usd(median(list.map((run) => run.costUsd)))} |`);
    }
  }

  // ---- per task
  lines.push('', '## Per task', '');
  for (const task of tasks) {
    const taskRuns = runs.filter((run) => run.task === task.id && run.tool !== baselineId);
    if (taskRuns.length === 0) continue;
    lines.push(`### ${task.title} (\`${task.id}\`)${task.flaky === undefined ? '' : ` — flaky: ${task.flaky}`}`, '');
    lines.push('| Tool | Success | Median tokens | Median tool-attributable tokens | vs T3-Tab | Median requests | Median calls | Median cost | vs T3-Tab | Median time (s) |');
    lines.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
    const baseRuns = taskRuns.filter((run) => run.tool === base);
    const baseSummary = baseRuns.length === 0 ? undefined : summarise(baseRuns, baseline);
    for (const tool of competitors) {
      const list = taskRuns.filter((run) => run.tool === tool.id);
      if (list.length === 0) continue;
      const s = summarise(list, baseline);
      lines.push(
        `| ${tool.label} | ${s.ok}/${s.runs} | ${int(s.tokensMedian)} | ${int(s.attrMedian)} | ${ratio(s.attrMedian, baseSummary?.attrMedian)} | ${int(s.requestsMedian)} | ${int(s.callsMedian)} | ${usd(s.costMedian)} | ${ratio(s.costMedian, baseSummary?.costMedian)} | ${secs(s.wallMedian)} |`,
      );
    }
    lines.push('');
  }

  const flaky = tasks.filter((task) => task.flaky !== undefined);
  if (flaky.length > 0) {
    lines.push('## Flaky tasks', '');
    for (const task of flaky) lines.push(`- \`${task.id}\`: ${task.flaky}`);
    lines.push('');
  }

  const failed = runs.filter((run) => !run.ok && run.tool !== baselineId);
  lines.push('## Runs that failed', '');
  if (failed.length === 0) lines.push('None.');
  else {
    lines.push('| Tool | Task | Run | Why | Calls | Turns | Stopped by |');
    lines.push('| --- | --- | ---: | --- | ---: | ---: | --- |');
    for (const run of failed) {
      const stopped = run.timedOut ? 'time limit' : run.subtype !== 'success' ? String(run.subtype ?? run.terminalReason ?? 'no result') : '';
      lines.push(`| ${run.tool} | ${run.task} | ${run.rep} | ${(run.why ?? run.error ?? '').replace(/\|/g, '\\|').slice(0, 160)} | ${run.toolCalls} | ${run.turns} | ${stopped} |`);
    }
  }
  return `${lines.join('\n')}\n`;
}

const clip = (text, limit) => (text.length <= limit ? text : `${text.slice(0, limit)}… [+${text.length - limit} chars]`);

/** A transcript a person can read: each model turn's text, each tool call and what came back. */
export function renderTranscript(streamLines, header) {
  const events = [];
  for (const line of streamLines) {
    try {
      events.push(JSON.parse(line));
    } catch {
      // A partial line.
    }
  }
  const out = [header, ''];
  const seen = new Set();
  let step = 0;
  for (const event of events) {
    if (event.type === 'assistant') {
      const message = event.message;
      for (const block of message.content ?? []) {
        if (block.type === 'text' && block.text.trim() !== '') out.push(`**model:** ${clip(block.text.trim(), 1200)}`, '');
        if (block.type === 'thinking' && (block.thinking ?? '').trim() !== '') out.push(`*thinking:* ${clip(block.thinking.trim(), 600)}`, '');
        if (block.type === 'tool_use' && !seen.has(block.id)) {
          seen.add(block.id);
          step += 1;
          out.push(`**call ${step}:** \`${block.name}\` ${clip(JSON.stringify(block.input), 1500)}`, '');
        }
      }
    } else if (event.type === 'user') {
      for (const block of event.message?.content ?? []) {
        if (block.type !== 'tool_result') continue;
        const content = Array.isArray(block.content)
          ? block.content.map((part) => (part.type === 'text' ? part.text : `[${part.type}]`)).join('\n')
          : String(block.content ?? '');
        out.push(`**reply${block.is_error ? ' (ERROR)' : ''}:**`, '```', clip(content, 2500), '```', '');
      }
    } else if (event.type === 'result') {
      out.push(`**result:** ${event.subtype} — ${clip(String(event.result ?? ''), 800)}`, '');
    }
  }
  return `${out.join('\n')}\n`;
}
