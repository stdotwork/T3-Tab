import type { PageReadResult } from '@t3-tab/protocol';

import { elideEchoes, type SetValue } from './echo.js';
import { findLines } from './find.js';
import { collapseGroups, type Keep, MORE_INSIDE, RefGoneError, type RenderedLine, renderView, truncate, type View } from './format.js';
import { RefTable } from './refs.js';
import { createSmartDiff } from './smart-diff.js';

/** Longest reply a read returns, in characters (about 3,000 tokens). */
export const MAX_OUTPUT_CHARS = 12_000;

const MAX_SESSIONS_PER_TAB = 16;
const MAX_KEYS_PER_SESSION = 8;
const MAX_TITLE = 80;
const MAX_URL = 200;
/**
 * Most characters of plain text in a default read or a change: the rest is left out with a note. The text of live
 * regions and dialogs comes first. Elements and headings are always shown, up to the cap.
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
  private readonly baselines = new Map<string, Map<string, Baseline>>();
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

  baseline(session: string, key: string): Baseline | undefined {
    return this.baselines.get(session)?.get(key);
  }

  setBaseline(session: string, key: string, baseline: Baseline): void {
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
    keys.set(key, baseline);
  }
}

/** The last read of one view: every line, and which of its text lines come first when a reply must leave text out. */
export interface Baseline {
  text: string;
  kept: ReadonlyMap<string, Keep>;
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
  let view: View;
  try {
    view = renderView(page.nodes, state.refTable, {
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
  const rendered = view.lines;
  const lines = rendered.map((item) => item.line);

  if (find !== undefined) {
    const found = await findLines(lines, find, { regex: options.regex });
    return limit(`${header}\n${found.text}`);
  }

  const depthNote = lines.some((line) => line.endsWith(MORE_INSIDE)) ? `\n${DEPTH_NOTE}` : '';
  // The baseline holds every line, so a change to text the reply left out is still a change.
  const text = lines.join('\n') + depthNote;
  const key = `${all ? 'all' : 'page'}|${options.ref ?? ''}|${options.depth ?? ''}`;
  const kept = keptLines(rendered);
  const last = state.baseline(session, key);
  const previous = last?.text;
  state.setBaseline(session, key, { text, kept });

  if (lines.length === 0) {
    return `${header}\n${all ? '(empty page)' : '(empty page; all also lists images)'}`;
  }
  // A ref read is a request for that part, so only the cap limits its text; `all` has no text budget.
  const budget = all || options.ref !== undefined ? Number.POSITIVE_INFINITY : TEXT_BUDGET;
  const whole = (): string => {
    if (all) return limit(`${header}\n${text}`);
    // Long lists of links or buttons give way to one line each where the page's text would otherwise get no room.
    const room = MAX_OUTPUT_CHARS - NOTE_ROOM - header.length;
    const shown = options.ref === undefined && options.depth === undefined ? collapseGroups(view, room, budget) : rendered;
    const within = withinBudget(shown, budget, header.length);
    return limit(`${header}\n${within.text}${depthNote}`, within.note);
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
    const room = MAX_OUTPUT_CHARS - NOTE_ROOM - header.length;
    const changed = all ? { text: diff.content, note: undefined } : diffWithinBudget(diff.content, [kept, last?.kept ?? new Map()], budget, room);
    return limit(`${header}${set === undefined ? '' : `\n${set}`}\nChanged since the last read:\n${changed.text}`, changed.note);
  }
  return whole();
}

/** The text lines of a live region or a dialog in a view, and which end of them to keep. */
function keptLines(rendered: RenderedLine[]): Map<string, Keep> {
  const kept = new Map<string, Keep>();
  for (const item of rendered) if (item.text && item.keep !== false) kept.set(item.line, item.keep);
  return kept;
}

/**
 * Which of `candidates` (text lines, in page order, each with its size) fit in `room`: first the text of live regions
 * and dialogs (a log from its newest line back, the others from their first), then the page's main content, then the
 * rest, each in order until one does not fit.
 */
function chooseText(candidates: Array<{ index: number; size: number; keep: Keep; main: boolean }>, room: number): Set<number> {
  const hasMain = candidates.some((item) => item.keep === false && item.main);
  const groups = [
    candidates.filter((item) => item.keep === 'start'),
    candidates.filter((item) => item.keep === 'end').reverse(),
    candidates.filter((item) => item.keep === false && (!hasMain || item.main)),
    hasMain ? candidates.filter((item) => item.keep === false && !item.main) : [],
  ];
  const chosen = new Set<number>();
  let left = room;
  for (const group of groups) {
    for (const item of group) {
      if (item.size > left) {
        left = 0;
        break;
      }
      left -= item.size;
      chosen.add(item.index);
    }
  }
  return chosen;
}

/**
 * The default view at its size: every element and heading, and as much text as the budget and the cap leave room
 * for, chosen by `chooseText`. What it leaves out is said in one line at the end.
 */
function withinBudget(rendered: RenderedLine[], budget: number, headerLength: number): { text: string; note: string | undefined } {
  const fixed = rendered.reduce((sum, item) => sum + (item.text ? 0 : item.line.length + 1), 0);
  const room = Math.min(budget, Math.max(0, MAX_OUTPUT_CHARS - NOTE_ROOM - headerLength - fixed));
  const candidates = rendered.flatMap((item, index) => (item.text ? [{ index, size: item.line.length + 1, keep: item.keep, main: item.main }] : []));
  const shown = chooseText(candidates, room);
  const text = rendered
    .filter((item, index) => !item.text || shown.has(index))
    .map((item) => item.line)
    .join('\n');
  const left = candidates.filter((item) => !shown.has(item.index)).map((item) => rendered[item.index]?.line ?? '');
  return { text, note: left.length === 0 ? undefined : leftOutNote(left) };
}

/**
 * A diff's text lines within the budget and the room the cap leaves after its other lines, the rest left out with a
 * note; changed elements always stay. A line of a live region or dialog, on either side of the diff, comes first.
 */
function diffWithinBudget(
  diff: string,
  kept: [ReadonlyMap<string, Keep>, ReadonlyMap<string, Keep>],
  budget: number,
  room: number,
): { text: string; note: string | undefined } {
  const lines = diff.split('\n');
  const isText = (line: string): boolean => line !== '@@' && line.slice(1).trimStart().startsWith('"');
  const fixed = lines.reduce((sum, line) => sum + (isText(line) ? 0 : line.length + 1), 0);
  const candidates = lines.flatMap((line, index) => {
    if (!isText(line)) return [];
    const body = line.slice(1);
    const keep = kept[0].get(body) ?? kept[1].get(body) ?? false;
    return [{ index, size: line.length + 1, keep, main: false }];
  });
  const shown = chooseText(candidates, Math.min(budget, Math.max(0, room - fixed)));
  const hunks: string[][] = [];
  const left: string[] = [];
  for (const [index, line] of lines.entries()) {
    if (line === '@@') {
      hunks.push([line]);
      continue;
    }
    if (isText(line) && !shown.has(index)) {
      if (!line.startsWith(' ')) left.push(line.slice(1));
      continue;
    }
    hunks.at(-1)?.push(line);
  }
  // A hunk whose changes were all left out says nothing.
  const changed = hunks.filter((hunk) => hunk.some((line) => line.startsWith('+') || line.startsWith('-')));
  return { text: changed.flat().join('\n'), note: left.length === 0 ? undefined : leftOutNote(left, 'changed ') };
}

/** The characters of text a printed text line holds: without its indent and quotes. */
function textLength(line: string): number {
  return Math.max(0, line.trim().length - 2);
}

/** Says how much text a reply left out, and the links written into it, `[name](e12)`, which went with it. */
function leftOutNote(lines: string[], kind = ''): string {
  const chars = lines.reduce((sum, line) => sum + textLength(line), 0);
  const links = lines.reduce((sum, line) => sum + (line.match(LINK_MARK) ?? []).length, 0);
  const withLinks = links === 0 ? '' : `, ${links} ${links === 1 ? 'link' : 'links'} in them`;
  return `(${lines.length} ${kind}text lines left out, ${chars} characters${withLinks}: find searches them, read a ref for one part, all for the whole page)`;
}

/** A link written into a line of text. */
const LINK_MARK = /\]\(e\d+[) ]/g;

const TRUNCATED = `\n… truncated at ${MAX_OUTPUT_CHARS} characters. Use find, a ref subtree or depth to read the rest.`;

/** Cuts a reply at a line boundary so that all of it, notes included, fits the cap, and says how to get at the rest. */
function limit(text: string, note?: string | undefined): string {
  const tail = note === undefined ? '' : `\n${note}`;
  if (text.length + tail.length <= MAX_OUTPUT_CHARS) return `${text}${tail}`;
  const room = Math.max(0, MAX_OUTPUT_CHARS - tail.length - TRUNCATED.length);
  const cut = text.lastIndexOf('\n', room);
  const kept = text.slice(0, cut > 0 ? cut : room);
  return `${kept}${TRUNCATED}${tail}`;
}
