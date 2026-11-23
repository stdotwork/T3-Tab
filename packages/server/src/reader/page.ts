import type { PageReadResult } from '@t3-tab/protocol';

import { findLines } from './find.js';
import { MORE_INSIDE, RefGoneError, renderTree, truncate } from './format.js';
import { RefTable } from './refs.js';
import { createSmartDiff } from './smart-diff.js';

/** Longest reply a read returns, in characters (about 3,000 tokens). */
export const MAX_OUTPUT_CHARS = 12_000;

const MAX_SESSIONS_PER_TAB = 16;
const MAX_KEYS_PER_SESSION = 8;
const MAX_TITLE = 80;
const MAX_URL = 200;
/** Most lines of new plain text added to a reply about changed elements. */
const MAX_NEW_TEXT_LINES = 10;
const DEPTH_NOTE = '(… = more inside: read that ref)';

export interface ReadOptions {
  all?: boolean | undefined;
  find?: string | undefined;
  /** Opt in to a regular expression for find. The default is literal text. */
  regex?: boolean | undefined;
  ref?: string | undefined;
  depth?: number | undefined;
  full?: boolean | undefined;
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
  // A search covers every node unless the caller narrowed it to interactive ones.
  const all = options.all ?? find !== undefined;
  let lines: string[];
  try {
    lines = renderTree(page.nodes, state.refTable, {
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

  if (find !== undefined) {
    const found = await findLines(lines, find, { regex: options.regex });
    return limit(`${header}\n${found.text}`);
  }

  const text = lines.join('\n') + (lines.some((line) => line.endsWith(MORE_INSIDE)) ? `\n${DEPTH_NOTE}` : '');
  const key = `${all ? 'all' : 'interactive'}|${options.ref ?? ''}|${options.depth ?? ''}`;
  const previous = state.baseline(session, key);
  state.setBaseline(session, key, text);

  if (lines.length === 0) {
    return `${header}\n${all ? '(empty page)' : '(no interactive elements; use all to see the text)'}`;
  }
  // The default view leaves plain text out, so its changes are tracked beside it: a page whose only change is
  // a message must not read as unchanged.
  const textChange = all ? undefined : trackPlainText(state, session, page, options, target);
  if (previous === undefined || options.full === true) return limit(`${header}\n${text}`);

  const diff = createSmartDiff({ oldContent: previous, newContent: text });
  if (diff.type === 'no-change') {
    if (textChange === undefined) return `${header}\nNo changes since the last read.`;
    return limit(`${header}\nText changed since the last read:\n${textChange.diff}`);
  }
  if (diff.type === 'diff') {
    const added = textChange?.added.filter((line) => !diff.content.includes(line.slice(1, -1))).slice(0, MAX_NEW_TEXT_LINES) ?? [];
    const newText = added.length === 0 ? '' : `\nNew text:\n${added.join('\n')}`;
    return limit(`${header}\nChanged since the last read:\n${diff.content}${newText}`);
  }
  return limit(`${header}\n${text}`);
}

/** Records the page's full text for this view and returns how it differs from the last one, if it does. */
function trackPlainText(
  state: TabState,
  session: string,
  page: PageReadResult,
  options: ReadOptions,
  target: number | undefined,
): { diff: string; added: string[] } | undefined {
  // Its own ref table: rendering must not hand out refs the agent was never shown.
  const lines = renderTree(page.nodes, new RefTable(), { all: true, target, depth: options.depth }).map((line) =>
    line.replace(/^(\s*)e\d+ /, '$1'),
  );
  const text = lines.join('\n');
  const key = `text|${options.ref ?? ''}|${options.depth ?? ''}`;
  const previous = state.baseline(session, key);
  state.setBaseline(session, key, text);
  if (previous === undefined) return undefined;
  const diff = createSmartDiff({ oldContent: previous, newContent: text, threshold: 1.01 });
  if (diff.type === 'no-change') return undefined;
  const before = new Set(previous.split('\n'));
  const added = lines.filter((line) => line.trimStart().startsWith('"') && !before.has(line)).map((line) => line.trim());
  return { diff: diff.content, added };
}

/** Cuts a reply at a line boundary once it is over the cap, and says how to get at the rest. */
function limit(text: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  const cut = text.lastIndexOf('\n', MAX_OUTPUT_CHARS);
  const kept = text.slice(0, cut > 0 ? cut : MAX_OUTPUT_CHARS);
  return `${kept}\n… truncated at ${MAX_OUTPUT_CHARS} characters. Use find, a ref subtree or depth to read the rest.`;
}
