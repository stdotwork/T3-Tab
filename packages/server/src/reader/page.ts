import type { PageReadResult } from '@t3-tab/protocol';

import { elideEchoes, type SetValue } from './echo.js';
import { findLines } from './find.js';
import { MORE_INSIDE, RefGoneError, renderLines, type RenderedLine, truncate } from './format.js';
import { RefTable } from './refs.js';
import { createSmartDiff } from './smart-diff.js';

/** Longest reply a read returns, in characters (about 3,000 tokens). */
export const MAX_OUTPUT_CHARS = 12_000;

const MAX_SESSIONS_PER_TAB = 16;
const MAX_KEYS_PER_SESSION = 8;
const MAX_TITLE = 80;
const MAX_URL = 200;
/**
 * Most characters of plain text in a default read or a change: the rest is left out with a note. Elements,
 * headings and the text of live regions and dialogs are always shown, up to the cap.
 */
export const TEXT_BUDGET = 4_000;
/** Room kept under the cap for the header and the notes, so text never pushes an element past the cut. */
const NOTE_ROOM = 1_000;
const DEPTH_NOTE = '(… = more inside: read that ref)';

export interface ReadOptions {
  all?: boolean | undefined;
  find?: string | undefined;
  /** Opt in to a regular expression for find. The default is literal text. */
  regex?: boolean | undefined;
  ref?: string | undefined;
  depth?: number | undefined;
  full?: boolean | undefined;
  /** Values the `act` batch that this read follows set. Lines whose only change is such a value are left out. */
  echoed?: SetValue[] | undefined;
}

/** What the background program holds for one tab: its refs and, per calling session, the last text read. */
export class TabState {
  private epoch = -1;
  private refs = new RefTable();
  private readonly baselines = new Map<string, Map<string, string>>();
  private readonly headers = new Map<string, string>();

  /** Drops refs and baselines when the document the tab shows is not the one they came from. */
  syncEpoch(epoch: number): void {
    if (epoch === this.epoch) return;
    this.epoch = epoch;
    this.refs = new RefTable();
    this.baselines.clear();
    this.headers.clear();
  }

  /**
   * The header line to print for this session: the full one when the page's title or address is not what
   * the session last saw for this tab, otherwise just the tab id.
   */
  headerFor(session: string, tab: number, full: string): string {
    const unchanged = this.headers.get(session) === full;
    if (!unchanged && !this.headers.has(session) && this.headers.size >= MAX_SESSIONS_PER_TAB) {
      const oldest = this.headers.keys().next().value;
      if (oldest !== undefined) this.headers.delete(oldest);
    }
    this.headers.set(session, full);
    return unchanged ? `tab ${tab}` : full;
  }

  get refTable(): RefTable {
    return this.refs;
  }

  get currentEpoch(): number {
    return this.epoch;
  }

  baseline(session: string, key: string): string | undefined {
    return this.baselines.get(session)?.get(key);
  }

  setBaseline(session: string, key: string, text: string): void {
    let keys = this.baselines.get(session);
    if (keys === undefined) {
      if (this.baselines.size >= MAX_SESSIONS_PER_TAB) {
        const oldest = this.baselines.keys().next().value;
        if (oldest !== undefined) this.baselines.delete(oldest);
      }
      keys = new Map();
      this.baselines.set(session, keys);
    }
    if (!keys.has(key) && keys.size >= MAX_KEYS_PER_SESSION) {
      const oldest = keys.keys().next().value;
      if (oldest !== undefined) keys.delete(oldest);
    }
    keys.set(key, text);
  }
}

/**
 * The reply to a `read`: a header line (the tab, title and address, or only the tab id when the session
 * already has that title and address), then the page text on the first read of a view, a line diff on
 * later ones, or only the matching lines for a `find`.
 */
export async function formatRead(
  state: TabState,
  session: string,
  page: PageReadResult,
  options: ReadOptions,
): Promise<string> {
  state.syncEpoch(page.epoch);
  const header = state.headerFor(
    session,
    page.tab,
    `tab ${page.tab}: ${truncate(page.title, MAX_TITLE)} — ${truncate(page.url, MAX_URL)}`,
  );

  let target: number | undefined;
  if (options.ref !== undefined) {
    target = state.refTable.backendIdOf(options.ref);
    if (target === undefined) {
      throw new Error(`Unknown ref ${options.ref}: refs reset when the page navigates. Read the page again.`);
    }
  }

  const find = options.find === '' ? undefined : options.find;
  // A search covers every node unless the caller narrowed it to the default view.
  const all = options.all ?? find !== undefined;
  let rendered: RenderedLine[];
  try {
    rendered = renderLines(page.nodes, state.refTable, {
      all,
      target,
      depth: options.depth,
      uncut: find !== undefined,
      // A search shows every link's address. Otherwise only where a name is ambiguous, or the link asked about.
      linkAddresses: find !== undefined ? 'all' : 'ambiguous',
      pageUrl: page.url,
    });
  } catch (error) {
    if (error instanceof RefGoneError) {
      throw new Error(`${options.ref ?? 'The ref'} is no longer on the page. Read the page again.`);
    }
    throw error;
  }
  const lines = rendered.map((item) => item.line);

  if (find !== undefined) {
    const found = await findLines(lines, find, { regex: options.regex });
    return limit(`${header}\n${found.text}`);
  }

  const depthNote = lines.some((line) => line.endsWith(MORE_INSIDE)) ? `\n${DEPTH_NOTE}` : '';
  // The baseline holds every line, so a change to text the reply left out is still a change.
  const text = lines.join('\n') + depthNote;
  const key = `${all ? 'all' : 'page'}|${options.ref ?? ''}|${options.depth ?? ''}`;
  const previous = state.baseline(session, key);
  state.setBaseline(session, key, text);

  if (lines.length === 0) {
    return `${header}\n${all ? '(empty page)' : '(empty page; all also lists images)'}`;
  }
  // A ref read is a request for that part, so only the cap limits its text; `all` has no text budget.
  const budget = all || options.ref !== undefined ? Number.POSITIVE_INFINITY : TEXT_BUDGET;
  const whole = (): string => {
    if (all) return limit(`${header}\n${text}`);
    const view = withinBudget(rendered, budget, header.length);
    return limit(`${header}\n${view.text}${depthNote}`, view.note);
  };
  // What the batch itself set is no news to the agent: the earlier read is settled to show it already.
  const echoes =
    previous === undefined || options.full === true || options.echoed === undefined
      ? undefined
      : elideEchoes(previous, text, options.echoed);
  if (previous === undefined || options.full === true) return whole();

  // Both end in a newline, so a line added at the end does not also show the old last line as changed.
  const diff = createSmartDiff({ oldContent: `${echoes?.previous ?? previous}\n`, newContent: `${text}\n` });
  const set = echoes === undefined || echoes.refs.length === 0 ? undefined : `Set ${echoes.refs.join(', ')}.`;
  if (diff.type === 'no-change') {
    return `${header}\n${set === undefined ? 'No changes since the last read.' : `${set} Nothing else changed.`}`;
  }
  if (diff.type === 'diff') {
    const changed = all ? { text: diff.content, note: undefined } : diffWithinBudget(diff.content, rendered, budget);
    return limit(`${header}${set === undefined ? '' : `\n${set}`}\nChanged since the last read:\n${changed.text}`, changed.note);
  }
  return whole();
}

/**
 * The default view at its size: every element, heading and line of a live region or dialog, and as much of the
 * rest of the text as the budget and the cap leave room for, the page's main content first. What it leaves out
 * is said in one line at the end.
 */
function withinBudget(rendered: RenderedLine[], budget: number, headerLength: number): { text: string; note: string | undefined } {
  const fixed = rendered.reduce((sum, item) => sum + (item.text && !item.keep ? 0 : item.line.length + 1), 0);
  let room = Math.min(budget, Math.max(0, MAX_OUTPUT_CHARS - NOTE_ROOM - headerLength - fixed));
  const optional = rendered.flatMap((item, index) => (item.text && !item.keep ? [index] : []));
  const hasMain = optional.some((index) => rendered[index]?.main === true);
  const order = hasMain
    ? [...optional.filter((index) => rendered[index]?.main === true), ...optional.filter((index) => rendered[index]?.main !== true)]
    : optional;
  const shown = new Set<number>();
  for (const index of order) {
    const size = (rendered[index]?.line.length ?? 0) + 1;
    if (size > room) break;
    room -= size;
    shown.add(index);
  }
  const text = rendered
    .filter((item, index) => !item.text || item.keep || shown.has(index))
    .map((item) => item.line)
    .join('\n');
  const left = optional.filter((index) => !shown.has(index));
  const chars = left.reduce((sum, index) => sum + textLength(rendered[index]?.line ?? ''), 0);
  return { text, note: left.length === 0 ? undefined : leftOutNote(left.length, chars) };
}

/** A diff's text lines within the budget, the rest left out with a note; changed elements always stay. */
function diffWithinBudget(diff: string, rendered: RenderedLine[], budget: number): { text: string; note: string | undefined } {
  if (!Number.isFinite(budget)) return { text: diff, note: undefined };
  const always = new Set(rendered.filter((item) => !item.text || item.keep).map((item) => item.line));
  let room = budget;
  let left = 0;
  let chars = 0;
  const hunks: string[][] = [];
  for (const line of diff.split('\n')) {
    if (line === '@@') {
      hunks.push([line]);
      continue;
    }
    const body = line.slice(1);
    if (body.trimStart().startsWith('"') && !always.has(body)) {
      if (line.length + 1 > room) {
        room = 0;
        if (!line.startsWith(' ')) {
          left += 1;
          chars += textLength(body);
        }
        continue;
      }
      room -= line.length + 1;
    }
    hunks.at(-1)?.push(line);
  }
  // A hunk whose changes were all left out says nothing.
  const kept = hunks.filter((hunk) => hunk.some((line) => line.startsWith('+') || line.startsWith('-')));
  return { text: kept.flat().join('\n'), note: left === 0 ? undefined : leftOutNote(left, chars, 'changed ') };
}

/** The characters of text a printed text line holds: without its indent and quotes. */
function textLength(line: string): number {
  return Math.max(0, line.trim().length - 2);
}

function leftOutNote(lines: number, chars: number, kind = ''): string {
  return `(${lines} ${kind}text lines left out, ${chars} characters: find searches them, read a ref for one part, all for the whole page)`;
}

/** Cuts a reply at a line boundary once it is over the cap, and says how to get at the rest. A note always stays. */
function limit(text: string, note?: string | undefined): string {
  const tail = note === undefined ? '' : `\n${note}`;
  if (text.length + tail.length <= MAX_OUTPUT_CHARS) return `${text}${tail}`;
  const room = MAX_OUTPUT_CHARS - tail.length;
  const cut = text.lastIndexOf('\n', room);
  const kept = text.slice(0, cut > 0 ? cut : room);
  return `${kept}\n… truncated at ${MAX_OUTPUT_CHARS} characters. Use find, a ref subtree or depth to read the rest.${tail}`;
}
