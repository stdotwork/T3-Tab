import { shownValue } from './format.js';

/** A value an `act` step set on an element, which the page then shows back: the agent already knows it. */
export interface SetValue {
  ref: string;
  /** `value` for fill and type; `select` for an option chosen in a select, whose options are the lines below it. */
  kind: 'value' | 'select';
  /** What the step typed, or the option it chose. */
  text: string;
  /** Whether the step adds to what is there (type) instead of replacing it (fill). */
  appends?: boolean | undefined;
}

export interface ElidedEchoes {
  /** The earlier read with each echoed line already as the page shows it now, so a diff against the new read leaves it out. */
  previous: string;
  /** The refs whose lines were left out, in the order the steps named them. */
  refs: string[];
  /** Each echoed line before and after, without its ref, to settle the plain-text view the same way. */
  pairs: Array<{ before: string; after: string }>;
}

const REF_LINE = /^(\s*)(e\d+) /;
const VALUE_TOKEN = / value=(?:"(?:[^"\\]|\\.)*"|<redacted>)/;

/**
 * Settles the lines of elements an `act` step set so a diff against `current` shows only what else changed. A line
 * counts as an echo when its only change is the value the step set (a field's value; a select's value and which
 * option is marked selected). A line the page changed in any other way, or to another value than the step set (a
 * mask, a rejected option, a flag such as `invalid`), stays a change, and so does any line it cannot verify.
 */
export function elideEchoes(previous: string, current: string, sets: SetValue[]): ElidedEchoes {
  const before = previous.split('\n');
  const after = current.split('\n');
  const beforeAt = refIndex(before);
  const afterAt = refIndex(after);
  const refs: string[] = [];
  const pairs: Array<{ before: string; after: string }> = [];
  const settle = (index: number, line: string): void => {
    pairs.push({ before: withoutRef(before[index] ?? ''), after: withoutRef(line) });
    before[index] = line;
  };

  // A ref set twice in one batch (a fill, then a type) ends at a value the lines cannot tell us.
  const counts = new Map<string, number>();
  for (const set of sets) counts.set(set.ref, (counts.get(set.ref) ?? 0) + 1);

  for (const set of sets) {
    if (counts.get(set.ref) !== 1 || refs.includes(set.ref)) continue;
    const from = beforeAt.get(set.ref);
    const to = afterAt.get(set.ref);
    if (from === undefined || to === undefined) continue;
    const settled =
      set.kind === 'value'
        ? valueEcho(before[from] ?? '', after[to] ?? '', set)
        : selectEcho(before, after, from, to, set);
    if (settled === undefined || settled.length === 0) continue;
    for (const [offset, line] of settled) settle(from + offset, line);
    refs.push(set.ref);
  }
  return { previous: before.join('\n'), refs, pairs };
}

/** Puts the settled lines of the refs' plain-text view in place, where each of them is the only line of its kind. */
export function elideTextEchoes(previous: string, current: string, pairs: ElidedEchoes['pairs']): string {
  if (pairs.length === 0) return previous;
  const lines = previous.split('\n');
  const now = current.split('\n');
  for (const pair of pairs) {
    const at = onlyIndex(lines, pair.before);
    const into = onlyIndex(now, pair.after);
    if (at === undefined || into === undefined) continue;
    lines[at] = now[into] ?? '';
  }
  return lines.join('\n');
}

/** The lines (offset below the element's line, and the page's line) that a fill or type leaves as an echo, if it is one. */
function valueEcho(old: string, now: string, set: SetValue): Array<[number, string]> | undefined {
  if (old === now) return undefined;
  const was = splitValue(old);
  const is = splitValue(now);
  if (was.rest !== is.rest) return undefined;
  // `undefined` is the line of an empty field, which has no value on it.
  const wanted = new Set<string | undefined>([set.text === '' ? undefined : valueToken(set.text)]);
  if (set.appends === true && was.value !== undefined) {
    wanted.add(valueToken(was.value + set.text));
    wanted.add(valueToken(set.text + was.value));
  }
  return wanted.has(is.token) ? [[0, now]] : undefined;
}

/** The lines of a select (its own and its options') that a choice leaves as an echo, if it is one. */
function selectEcho(
  before: string[],
  after: string[],
  from: number,
  to: number,
  set: SetValue,
): Array<[number, string]> | undefined {
  const head = splitValue(before[from] ?? '');
  const now = splitValue(after[to] ?? '');
  if (head.rest !== now.rest) return undefined;
  const options = subtree(before, from);
  const chosen = subtree(after, to);
  if (options.length === 0 || options.length !== chosen.length) return undefined;
  let marked: string | undefined;
  const lines: Array<[number, string]> = [[0, after[to] ?? '']];
  for (const [index, line] of chosen.entries()) {
    // The same option, in the same place: the line changes only by its selected mark.
    if (withoutSelected(options[index] ?? '') !== withoutSelected(line)) return undefined;
    if (isSelected(line)) {
      if (marked !== undefined) return undefined;
      marked = line;
    }
    lines.push([index + 1, line]);
  }
  if (marked === undefined || optionName(marked) !== set.text) return undefined;
  // The select shows the option it chose.
  if (now.token !== valueToken(set.text)) return undefined;
  return lines.filter(([offset, line]) => line !== (offset === 0 ? before[from] : options[offset - 1]));
}

function subtree(lines: string[], at: number): string[] {
  const depth = indentOf(lines[at] ?? '');
  const below: string[] = [];
  for (let index = at + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (indentOf(line) <= depth) break;
    below.push(line);
  }
  return below;
}

function refIndex(lines: string[]): Map<string, number> {
  const at = new Map<string, number>();
  for (const [index, line] of lines.entries()) {
    const ref = refOf(line);
    if (ref !== undefined && !at.has(ref)) at.set(ref, index);
  }
  return at;
}

function refOf(line: string): string | undefined {
  return REF_LINE.exec(line)?.[2];
}

function withoutRef(line: string): string {
  return line.replace(REF_LINE, '$1');
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

function onlyIndex(lines: string[], wanted: string): number | undefined {
  const target = wanted.trim();
  let found: number | undefined;
  for (const [index, line] of lines.entries()) {
    if (line.trim() !== target) continue;
    if (found !== undefined) return undefined;
    found = index;
  }
  return found;
}

/** A line without its value, the value as printed (`value="…"`), and what it says unquoted. */
function splitValue(line: string): { rest: string; token: string | undefined; value: string | undefined } {
  const match = VALUE_TOKEN.exec(line);
  if (match === null) return { rest: line, token: undefined, value: undefined };
  const token = match[0].trim();
  let value: string | undefined;
  if (token.startsWith('value="')) {
    try {
      value = JSON.parse(token.slice('value='.length)) as string;
    } catch {
      value = undefined;
    }
  }
  return { rest: line.replace(VALUE_TOKEN, ''), token, value };
}

/** How the reader prints a field's value, so a value a step set can be compared with the line. */
function valueToken(text: string): string {
  return `value=${JSON.stringify(shownValue(text))}`;
}

function isSelected(line: string): boolean {
  return /\[(?:[^\]]* )?selected(?: [^\]]*)?\]$/.test(line);
}

function withoutSelected(line: string): string {
  return line.replace(/\[((?:[^\]]* )?)selected((?: [^\]]*)?)\]$/, (_all, left: string, right: string) => {
    const flags = `${left}${right}`.trim().replace(/\s+/g, ' ');
    return flags === '' ? '' : `[${flags}]`;
  }).trimEnd();
}

/** The quoted name of an option line, unquoted. */
function optionName(line: string): string | undefined {
  const match = /^\s*e\d+ option ("(?:[^"\\]|\\.)*")/.exec(line);
  if (match?.[1] === undefined) return undefined;
  try {
    return JSON.parse(match[1]) as string;
  } catch {
    return undefined;
  }
}
