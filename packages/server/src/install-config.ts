import { tomlString } from './toml.js';

export interface McpCommand {
  command: string;
  args: string[];
}

export const CLAUDE_SERVER_NAME = 't3-tab';
export const CODEX_SERVER_NAME = 't3-tab';
/**
 * How long Codex waits for one T3-Tab tool call. Its default is 60 seconds and a browser prompt waits up to 300, so the
 * entry sets 330, as direct runs do (`agents/commands.ts`): longer than T3-Tab's own 310-second wait, so its error comes first.
 */
export const CODEX_TOOL_TIMEOUT_SEC = 330;

export function addClaudeServer(source: string, server: McpCommand): string {
  const config = parseClaudeConfig(source);
  const mcpServers = ensureMcpServers(config);
  mcpServers[CLAUDE_SERVER_NAME] = {
    type: 'stdio',
    command: server.command,
    args: server.args,
    env: {},
  };
  return `${JSON.stringify(config, null, 2)}\n`;
}

export function removeClaudeServer(source: string): string {
  const config = parseClaudeConfig(source);
  const mcpServers = config.mcpServers;
  if (!isRecord(mcpServers) || !Object.hasOwn(mcpServers, CLAUDE_SERVER_NAME)) return source;
  delete mcpServers[CLAUDE_SERVER_NAME];
  return `${JSON.stringify(config, null, 2)}\n`;
}

export function addCodexServer(source: string, server: McpCommand): string {
  const block = codexServerBlock(server);
  const range = findCodexServerRange(source);
  if (range === undefined) return appendCodexServer(source, block);
  const before = ensureBlankLineBefore(source.slice(0, range.start));
  const after = removeCodexServer(source.slice(range.end));
  return `${before}${block}${ensureBlankLineAfter(after)}`;
}

/**
 * Adds `tool_timeout_sec` to the `t3-tab` table `codex mcp add` wrote, after its last key, and changes nothing else. A
 * table that already has the key, or no table, comes back as it was.
 */
export function ensureCodexToolTimeout(source: string): string {
  const range = findCodexServerRange(source);
  if (range === undefined) return source;
  let inMain = false;
  let insertAt: number | undefined;
  for (const line of linesWithOffsets(source.slice(range.start, range.end))) {
    const key = tableKey(line.text);
    if (key !== undefined) {
      if (inMain) break;
      inMain = key.replace(/["'\s]/g, '') === `mcp_servers.${CODEX_SERVER_NAME}`;
      if (inMain) insertAt = range.start + line.start + line.text.length;
    } else if (inMain) {
      const text = line.text.trim();
      if (/^tool_timeout_sec\s*=/.test(text)) return source;
      if (text !== '' && !text.startsWith('#')) insertAt = range.start + line.start + line.text.length;
    }
  }
  if (insertAt === undefined) return source;
  const before = source.slice(0, insertAt);
  return `${before}${before.endsWith('\n') ? '' : '\n'}tool_timeout_sec = ${CODEX_TOOL_TIMEOUT_SEC}\n${source.slice(insertAt)}`;
}

export function removeCodexServer(source: string): string {
  let current = source;
  for (;;) {
    const range = findCodexServerRange(current);
    if (range === undefined) return current;
    const before = current.slice(0, range.start);
    const after = current.slice(range.end);
    current = after.length === 0 ? before.replace(/\n\n$/, '\n') : `${before}${after}`;
  }
}

function codexServerBlock(server: McpCommand): string {
  const args = server.args.map(tomlString).join(', ');
  return `[mcp_servers.${CODEX_SERVER_NAME}]\ncommand = ${tomlString(server.command)}\nargs = [${args}]\ntool_timeout_sec = ${CODEX_TOOL_TIMEOUT_SEC}\n`;
}

export function parseClaudeConfig(source: string): Record<string, unknown> {
  const parsed: unknown = source.trim() === '' ? {} : JSON.parse(source);
  if (!isRecord(parsed)) throw new Error('Claude Code config must contain a JSON object');
  return parsed;
}

function ensureMcpServers(config: Record<string, unknown>): Record<string, unknown> {
  const existing = config.mcpServers;
  if (existing === undefined) {
    const created: Record<string, unknown> = {};
    config.mcpServers = created;
    return created;
  }
  if (!isRecord(existing)) throw new Error('mcpServers must be an object');
  return existing;
}

export function findCodexServerRange(source: string): { start: number; end: number } | undefined {
  const lines = linesWithOffsets(source);
  const first = lines.findIndex((line) => {
    const key = tableKey(line.text);
    return key !== undefined && isT3TabHeader(key);
  });
  if (first === -1) return undefined;

  let boundary = lines.length;
  for (let index = first + 1; index < lines.length; index += 1) {
    const key = tableKey(lines[index]?.text ?? '');
    if (key !== undefined && !isT3TabHeader(key)) {
      boundary = index;
      while (boundary > first + 1 && (lines[boundary - 1]?.text.trimStart().startsWith('#') ?? false)) {
        boundary -= 1;
      }
      break;
    }
  }

  let start = first;
  while (start > 0 && (lines[start - 1]?.text.trimStart().startsWith('#') ?? false)) {
    start -= 1;
  }

  return {
    start: lines[start]?.start ?? 0,
    end: boundary < lines.length ? (lines[boundary]?.start ?? source.length) : source.length,
  };
}

function appendCodexServer(source: string, block: string): string {
  if (source === '') return block;
  return `${ensureBlankLineBefore(source)}${block}`;
}

function ensureBlankLineBefore(value: string): string {
  if (value === '') return '';
  if (value.endsWith('\n\n')) return value;
  return value.endsWith('\n') ? `${value}\n` : `${value}\n\n`;
}

function ensureBlankLineAfter(value: string): string {
  if (value === '') return '';
  return value.startsWith('\n') ? value : `\n${value}`;
}

function linesWithOffsets(source: string): Array<{ text: string; start: number }> {
  const lines: Array<{ text: string; start: number }> = [];
  let start = 0;
  while (start < source.length) {
    const newline = source.indexOf('\n', start);
    const end = newline === -1 ? source.length : newline + 1;
    lines.push({ text: source.slice(start, end), start });
    start = end;
  }
  return lines;
}

function tableKey(line: string): string | undefined {
  const trimmed = line.trimStart();
  if (!trimmed.startsWith('[') || trimmed.startsWith('[[')) return undefined;
  let quote: '"' | "'" | undefined;
  let escaped = false;
  for (let index = 1; index < trimmed.length; index += 1) {
    const character = trimmed[index];
    if (quote === '"') {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote) quote = undefined;
    } else if (quote === "'") {
      if (character === quote) quote = undefined;
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === ']') {
      return trimmed.slice(1, index).trim();
    } else if (character === '#') {
      return undefined;
    }
  }
  return undefined;
}

function isT3TabHeader(key: string): boolean {
  return /^(?:"mcp_servers"|'mcp_servers'|mcp_servers)\s*\.\s*(?:"t3-tab"|'t3-tab'|t3-tab)(?:\s*\.|$)/.test(
    key,
  );
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
