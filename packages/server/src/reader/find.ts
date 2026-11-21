import { Worker } from 'node:worker_threads';

const CONTEXT_LINES = 1;
const MAX_MATCHES = 20;
export const MAX_QUERY_LENGTH = 200;
export const REGEX_TIMEOUT_MS = 500;

export interface FindOptions {
  /** Opt in to a regular expression. The default is a literal, case-insensitive search. */
  regex?: boolean | undefined;
  /** Bound for one regular-expression search. */
  timeoutMs?: number | undefined;
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
  const out: string[] = [];
  let previousEnd = -1;
  for (const index of shown) {
    const start = Math.max(0, index - CONTEXT_LINES);
    const end = Math.min(lines.length - 1, index + CONTEXT_LINES);
    if (previousEnd >= 0 && start > previousEnd + 1) out.push('--');
    for (let line = Math.max(start, previousEnd + 1); line <= end; line += 1) out.push(lines[line] ?? '');
    previousEnd = Math.max(previousEnd, end);
  }
  if (matching.length > shown.length) {
    out.push(`(${matching.length - shown.length} more matches; narrow the query)`);
  }
  return { text: out.join('\n'), matches: matching.length };
}

function literalMatches(lines: string[], query: string): number[] {
  const needle = query.toLowerCase();
  const matching: number[] = [];
  lines.forEach((line, index) => {
    if (line.toLowerCase().includes(needle)) matching.push(index);
  });
  return matching;
}

async function regexMatches(lines: string[], query: string, timeoutMs: number): Promise<number[]> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('The regex timeout must be positive');
  const worker = new Worker(REGEX_WORKER_SOURCE, {
    eval: true,
    workerData: { lines, query },
  });
  return await new Promise<number[]>((resolve, reject) => {
    let settled = false;
    const finish = (error: Error | undefined, matches?: number[]): void => {
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
        finish(undefined, (value as { matches: number[] }).matches);
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
    if (pattern.test(line)) matches.push(index);
  });
  parentPort.postMessage({ ok: true, matches });
} catch (error) {
  parentPort.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) });
}
`;
