import { describe, expect, it } from 'vitest';

import { parseStream } from './claude.mjs';
import { markdown } from './report.mjs';
import { attributable, busyMs, geomean, headToHead, median, medianToolBusy, medianToolLatency, seeded } from './stats.mjs';

const run = (tool, task, tokens, requests, extra = {}) => ({
  tool,
  task,
  rep: 1,
  ok: true,
  usage: { input: tokens - 100, output: 100 },
  first: { input: tool === 'none' ? tokens : 1 },
  apiCalls: requests,
  turns: requests,
  toolCalls: requests - 1,
  toolErrors: 0,
  costUsd: tokens / 1e6,
  wallMs: 1000 * requests,
  ...extra,
});

describe('agent benchmark statistics', () => {
  it('takes medians, geometric means and a fixed random sequence', () => {
    expect(median([5, 1, 3])).toBe(3);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    expect(median([])).toBeUndefined();
    expect(geomean([2, 8])).toBeCloseTo(4);
    const a = seeded(7);
    const b = seeded(7);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });

  it('subtracts the baseline and never goes below one', () => {
    expect(attributable(1500, 1000)).toBe(500);
    expect(attributable(900, 1000)).toBe(1);
  });

  const tools = [{ id: 'none', baseline: true }, { id: 't3tab' }, { id: 'other' }];
  // Two tasks; the baseline costs 1,000 tokens in both. T3-Tab adds 500 and 1,000, the other tool 1,000 and 4,000.
  const runs = [1, 2, 3].flatMap(() => [
    run('none', 'a', 1000, 1),
    run('none', 'b', 1000, 1),
    run('t3tab', 'a', 1500, 3),
    run('t3tab', 'b', 2000, 4),
    run('other', 'a', 2000, 6),
    run('other', 'b', 5000, 8),
  ]);

  it('compares tools by the geometric mean of per-task ratios against the reference', () => {
    const [row] = headToHead({ runs, tools, reference: 't3tab', baselineId: 'none', iterations: 200 });
    expect(row.tool).toBe('other');
    expect(row.tasks).toBe(2);
    // Tool-attributable tokens: T3-Tab / other is 500/1000 and 1000/4000.
    expect(row.metrics.attributable.geomean).toBeCloseTo(Math.sqrt((500 / 1000) * (1000 / 4000)));
    expect(row.metrics.attributable.perTask).toEqual({ a: 0.5, b: 0.25 });
    expect(row.metrics.requests.geomean).toBeCloseTo(Math.sqrt((3 / 6) * (4 / 8)));
    // Every repeat is identical, so a resample cannot move the interval.
    expect(row.metrics.attributable.low).toBeCloseTo(row.metrics.attributable.geomean);
    expect(row.metrics.attributable.high).toBeCloseTo(row.metrics.attributable.geomean);
  });

  it('gives an interval that holds the estimate when the repeats differ, the same way every time', () => {
    const noisy = runs.map((entry, index) => (entry.tool === 'other' && entry.task === 'a' ? run('other', 'a', 1800 + 200 * (index % 3), 6) : entry));
    const first = headToHead({ runs: noisy, tools, reference: 't3tab', baselineId: 'none', iterations: 300 })[0].metrics.attributable;
    const again = headToHead({ runs: noisy, tools, reference: 't3tab', baselineId: 'none', iterations: 300 })[0].metrics.attributable;
    expect(first).toEqual(again);
    expect(first.low).toBeLessThanOrEqual(first.geomean);
    expect(first.high).toBeGreaterThanOrEqual(first.geomean);
  });

  it('leaves attributable tokens out when there are no baseline runs', () => {
    const [row] = headToHead({ runs: runs.filter((entry) => entry.tool !== 'none'), tools, reference: 't3tab', baselineId: 'none', iterations: 50 });
    expect(row.metrics.attributable).toBeUndefined();
    expect(row.metrics.tokens.geomean).toBeGreaterThan(0);
  });

  it('takes the median tool latency over every call of every run', () => {
    expect(medianToolLatency([{ toolMs: [100, 300] }, { toolMs: [200] }, {}])).toBe(200);
  });

  it('counts the time calls share once in a run\'s tool-busy time', () => {
    expect(busyMs([])).toBe(0);
    // Two calls of one message (the second waits for the first), then a call of its own after a gap.
    expect(busyMs([[1_000, 1_100], [1_000, 1_250], [2_000, 2_040]])).toBe(290);
    expect(busyMs([[50, 60], [0, 20], [10, 30]])).toBe(40);
    // A run recorded before tool-busy time was is left out of the median, not counted as 0.
    expect(medianToolBusy([{ toolBusyMs: 300 }, { toolBusyMs: 100 }, { toolBusyMs: 200 }, {}])).toBe(200);
  });

  it('reads a run\'s call latencies and tool-busy time from the stream\'s timestamps', () => {
    const at = (ms) => new Date(Date.UTC(2026, 10, 27, 12, 0, 0, ms)).toISOString();
    const use = (id, ms, message) => ({ type: 'assistant', timestamp: at(ms), message: { id: message, content: [{ type: 'tool_use', id, name: 'mcp__t3-tab__read', input: {} }] } });
    const reply = (id, ms) => ({ type: 'user', timestamp: at(ms), message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } });
    const lines = [use('a', 0, 'm1'), use('b', 0, 'm1'), reply('a', 100), reply('b', 250), use('c', 900, 'm2'), reply('c', 960), use('d', 1_000, 'm3')].map((event) => JSON.stringify(event));
    const parsed = parseStream(lines);
    expect(parsed.toolMs).toEqual([100, 250, 60]);
    expect(parsed.toolBusyMs).toBe(310);
  });

  it('writes the tables, with the baseline kept out of the tool rows and a flaky task marked', () => {
    const text = markdown({
      // A baseline run that never finished (a stalled request) is left out: it would raise the baseline to 99,999 tokens.
      runs: [...runs, run('none', 'a', 99_999, 1, { baseline: true, finished: false }), ...runs.filter((entry) => entry.tool === 'none').map((entry) => ({ ...entry, baseline: true, finished: true }))],
      tools: [
        { id: 'none', label: 'No tools (baseline)', baseline: true },
        { id: 't3tab', label: 'T3-Tab' },
        { id: 'other', label: 'Other' },
      ],
      tasks: [{ id: 'a', title: 'Task A', flaky: 'its site timed out twice' }, { id: 'b', title: 'Task B' }],
      model: 'm',
      sites: 'real',
    });
    expect(text).toContain('held-out public-site tasks');
    expect(text).toContain('| Other | 6/6 | 0.35x'); // sqrt(0.5 x 0.25) = 0.354
    // These runs carry no tool-busy time; their wall time is 1 s a request, a median of 3.5 s for T3-Tab and 7 s for Other.
    expect(text).toContain('Median tool-busy time per run (s) | Median wall time per run (s) |');
    expect(text).toMatch(/\| T3-Tab \(reference\) \|.*\| - \| 3\.5 \|\n/);
    expect(text).toMatch(/\| Other \| 6\/6 \|.*\| - \| 7\.0 \|\n/);
    expect(text).toContain('flaky: its site timed out twice');
    expect(text).toContain('### No-tool baseline');
    expect(text).not.toMatch(/\| No tools \(baseline\) \| 6 \| 6\/6/);
  });
});
