// The markdown report of a comparison run, and the tools that can only be measured by definition.
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { estimateTokens } from '../report.mjs';
import { TASKS, TASK_TITLES } from './adapters.mjs';
import { connectServer, kill, listenerOf } from './lib.mjs';

const BASE = 't3tab';

const total = (task) => task.callTokens + task.replyTokens + task.imageTokens;
const fmt = (value) => value.toLocaleString('en-US');
const seconds = (ms) => (ms / 1000).toFixed(2);
const ratio = (value, base) => (base === 0 ? '–' : `${(value / base).toFixed(2)}x`);

/** The tables of a results object (without the replies). */
export function markdown(results) {
  const tools = results.tools.filter((tool) => tool.error === undefined);
  const failed = results.tools.filter((tool) => tool.error !== undefined);
  const base = tools.find((tool) => tool.id === BASE);
  const lines = [];

  lines.push('### Tool definitions (`tools/list`)', '', '| Tool | Version | Tools | Characters | Tokens |', '| --- | --- | ---: | ---: | ---: |');
  for (const tool of tools) {
    lines.push(`| ${tool.label} | ${tool.version} | ${tool.definitions.count} | ${fmt(tool.definitions.chars)} | ${fmt(tool.definitions.tokens)} |`);
  }
  for (const item of results.definitionOnly) {
    lines.push(`| ${item.label} (definitions only: ${item.how}) | ${item.version} | ${item.count} | ${fmt(item.chars)} | ${fmt(item.tokens)} |`);
  }

  lines.push('', '### Per task: calls, tokens sent to the agent, wall time, end state reached', '');
  lines.push(
    '`Tokens` is the agent\'s calls plus the replies plus images. `Reached` is checked on the page itself (or, for the search and screenshot tasks, on what the agent was sent).',
    '',
  );
  for (const task of TASKS) {
    lines.push(`#### ${TASK_TITLES[task]} (\`${task}\`)`, '');
    lines.push('| Tool | Calls | Tokens | vs T3-Tab | Time (s) | vs T3-Tab | Reached |', '| --- | ---: | ---: | ---: | ---: | ---: | :---: |');
    for (const tool of tools) {
      const row = tool.tasks[task];
      const against = base?.tasks[task];
      const variation = row.variation;
      const spread = variation !== undefined && variation.runs > 1 ? ` (${seconds(variation.msMin)}–${seconds(variation.msMax)})` : '';
      lines.push(
        `| ${tool.label} | ${row.calls} | ${fmt(total(row))} | ${against === undefined ? '–' : ratio(total(row), total(against))} | ${seconds(row.ms)}${spread} | ${against === undefined ? '–' : ratio(row.ms, against.ms)} | ${row.ok ? 'yes' : `**no**${row.error === undefined ? '' : `: ${row.error.split('\n')[0].slice(0, 80)}`}`} |`,
      );
    }
    lines.push('');
  }

  lines.push('### All four tasks of `pnpm bench` together (form, hidden, navigate, long)', '');
  lines.push('| Tool | Calls | Tokens | vs T3-Tab | Time (s) | vs T3-Tab | Tasks reached |', '| --- | ---: | ---: | ---: | ---: | ---: | :---: |');
  const core = ['form', 'hidden', 'navigate', 'long'];
  const sumOf = (tool, pick) => core.reduce((acc, task) => acc + pick(tool.tasks[task]), 0);
  for (const tool of tools) {
    const calls = sumOf(tool, (task) => task.calls);
    const tokens = sumOf(tool, total);
    const ms = sumOf(tool, (task) => task.ms);
    const reached = core.filter((task) => tool.tasks[task].ok).length;
    lines.push(
      `| ${tool.label} | ${calls} | ${fmt(tokens)} | ${base === undefined ? '–' : ratio(tokens, sumOf(base, total))} | ${seconds(ms)} | ${base === undefined ? '–' : ratio(ms, sumOf(base, (task) => task.ms))} | ${reached}/4 |`,
    );
  }

  const shots = tools.flatMap((tool) => (tool.tasks.screenshot?.steps ?? []).filter((step) => step.image !== undefined).map((step) => ({ tool, image: step.image })));
  if (shots.length > 0) {
    lines.push('', '### Screenshots', '', '| Tool | Size | Type | Bytes | Estimated image tokens |', '| --- | --- | --- | ---: | ---: |');
    for (const { tool, image } of shots) {
      lines.push(`| ${tool.label} | ${image.width ?? '?'}x${image.height ?? '?'} | ${image.mime} | ${fmt(image.bytes)} | ${fmt(image.tokens)} |`);
    }
  }

  if (failed.length > 0) {
    lines.push('', '### Could not run', '');
    for (const tool of failed) lines.push(`- ${tool.label}: ${tool.error.split('\n')[0]}`);
  }
  const runs = results.environment.runs;
  const variation = variationSummary(tools);
  if (variation !== undefined) lines.push('', variation);
  lines.push(
    '',
    `Measured on Chromium ${results.environment.chromium}, Node ${results.environment.node}, ${runs} run${runs === 1 ? '' : 's'}. ${results.tokenEstimate}`,
  );
  return lines.join('\n');
}

/** Tools that cannot be driven headless here or are proprietary: the size of what the agent is given, where it can be read. */
export async function measureDefinitionOnly(root) {
  const found = [];
  const browserMcp = await browserMcpDefinitions(root).catch(() => undefined);
  if (browserMcp !== undefined) found.push(browserMcp);
  const codex = await codexPluginSchema().catch(() => undefined);
  if (codex !== undefined) found.push(codex);
  return found;
}

/** Browser MCP lists its tool without a browser; driving it needs its Chrome Web Store extension, which a headless run cannot install. */
async function browserMcpDefinitions(root) {
  const dir = await mkdtemp(join(tmpdir(), 'cmp-bm-'));
  const portWasFree = (await listenerOf(9010)) === undefined;
  let session;
  try {
    session = await connectServer({
      command: join(root, 'node_modules', '.bin', 'mcp-server-browsermcp'),
      args: [],
      env: { HOME: dir },
      cwd: dir,
    });
    const listed = (await session.client.listTools()).tools;
    const json = JSON.stringify(listed);
    const manifest = JSON.parse(await readFile(join(root, 'node_modules', '@browsermcp', 'mcp', 'package.json'), 'utf8'));
    return {
      label: 'Browser MCP',
      version: manifest.version,
      how: 'needs its Chrome Web Store extension, not run',
      count: listed.length,
      chars: json.length,
      tokens: estimateTokens(json),
    };
  } finally {
    await session?.client.close().catch(() => undefined);
    const daemon = await listenerOf(9010);
    if (portWasFree && daemon !== undefined) kill(daemon);
    await rm(dir, { recursive: true, force: true });
  }
}

/** The ChatGPT/Codex Chrome plugin has one REPL tool; what ships on disk is its API schema, which the agent reads on demand. */
async function codexPluginSchema() {
  const base = join(homedir(), '.codex', 'plugins', 'cache', 'openai-bundled', 'chrome');
  const manifest = JSON.parse(await readFile(join(base, 'latest', '.codex-plugin', 'plugin.json'), 'utf8'));
  const text = await readFile(join(base, 'latest', 'docs', 'api.json'), 'utf8');
  return {
    label: 'Codex Chrome plugin',
    version: manifest.version ?? 'cache',
    how: 'API schema file the plugin ships (`docs/api.json`), read on demand; its REPL tool definition is not on disk; proprietary, not run',
    count: 1,
    chars: text.length,
    tokens: estimateTokens(text),
  };
}

/**
 * How far the repeated runs moved. Token counts move by a few tokens because the page server's port and
 * a tool's temporary file names are different each run and tokenise differently; calls and results should not move.
 */
function variationSummary(tools) {
  const rows = tools.flatMap((tool) => Object.entries(tool.tasks).map(([task, row]) => ({ tool, task, v: row.variation })));
  if (rows.length === 0 || rows[0].v === undefined || rows[0].v.runs < 2) return undefined;
  const tokenSpreads = rows.map(({ v }) => v.tokensMax - v.tokensMin);
  const relative = rows.map(({ v }) => (v.tokensMax - v.tokensMin) / v.tokensMax);
  const timeSpreads = rows.map(({ v }) => v.msMax - v.msMin);
  const worstTime = rows[timeSpreads.indexOf(Math.max(...timeSpreads))];
  const callsMoved = rows.filter(({ v }) => !v.callsEqual);
  const failed = rows.filter(({ v }) => !v.okInEveryRun);
  const label = ({ tool, task }) => `${tool.label}/${task}`;
  return [
    `Across ${rows[0].v.runs} runs: tokens differed by at most ${Math.max(...tokenSpreads)} (${(Math.max(...relative) * 100).toFixed(1)}%) in a task`,
    callsMoved.length === 0 ? ', call counts never changed' : `, call counts changed in ${callsMoved.map(label).join(', ')}`,
    `, time differed by at most ${Math.max(...timeSpreads)} ms in a task (${label(worstTime)})`,
    failed.length === 0 ? '; every task reached its end state in every run.' : `; not reached in every run: ${failed.map(label).join(', ')}.`,
  ].join('');
}
