import { Worker } from 'node:worker_threads';

const MAX_MATCHES = 20;
export const MAX_QUERY_LENGTH = 200;
const REGEX_TIMEOUT_MS = 500;
/** Characters of a long line kept on each side of its match. */
const MATCH_WINDOW = 80;
/** Longest matching line printed whole. */
const MAX_LINE = 200;
/** Longest context line printed whole; a longer one (a paragraph) keeps its start. */
const MAX_CONTEXT = 120;
/**
 * A match shorter than this (a price, a label, a button) keeps the line before it, which says whose it is. A longer
 * one (prose) stands alone.
 */
const SHORT_MATCH = 100;

/** One line of a read, as `find` searches and prints it. */
export interface FindLine {
  /** The line as a read prints it. */
  line: string;
  /**
   * The line with the address of every link on it, when that differs from `line`: searched as well. A text line
   * prints it only when the query matched in an address; an element's own line always does, so a link found by name
   * says where it goes.
   */
  search?: string | undefined;
  /** Plain text, not an element or a heading. */
  text?: boolean | undefined;
}

export interface FindOptions {
  /** Opt in to a regular expression. The default is a literal, case-insensitive search. */
  regex?: boolean | undefined;
  /** Bound for one regular-expression search. */
  timeoutMs?: number | undefined;
}

/** Where a line first matched, and in which of its forms. */
interface LineMatch {
  line: number;
  /** Index into the line's forms (`forms`): the one printed. */
  form: number;
  start: number;
  length: number;
}

export interface FindResult {
  text: string;
  matches: number;
}

/**
 * The lines of a read that match `query`, and nothing else: a short match also keeps the line before it, which says
 * whose it is. Literal matching is the default. A regular expression runs in a worker that is terminated at the
 * timeout, so a hostile or accidental backtracking pattern cannot stall the shared daemon.
 */
export async function findLines(lines: ReadonlyArray<string | FindLine>, query: string, options: FindOptions = {}): Promise<FindResult> {
  if (query.length > MAX_QUERY_LENGTH) {
    throw new Error(`Find query is too long (${query.length} characters; maximum ${MAX_QUERY_LENGTH}).`);
  }
  const entries = lines.map((item): FindLine => (typeof item === 'string' ? { line: item } : item));
  const candidates = entries.map(forms);
  const matching = options.regex === true
    ? await regexMatches(candidates, query, options.timeoutMs ?? REGEX_TIMEOUT_MS)
    : literalMatches(candidates, query);
  if (matching.length === 0) return { text: `No matches for ${JSON.stringify(query)}.`, matches: 0 };

  const shown = matching.slice(0, MAX_MATCHES);
  const out: string[] = [];
  let printedTo = -1;
  for (const match of shown) {
    const printed = candidates[match.line]?.[match.form] ?? '';
    const before = match.line - 1;
    if (printed.trim().length < SHORT_MATCH && before > printedTo && before >= 0) {
      out.push(clipLine(entries[before]?.line ?? '', undefined));
    }
    out.push(clipLine(printed, match));
    printedTo = match.line;
  }
  if (matching.length > shown.length) {
    out.push(`(${matching.length - shown.length} more matches; narrow the query)`);
  }
  return { text: out.join('\n'), matches: matching.length };
}

/**
 * The forms of a line a match may print, in the order they are tried: a text line as a read prints it, then with every
 * address in it; an element's line with its address first.
 */
function forms(entry: FindLine): string[] {
  if (entry.search === undefined || entry.search === entry.line) return [entry.line];
  return entry.text === true ? [entry.line, entry.search] : [entry.search, entry.line];
}

/** A line short enough to print: around its match, or from its start for a context line. Every cut is marked. */
function clipLine(line: string, match: LineMatch | undefined): string {
  const indent = line.length - line.trimStart().length;
  if (line.length - indent <= (match === undefined ? MAX_CONTEXT : MAX_LINE)) return line;
  const from = match === undefined ? indent : Math.max(indent, match.start - MATCH_WINDOW);
  const to = match === undefined ? indent + MAX_CONTEXT : Math.min(line.length, match.start + match.length + MATCH_WINDOW);
  return `${line.slice(0, indent)}${from > indent ? '…' : ''}${line.slice(from, to)}${to < line.length ? '…' : ''}`;
}

function literalMatches(lines: string[][], query: string): LineMatch[] {
  const needle = query.toLowerCase();
  const matching: LineMatch[] = [];
  lines.forEach((forms, index) => {
    for (const [form, line] of forms.entries()) {
      const start = line.toLowerCase().indexOf(needle);
      if (start < 0) continue;
      matching.push({ line: index, form, start, length: needle.length });
      return;
    }
  });
  return matching;
}

async function regexMatches(lines: string[][], query: string, timeoutMs: number): Promise<LineMatch[]> {
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
  workerData.lines.forEach((forms, index) => {
    for (let form = 0; form < forms.length; form += 1) {
      const found = pattern.exec(forms[form]);
      if (found === null) continue;
      matches.push({ line: index, form, start: found.index, length: found[0].length });
      return;
    }
  });
  parentPort.postMessage({ ok: true, matches });
} catch (error) {
  parentPort.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) });
}
`;
