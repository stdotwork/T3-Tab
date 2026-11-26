// One headless Claude Code run with exactly one MCP server and no built-in tools, and the numbers read from its
// stream-json output. Claude Code runs with a temporary HOME and XDG folders; the model route is the proxy the
// caller's environment names (ANTHROPIC_BASE_URL and ANTHROPIC_AUTH_TOKEN, as e2e/panel-flow.mjs's Haiku runs
// use), so nothing in the machine's own ~/.claude or ~/.config is read or written.
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** The `claude` binary itself. The mise wrapper on PATH hangs without a terminal, so use the real file. */
export const CLAUDE_BIN = process.env.T3_TAB_AGENT_CLAUDE ?? process.env.CLAUDE_CODE_EXECPATH ?? 'claude';

/** The environment of the Claude Code process: the caller's, without its agent sessions, under a new HOME. */
export function claudeEnv(dir, mark) {
  const base = Object.fromEntries(
    Object.entries(process.env).filter(([key, value]) => value !== undefined && !/^(CLAUDE|CODEX|T3CODE_|T3_TAB_|OMARCHY_AGENT|AI_AGENT)/.test(key) && key !== 'CLAUDECODE'),
  );
  return {
    ...base,
    HOME: dir,
    XDG_CONFIG_HOME: join(dir, '.config'),
    XDG_DATA_HOME: join(dir, '.local', 'share'),
    XDG_STATE_HOME: join(dir, '.local', 'state'),
    XDG_CACHE_HOME: join(dir, '.cache'),
    // Every tool definition goes to the model up front, as an MCP client that does not defer them sends them.
    ENABLE_TOOL_SEARCH: 'false',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_AUTOUPDATER: '1',
    T3TAB_AGENT_RUN: mark,
  };
}

export const PROMPT = (goal, hint) =>
  [
    'You control a web browser through the tools you have been given. Do the task below on the local test site.',
    '',
    `Task: ${goal}`,
    ...(hint === undefined ? [] : ['', hint]),
    '',
    'When you have finished, reply with one line: `DONE: <answer>` (write `DONE: done` if the task asks for no answer). Do not ask me questions.',
  ].join('\n');

/**
 * Runs Claude Code once. `maxTurns` and `timeoutMs` only stop a run that is stuck; a run they stop is a failure.
 * Returns the parsed stream and the numbers that go in the results.
 */
export async function runClaude({ dir, model, prompt, serverName, mcpEntry, env, transcriptFile, maxTurns, timeoutMs }) {
  const work = join(dir, 'work');
  await mkdir(work, { recursive: true });
  const mcpConfig = join(dir, 'mcp.json');
  await writeFile(mcpConfig, JSON.stringify({ mcpServers: { [serverName]: { type: 'stdio', command: mcpEntry.command, args: mcpEntry.args, env: mcpEntry.env } } }, null, 2));
  const args = [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--model', model,
    '--tools', '',
    '--strict-mcp-config',
    '--mcp-config', mcpConfig,
    '--allowedTools', `mcp__${serverName}`,
    '--permission-mode', 'dontAsk',
    '--setting-sources', '',
    '--disable-slash-commands',
    '--no-session-persistence',
    '--max-turns', String(maxTurns),
  ];
  const started = Date.now();
  const child = spawn(CLAUDE_BIN, args, { cwd: work, env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
  const lines = [];
  const stderr = [];
  let buffer = '';
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      lines.push(buffer.slice(0, index));
      buffer = buffer.slice(index + 1);
    }
  });
  child.stderr.on('data', (chunk) => stderr.push(String(chunk)));
  child.stdin.end(prompt);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    killGroup(child.pid);
  }, timeoutMs);
  const code = await new Promise((resolve) => child.once('close', resolve));
  clearTimeout(timer);
  killGroup(child.pid);
  if (buffer.trim() !== '') lines.push(buffer);
  const wallMs = Date.now() - started;
  await writeFile(transcriptFile, `${lines.join('\n')}\n`);
  return { ...parseStream(lines), wallMs, exitCode: code, timedOut, stderr: stderr.join('').slice(-2000) };
}

function killGroup(pid) {
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    // Already gone.
  }
}

/** The numbers of a run, from its stream-json lines. */
export function parseStream(lines) {
  const events = [];
  for (const line of lines) {
    try {
      events.push(JSON.parse(line));
    } catch {
      // A partial line from a killed run.
    }
  }
  const init = events.find((event) => event.type === 'system' && event.subtype === 'init');
  const result = events.findLast((event) => event.type === 'result');
  // One API response can arrive as several assistant events (one per content block) with one message id and one usage.
  const calls = new Map();
  const toolCalls = [];
  const toolResults = new Map();
  for (const event of events) {
    if (event.type === 'assistant') {
      const message = event.message;
      if (!calls.has(message.id)) calls.set(message.id, { usage: message.usage, model: message.model, order: calls.size });
      for (const block of message.content ?? []) {
        if (block.type === 'tool_use') toolCalls.push({ id: block.id, name: block.name, input: block.input, order: calls.get(message.id).order });
      }
    } else if (event.type === 'user') {
      for (const block of event.message?.content ?? []) {
        if (block.type === 'tool_result') toolResults.set(block.tool_use_id, { error: block.is_error === true, content: block.content });
      }
    }
  }
  const usageOf = (usage) => ({
    uncached: usage?.input_tokens ?? 0,
    cacheRead: usage?.cache_read_input_tokens ?? 0,
    cacheWrite: usage?.cache_creation_input_tokens ?? 0,
    output: usage?.output_tokens ?? 0,
  });
  const perCall = [...calls.values()].map((call) => usageOf(call.usage));
  const total = result?.usage === undefined ? perCall.reduce((sum, call) => addUsage(sum, call), usageOf()) : usageOf(result.usage);
  const first = perCall[0] ?? usageOf();
  const mcpServers = init?.mcp_servers ?? [];
  return {
    init: init === undefined ? undefined : { tools: init.tools, mcpServers, model: init.model },
    finished: result !== undefined,
    isError: result?.is_error === true || result?.subtype !== 'success',
    subtype: result?.subtype,
    terminalReason: result?.terminal_reason,
    answer: typeof result?.result === 'string' ? result.result : '',
    turns: result?.num_turns ?? calls.size,
    apiCalls: calls.size,
    toolCalls: toolCalls.length,
    toolErrors: toolCalls.filter((call) => toolResults.get(call.id)?.error === true).length,
    toolNames: toolCalls.map((call) => call.name),
    usage: { ...total, input: total.uncached + total.cacheRead + total.cacheWrite },
    first: { ...first, input: first.uncached + first.cacheRead + first.cacheWrite },
    perCallUsage: perCall,
    costUsd: result?.total_cost_usd ?? 0,
    apiMs: result?.duration_api_ms,
  };
}

function addUsage(sum, usage) {
  return { uncached: sum.uncached + usage.uncached, cacheRead: sum.cacheRead + usage.cacheRead, cacheWrite: sum.cacheWrite + usage.cacheWrite, output: sum.output + usage.output };
}
