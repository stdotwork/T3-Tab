// The numbers the agent benchmark is judged on. A run's raw tokens include everything Claude Code sends whatever the
// browser tool is (its system prompt and the task), so each run is also measured net of a no-tool baseline, and tools are
// compared by the geometric mean over tasks of per-task ratios against T3-Tab, with a bootstrap interval.
//
// The baseline's number is the input of its first request (system prompt plus task), not its whole run's tokens: with no
// tools the model improvises, Claude Code continues it after the output cap, and a baseline run makes several requests.

export const median = (values) => {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  return (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2;
};

export const geomean = (values) => (values.length === 0 ? undefined : Math.exp(values.reduce((total, value) => total + Math.log(value), 0) / values.length));

/** Tokens a run read and wrote: every kind of input, plus the output. */
export const tokensOf = (run) => run.usage.input + run.usage.output;

/** Model requests of a run: distinct API responses in its stream (a response arrives as several events). */
export const requestsOf = (run) => run.apiCalls ?? run.turns;

/** A small seeded generator (mulberry32), so a report's intervals are the same every time it is made from the same runs. */
export function seeded(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const resample = (values, random) => values.map(() => values[Math.floor(random() * values.length)]);

/** What the tool added to a run: its tokens minus the baseline's number for that task. Never below 1, so a ratio is defined. */
export const attributable = (tokens, baseline) => Math.max(tokens - baseline, 1);

/**
 * Runs grouped as `cells.get(tool).get(task)`: lists of {tokens, requests, cost, wallMs}, in the order they were made.
 * `baselineId` names the no-tool runs, which are not a competitor; their `tokens` is the input of their first request.
 */
export function groupRuns(runs, baselineId) {
  const cells = new Map();
  for (const run of runs) {
    if (!cells.has(run.tool)) cells.set(run.tool, new Map());
    const tasks = cells.get(run.tool);
    if (!tasks.has(run.task)) tasks.set(run.task, []);
    tasks.get(run.task).push({ tokens: run.tool === baselineId ? run.first.input : tokensOf(run), requests: requestsOf(run), cost: run.costUsd, wallMs: run.wallMs });
  }
  return cells;
}

export const METRICS = [
  { id: 'attributable', label: 'Tool-attributable tokens', of: (run, base) => attributable(run.tokens, base) },
  { id: 'requests', label: 'Model requests', of: (run) => run.requests },
  { id: 'tokens', label: 'Total tokens', of: (run) => run.tokens },
  { id: 'cost', label: 'Cost', of: (run) => run.cost },
  { id: 'time', label: 'Time', of: (run) => run.wallMs },
];

/** The median of a cell for a metric, with `base` the baseline's median tokens for the task. */
const cellMedian = (metric, cell, base) => median(cell.map((run) => metric.of(run, base)));

/**
 * For every tool other than `reference` and the baseline: per metric, the geometric mean over tasks of
 * (reference's median) / (tool's median), so below 1 means the reference used less, and a 90% bootstrap interval.
 * Each bootstrap pass resamples the runs of every cell (the baseline's too) with replacement, takes the medians and the
 * ratios again, and the interval is the 5th and 95th percentile of the geometric mean. A task counts for a tool only
 * when the reference and the tool both have runs on it (and, for the attributable metric, the baseline has too).
 */
export function headToHead({ runs, tools, reference, baselineId, iterations = 2000, seed = 20261127 }) {
  const cells = groupRuns(runs, baselineId);
  const baseCells = cells.get(baselineId) ?? new Map();
  const refCells = cells.get(reference) ?? new Map();
  const out = [];
  for (const tool of tools) {
    if (tool.id === reference || tool.id === baselineId) continue;
    const toolCells = cells.get(tool.id) ?? new Map();
    const shared = [...refCells.keys()].filter((task) => toolCells.has(task));
    const row = { tool: tool.id, tasks: shared.length, metrics: {} };
    for (const metric of METRICS) {
      const usable = metric.id === 'attributable' ? shared.filter((task) => baseCells.has(task)) : shared;
      if (usable.length === 0) continue;
      const point = usable.map((task) => {
        const base = median((baseCells.get(task) ?? []).map((run) => run.tokens)) ?? 0;
        return { task, ratio: cellMedian(metric, refCells.get(task), base) / cellMedian(metric, toolCells.get(task), base) };
      });
      const random = seeded(seed);
      const samples = [];
      for (let pass = 0; pass < iterations; pass += 1) {
        const ratios = usable.map((task) => {
          const base = median(resample((baseCells.get(task) ?? []).map((run) => run.tokens), random)) ?? 0;
          return cellMedian(metric, resample(refCells.get(task), random), base) / cellMedian(metric, resample(toolCells.get(task), random), base);
        });
        samples.push(geomean(ratios));
      }
      samples.sort((a, b) => a - b);
      row.metrics[metric.id] = {
        tasks: usable.length,
        geomean: geomean(point.map((entry) => entry.ratio)),
        low: samples[Math.floor(0.05 * (samples.length - 1))],
        high: samples[Math.ceil(0.95 * (samples.length - 1))],
        perTask: Object.fromEntries(point.map((entry) => [entry.task, entry.ratio])),
      };
    }
    out.push(row);
  }
  return out;
}

/** Median of every tool call's latency (the time between a call's request and its reply in the stream), over all of a tool's runs. */
export function medianToolLatency(runs) {
  return median(runs.flatMap((run) => run.toolMs ?? []));
}

/**
 * How long a run's tools were busy: the length of the union of its calls' spans (`[from, to]`, the call's event and its
 * reply's). Calls sent in one message run one after another, and each one's span includes the wait for those before it, so
 * time two spans share is counted once.
 */
export function busyMs(spans) {
  let total = 0;
  let open;
  for (const [from, to] of [...spans].sort((a, b) => a[0] - b[0])) {
    if (open === undefined || from > open[1]) {
      if (open !== undefined) total += open[1] - open[0];
      open = [from, to];
    } else {
      open[1] = Math.max(open[1], to);
    }
  }
  return open === undefined ? 0 : total + open[1] - open[0];
}

/** Median over a tool's runs of the time its tools were busy in a run; undefined for runs measured before it was recorded. */
export function medianToolBusy(runs) {
  return median(runs.map((run) => run.toolBusyMs).filter((ms) => Number.isFinite(ms)));
}
