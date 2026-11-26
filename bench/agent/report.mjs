// Turns the runs of the agent benchmark into tables and into readable transcripts.
const median = (values) => {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  return (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2;
};
const sum = (values) => values.reduce((total, value) => total + value, 0);
const int = (value) => (value === undefined ? '-' : Math.round(value).toLocaleString('en-US'));
const usd = (value) => (value === undefined ? '-' : `$${value.toFixed(4)}`);
const secs = (ms) => (ms === undefined ? '-' : (ms / 1000).toFixed(1));
const ratio = (value, base) => (value === undefined || base === undefined || base === 0 ? '-' : `${(value / base).toFixed(2)}x`);

/** Tokens a run read and wrote: every kind of input, plus the output. */
export const tokensOf = (run) => run.usage.input + run.usage.output;

function summarise(runs) {
  const ok = runs.filter((run) => run.ok);
  return {
    runs: runs.length,
    ok: ok.length,
    inputMedian: median(runs.map((run) => run.usage.input)),
    outputMedian: median(runs.map((run) => run.usage.output)),
    tokensMedian: median(runs.map(tokensOf)),
    costMedian: median(runs.map((run) => run.costUsd)),
    wallMedian: median(runs.map((run) => run.wallMs)),
    callsMedian: median(runs.map((run) => run.toolCalls)),
    turnsMedian: median(runs.map((run) => run.turns)),
    tokensTotal: sum(runs.map(tokensOf)),
    inputTotal: sum(runs.map((run) => run.usage.input)),
    outputTotal: sum(runs.map((run) => run.usage.output)),
    costTotal: sum(runs.map((run) => run.costUsd)),
    wallTotal: sum(runs.map((run) => run.wallMs)),
    callsTotal: sum(runs.map((run) => run.toolCalls)),
    turnsTotal: sum(runs.map((run) => run.turns)),
    errorsTotal: sum(runs.map((run) => run.toolErrors)),
    firstInputMedian: median(runs.map((run) => run.first.input)),
    cacheWriteMedian: median(runs.map((run) => run.usage.cacheWrite)),
    costPerSuccess: ok.length === 0 ? undefined : sum(runs.map((run) => run.costUsd)) / ok.length,
  };
}

/** Markdown for a set of runs: per tool, then per task. `tools` and `tasks` give the order and the labels. */
export function markdown({ runs, tools, tasks, model, base = 't3tab' }) {
  const lines = [`# Agent benchmark: ${model}`, ''];
  const byTool = new Map(tools.map((tool) => [tool.id, runs.filter((run) => run.tool === tool.id)]));
  const summaries = new Map([...byTool].map(([id, list]) => [id, summarise(list)]));
  const baseline = summaries.get(base);

  lines.push('## Per tool, over every run', '');
  lines.push('Medians are over runs (a failed run counts with what it spent). Tokens are input (uncached + cache read + cache write) plus output, as the stream reports them. Ratios are against T3-Tab.', '');
  lines.push('| Tool | Runs | Success | Median tokens | vs T3-Tab | Median cost | vs T3-Tab | Median time (s) | vs T3-Tab | Median calls | Median turns | Total cost | Cost per success |');
  lines.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
  for (const tool of tools) {
    const s = summaries.get(tool.id);
    if (s === undefined || s.runs === 0) continue;
    lines.push(
      `| ${tool.label} | ${s.runs} | ${s.ok}/${s.runs} (${Math.round((100 * s.ok) / s.runs)}%) | ${int(s.tokensMedian)} | ${ratio(s.tokensMedian, baseline?.tokensMedian)} | ${usd(s.costMedian)} | ${ratio(s.costMedian, baseline?.costMedian)} | ${secs(s.wallMedian)} | ${ratio(s.wallMedian, baseline?.wallMedian)} | ${int(s.callsMedian)} | ${int(s.turnsMedian)} | ${usd(s.costTotal)} | ${usd(s.costPerSuccess)} |`,
    );
  }
  lines.push('', '### Totals', '');
  lines.push('| Tool | Input tokens | Output tokens | Tokens | vs T3-Tab | Cost | vs T3-Tab | Time (s) | vs T3-Tab | Tool calls | Tool errors | Turns |');
  lines.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
  for (const tool of tools) {
    const s = summaries.get(tool.id);
    if (s === undefined || s.runs === 0) continue;
    lines.push(
      `| ${tool.label} | ${int(s.inputTotal)} | ${int(s.outputTotal)} | ${int(s.tokensTotal)} | ${ratio(s.tokensTotal, baseline?.tokensTotal)} | ${usd(s.costTotal)} | ${ratio(s.costTotal, baseline?.costTotal)} | ${secs(s.wallTotal)} | ${ratio(s.wallTotal, baseline?.wallTotal)} | ${int(s.callsTotal)} | ${int(s.errorsTotal)} | ${int(s.turnsTotal)} |`,
    );
  }
  lines.push('', '### First call of a run', '');
  lines.push('The first model call writes the prompt cache (system prompt, tool definitions, task), so it is the most expensive one; later calls read it. Median over runs.', '');
  lines.push('| Tool | Median input of the first call | Median cache-write tokens in a run |');
  lines.push('| --- | ---: | ---: |');
  for (const tool of tools) {
    const s = summaries.get(tool.id);
    if (s === undefined || s.runs === 0) continue;
    lines.push(`| ${tool.label} | ${int(s.firstInputMedian)} | ${int(s.cacheWriteMedian)} |`);
  }

  lines.push('', '## Per task', '');
  for (const task of tasks) {
    const taskRuns = runs.filter((run) => run.task === task.id);
    if (taskRuns.length === 0) continue;
    lines.push(`### ${task.title} (\`${task.id}\`)`, '');
    lines.push('| Tool | Success | Median tokens | vs T3-Tab | Median cost | vs T3-Tab | Median time (s) | Median calls | Median turns |');
    lines.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
    const baseRuns = taskRuns.filter((run) => run.tool === base);
    const baseSummary = baseRuns.length === 0 ? undefined : summarise(baseRuns);
    for (const tool of tools) {
      const list = taskRuns.filter((run) => run.tool === tool.id);
      if (list.length === 0) continue;
      const s = summarise(list);
      lines.push(
        `| ${tool.label} | ${s.ok}/${s.runs} | ${int(s.tokensMedian)} | ${ratio(s.tokensMedian, baseSummary?.tokensMedian)} | ${usd(s.costMedian)} | ${ratio(s.costMedian, baseSummary?.costMedian)} | ${secs(s.wallMedian)} | ${int(s.callsMedian)} | ${int(s.turnsMedian)} |`,
      );
    }
    lines.push('');
  }

  const failed = runs.filter((run) => !run.ok);
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
