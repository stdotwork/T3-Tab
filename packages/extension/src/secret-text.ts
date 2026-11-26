import { relatedTabs } from './opened-tabs';

/** What stands in text for the part of it that held a hidden value. */
export const HIDDEN = '<redacted>';
/** A value shorter than this is only replaced as a whole word, and only in the names tied to its field. */
export const MIN_SUBSTRING = 4;

/** The text lower-cased, keeping every position where it was (a few letters change length when lower-cased as a whole). */
function lowered(text: string): string {
  const lower = text.toLowerCase();
  if (lower.length === text.length) return lower;
  let out = '';
  for (const character of text) {
    const small = character.toLowerCase();
    out += small.length === character.length ? small : character;
  }
  return out;
}

/** A needle as it is matched: whitespace collapsed. */
export function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export interface Matcher {
  /** Where the needles stand in the text, overlapping matches joined, never inside a marker. */
  ranges(text: string): Array<[number, number]>;
  /** The text with every match replaced by one marker, or `undefined` when there is none. */
  scrub(text: string): string | undefined;
  has(text: string): boolean;
  readonly size: number;
}

/** A value is followed by its first characters only, so no value can make the matcher larger than this. */
const MAX_PATTERN = 256;

/**
 * A matcher for values of `MIN_SUBSTRING` characters or more, case-insensitive, built as an Aho-Corasick automaton: the cost
 * of a text is one pass over it, whatever the number of values and however alike they start, so a page of tens of thousands
 * of names and thousands of values costs no more than their size. Shorter values are ignored; see `shortScrubber`.
 */
export function matcher(needles: Iterable<string>): Matcher {
  const unique = new Set<string>();
  for (const needle of needles) {
    const text = lowered(collapse(needle));
    if (text.length >= MIN_SUBSTRING) unique.add(text);
  }
  const edges = new Map<number, number>();
  const parent: number[] = [0];
  const letter: number[] = [0];
  const depth: number[] = [0];
  /** The length of the longest value that ends at a state (0 for none). */
  const ends: number[] = [0];
  /** For a state that ends a value cut at `MAX_PATTERN`: the whole values it stands for. */
  const whole = new Map<number, string[]>();
  const starts = new Uint8Array(65_536);
  for (const needle of unique) {
    let state = 0;
    const pattern = needle.length > MAX_PATTERN ? needle.slice(0, MAX_PATTERN) : needle;
    for (let index = 0; index < pattern.length; index += 1) {
      const code = pattern.charCodeAt(index);
      if (index === 0) starts[code] = 1;
      const key = state * 65_536 + code;
      let next = edges.get(key);
      if (next === undefined) {
        next = parent.length;
        edges.set(key, next);
        parent.push(state);
        letter.push(code);
        depth.push((depth[state] ?? 0) + 1);
        ends.push(0);
      }
      state = next;
    }
    ends[state] = pattern.length;
    if (pattern.length !== needle.length) whole.set(state, [...(whole.get(state) ?? []), needle]);
  }
  const fail = Array.from({ length: parent.length }, () => 0);
  const order = Array.from({ length: parent.length - 1 }, (_, index) => index + 1).sort((a, b) => (depth[a] ?? 0) - (depth[b] ?? 0));
  const step = (from: number, code: number): number => {
    let state = from;
    for (;;) {
      const next = edges.get(state * 65_536 + code);
      if (next !== undefined) return next;
      if (state === 0) return 0;
      state = fail[state] ?? 0;
    }
  };
  for (const state of order) {
    const above = parent[state] ?? 0;
    fail[state] = above === 0 ? 0 : step(fail[above] ?? 0, letter[state] ?? 0);
    if (fail[state] === state) fail[state] = 0;
    if ((ends[state] ?? 0) === 0) ends[state] = ends[fail[state] ?? 0] ?? 0;
  }

  const ranges = (text: string): Array<[number, number]> => {
    const found: Array<[number, number]> = [];
    if (unique.size === 0) return found;
    const lower = lowered(text);
    let state = 0;
    for (let at = 0; at < lower.length; at += 1) {
      const code = lower.charCodeAt(at);
      if (code === 60 && lower.startsWith(HIDDEN, at)) {
        state = 0;
        at += HIDDEN.length - 1;
        continue;
      }
      if (state === 0 && starts[code] === 0) continue;
      state = step(state, code);
      const length = ends[state] ?? 0;
      if (length === 0) continue;
      let start = at + 1 - length;
      const long = whole.get(state);
      let end = at + 1;
      if (long !== undefined) {
        // As far as the text follows the whole value, so no part of a value longer than its pattern is left.
        for (const full of long) {
          let same = MAX_PATTERN;
          while (same < full.length && lower.charCodeAt(start + same) === full.charCodeAt(same)) same += 1;
          end = Math.max(end, start + same);
        }
      }
      // Overlapping matches become one range.
      while (found.length > 0) {
        const last = found[found.length - 1];
        if (last === undefined || last[1] <= start) break;
        start = Math.min(start, last[0]);
        end = Math.max(end, last[1]);
        found.pop();
      }
      found.push([start, end]);
      if (end > at + 1) {
        at = end - 1;
        state = 0;
      }
    }
    return found;
  };
  return {
    size: unique.size,
    ranges,
    has: (text) => ranges(text).length > 0,
    scrub: (text) => {
      const found = ranges(text);
      if (found.length === 0) return undefined;
      let out = '';
      let from = 0;
      for (const [start, end] of found) {
        out += text.slice(from, start) + HIDDEN;
        from = end;
      }
      return out + text.slice(from);
    },
  };
}

/** The forms a value takes in an address: as it is, percent-encoded, and encoded as a form does (a plus for a space). */
export function addressForms(needles: Iterable<string>): string[] {
  const forms = new Set<string>();
  for (const needle of needles) {
    const text = collapse(needle);
    forms.add(text);
    try {
      forms.add(encodeURIComponent(text));
      forms.add(encodeURI(text));
      forms.add(encodeURIComponent(text).replace(/%20/g, '+'));
    } catch {
      // A lone surrogate cannot be encoded; the plain form still stands.
    }
  }
  return [...forms];
}

/**
 * Replaces whole-word occurrences of short values (fewer than `MIN_SUBSTRING` characters), around any marker already in the
 * text. The caller keeps the set small; a value with no letters or digits at its ends is matched as written.
 */
export function shortScrub(text: string, needles: Iterable<string>): string | undefined {
  return shortScrubber(needles)(text);
}

const shortCache = new Map<string, (text: string) => string | undefined>();

/** The same, compiled once for a set of values. */
export function shortScrubber(needles: Iterable<string>): (text: string) => string | undefined {
  const list = [...new Set(needles)]
    .map((needle) => collapse(needle))
    .filter((needle) => needle !== '' && needle.length < MIN_SUBSTRING)
    .sort((a, b) => b.length - a.length);
  const key = list.join('\u0000');
  const cached = shortCache.get(key);
  if (cached !== undefined) return cached;
  let scrub: (text: string) => string | undefined = () => undefined;
  if (list.length > 0) {
    // One pass over the text whatever the number of values: at each position only the lengths a value can have are looked up.
    const wanted = new Set(list.map((needle) => lowered(needle)));
    const lengths = [...new Set([...wanted].map((needle) => needle.length))].sort((a, b) => b - a);
    const isWord = (character: string | undefined): boolean => character !== undefined && /^[\p{L}\p{N}]$/u.test(character);
    const before = (text: string, at: number): string | undefined => {
      if (at <= 0) return undefined;
      const low = text.charCodeAt(at - 1);
      return low >= 0xdc00 && low <= 0xdfff && at >= 2 ? text.slice(at - 2, at) : text.charAt(at - 1);
    };
    const after = (text: string, at: number): string | undefined => {
      if (at >= text.length) return undefined;
      return String.fromCodePoint(text.codePointAt(at) ?? 0);
    };
    scrub = (text) => {
      const lower = lowered(text);
      let out = '';
      let from = 0;
      let changed = false;
      for (let at = 0; at < lower.length; ) {
        if (lower.charCodeAt(at) === 60 && lower.startsWith(HIDDEN, at)) {
          at += HIDDEN.length;
          continue;
        }
        let hit = 0;
        if (!isWord(before(lower, at))) {
          for (const length of lengths) {
            if (at + length <= lower.length && wanted.has(lower.slice(at, at + length)) && !isWord(after(lower, at + length))) {
              hit = length;
              break;
            }
          }
        }
        if (hit === 0) {
          at += 1;
        } else {
          out += text.slice(from, at) + HIDDEN;
          at += hit;
          from = at;
          changed = true;
        }
      }
      return changed ? out + text.slice(from) : undefined;
    };
  }
  if (shortCache.size > 500) shortCache.clear();
  shortCache.set(key, scrub);
  return scrub;
}

// What the extension still knows about secrets it saw on a tab, so that text it reports later (a tab's title and address,
// which a form that sends the password in its address puts there) is scrubbed too, with no read between.
const REMEMBER_MS = 30 * 60_000;
const MAX_TABS = 200;
const MAX_PER_TAB = 400;
const remembered = new Map<number, { at: number; needles: Set<string> }>();

/**
 * Remembers values (of `MIN_SUBSTRING` characters or more) seen in secret fields of a tab, for it and for every tab of its
 * tree of openers (`relatedTabs`), since a form on it can be sent by name into any of them and put the values in that
 * tab's address. A tab with no such value gets no entry; one it has already is kept for longer.
 */
export function rememberSecrets(tabId: number, needles: Iterable<string>, now = Date.now()): void {
  for (const [id, entry] of remembered) if (now - entry.at > REMEMBER_MS) remembered.delete(id);
  const texts = new Set<string>();
  for (const needle of needles) {
    const text = collapse(needle);
    if (text.length >= MIN_SUBSTRING) texts.add(text);
  }
  if (texts.size === 0) {
    const entry = remembered.get(tabId);
    if (entry !== undefined) keep(tabId, entry, now);
    return;
  }
  for (const id of [tabId, ...relatedTabs(tabId)]) {
    const entry = remembered.get(id) ?? { at: now, needles: new Set<string>() };
    for (const text of texts) if (entry.needles.size < MAX_PER_TAB) entry.needles.add(text);
    keep(id, entry, now);
  }
}

/** Stores a tab's entry as its newest, dropping the oldest past `MAX_TABS`. */
function keep(tabId: number, entry: { at: number; needles: Set<string> }, now: number): void {
  entry.at = now;
  remembered.delete(tabId);
  remembered.set(tabId, entry);
  while (remembered.size > MAX_TABS) {
    const oldest = remembered.keys().next().value;
    if (oldest === undefined) break;
    remembered.delete(oldest);
  }
}

export function knownSecrets(tabId: number, now = Date.now()): string[] {
  const entry = remembered.get(tabId);
  return entry === undefined || now - entry.at > REMEMBER_MS ? [] : [...entry.needles];
}

export function forgetSecrets(tabId: number): void {
  remembered.delete(tabId);
}

/** A tab's title or address as the agent may see it: the values known for the tab taken out, also in their address forms. */
export function scrubReported(tabId: number | undefined, text: string, address: boolean): string {
  if (tabId === undefined || text === '') return text;
  const known = knownSecrets(tabId);
  if (known.length === 0) return text;
  return matcher(address ? addressForms(known) : known).scrub(text) ?? text;
}
