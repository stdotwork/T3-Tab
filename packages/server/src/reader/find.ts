import { Worker } from 'node:worker_threads';

const CONTEXT_LINES = 1;
const MAX_MATCHES = 20;
export const MAX_QUERY_LENGTH = 200;
const REGEX_TIMEOUT_MS = 500;
/** Characters of a long line kept on each side of its match. */
const MATCH_WINDOW = 120;
/** Longest matching line printed whole. */
const MAX_LINE = 320;
/** Longest context line printed whole; a longer one (a paragraph beside the match) keeps its start. */
const MAX_CONTEXT = 120;

export interface FindOptions {
  /** Opt in to a regular expression. The default is a literal, case-insensitive search. */
  regex?: boolean | undefined;
  /** Bound for one regular-expression search. */
  timeoutMs?: number | undefined;
  /**
   * The lines as printed beside a match, when `lines` (searched, and printed where they match) hold more: the
   * addresses of the links written into text, which a read prints only where a name is ambiguous.
   */
  context?: string[] | undefined;
}

/** Where a line first matched. */
interface LineMatch {
  line: number;
  start: number;
  length: number;
}

export interface FindResult {
  text: string;
  matches: number;
}

/**
 * The lines of a read that match `query`, each with a little context. Literal matching is the
 * default. A regular expression runs in a worker that is terminated at the timeout, so a hostile
 * or accidental backtracking pattern cannot stall the shared daemon.
 */
export async function findLines(lines: string[], query: string, options: FindOptions = {}): Promise<FindResult> {
  if (query.length > MAX_QUERY_LENGTH) {
    throw new Error(`Find query is too long (${query.length} characters; maximum ${MAX_QUERY_LENGTH}).`);
  }
  const matching = options.regex === true
    ? await regexMatches(lines, query, options.timeoutMs ?? REGEX_TIMEOUT_MS)
    : literalMatches(lines, query);
  if (matching.length === 0) return { text: `No matches for ${JSON.stringify(query)}.`, matches: 0 };

  const shown = matching.slice(0, MAX_MATCHES);
  const matchAt = new Map(shown.map((match) => [match.line, match]));
  const out: string[] = [];
  let previousEnd = -1;
  for (const { line: index } of shown) {
    const start = Math.max(0, index - CONTEXT_LINES);
    const end = Math.min(lines.length - 1, index + CONTEXT_LINES);
    if (previousEnd >= 0 && start > previousEnd + 1) out.push('--');
    for (let line = Math.max(start, previousEnd + 1); line <= end; line += 1) {
      const match = matchAt.get(line);
      out.push(clipLine((match === undefined ? options.context?.[line] : undefined) ?? lines[line] ?? '', match));
    }
    previousEnd = Math.max(previousEnd, end);
  }
  if (matching.length > shown.length) {
    out.push(`(${matching.length - shown.length} more matches; narrow the query)`);
  }
  return { text: out.join('\n'), matches: matching.length };
}

/** A line short enough to print: around its match, or from its start for a context line. Every cut is marked. */
function clipLine(line: string, match: LineMatch | undefined): string {
  const indent = line.length - line.trimStart().length;
  if (line.length - indent <= (match === undefined ? MAX_CONTEXT : MAX_LINE)) return line;
  const from = match === undefined ? indent : Math.max(indent, match.start - MATCH_WINDOW);
  const to = match === undefined ? indent + MAX_CONTEXT : Math.min(line.length, match.start + match.length + MATCH_WINDOW);
  return `${line.slice(0, indent)}${from > indent ? '…' : ''}${line.slice(from, to)}${to < line.length ? '…' : ''}`;
}

function literalMatches(lines: string[], query: string): LineMatch[] {
  const needle = query.toLowerCase();
  const matching: LineMatch[] = [];
  lines.forEach((line, index) => {
    const start = line.toLowerCase().indexOf(needle);
    if (start >= 0) matching.push({ line: index, start, length: needle.length });
  });
  return matching;
}

async function regexMatches(lines: string[], query: string, timeoutMs: number): Promise<LineMatch[]> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('The regex timeout must be positive');
  const worker = new Worker(REGEX_WORKER_SOURCE, {
    eval: true,
    workerData: { lines, query },
  });
  return await new Promise<LineMatch[]>((resolve, reject) => {
    let settled = false;
    const finish = (error: Error | undefined, matches?: LineMatch[]): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error !== undefined) {
        void worker.terminate();
        reject(error);
      } else {
        resolve(matches ?? []);
      }
    };
    const timer = setTimeout(() => {
      finish(new Error(`Find regex timed out after ${timeoutMs} ms. Use a literal find or a narrower regex.`));
    }, timeoutMs);
    worker.once('message', (value: unknown) => {
      if (
        typeof value === 'object' &&
        value !== null &&
        (value as { ok?: unknown }).ok === true &&
        Array.isArray((value as { matches?: unknown }).matches)
      ) {
        finish(undefined, (value as { matches: LineMatch[] }).matches);
        return;
      }
      const error = (value as { error?: unknown } | null)?.error;
      finish(new Error(typeof error === 'string' ? `Invalid find regex: ${error}` : 'Invalid find regex'));
    });
    worker.once('error', (error) => finish(error instanceof Error ? error : new Error(String(error))));
    worker.once('exit', (code) => {
      if (code !== 0) finish(new Error(`Find regex worker stopped with code ${code}`));
    });
  });
}

const REGEX_WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
try {
  const pattern = new RegExp(workerData.query, 'i');
  const matches = [];
  workerData.lines.forEach((line, index) => {
    const found = pattern.exec(line);
    if (found !== null) matches.push({ line: index, start: found.index, length: found[0].length });
  });
  parentPort.postMessage({ ok: true, matches });
} catch (error) {
  parentPort.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) });
}
`;
