import type { RenderedLine } from './format.js';
import { FIELDS } from './outline.js';

/**
 * Fewest removed lines in one run that a diff counts instead of printing: as many as make a folded list of links, so a
 * list that went (a closed combobox's options, a filtered table's rows) is one line and a few removed lines stay whole.
 */
export const REMOVED_RUN = 8;
/** Most characters of the first and last names a counted run quotes. */
const RUN_NAME = 40;

const REF = /^\s*(e\d+) /;
const QUOTED = /"(?:[^"\\]|\\.)*"/;

/**
 * The lines of a view a diff always prints when they go: fields, and every line of a live region or a dialog, so an agent
 * sees an error disappear or a field go.
 */
export function vitalLines(rendered: RenderedLine[]): Set<string> {
  const vital = new Set<string>();
  for (const item of rendered) if (item.keep !== false || FIELDS.has(item.role)) vital.add(item.line);
  return vital;
}

/**
 * A diff with each long run of removed lines counted in one line, `-  (37 lines removed: "first", … "last")`, at the
 * indent and place of the first line it stands for. Added lines are untouched, and so are, within a run, a changed
 * element's old line (its ref is on an added line of the same hunk), and the lines `vital` names. Only a run of at least
 * `REMOVED_RUN` other lines is counted.
 */
export function countRemovedRuns(diff: string, vital: ReadonlySet<string>): string {
  const lines = diff.split('\n');
  const out: string[] = [];
  let hunkStart = 0;
  while (hunkStart < lines.length) {
    let hunkEnd = hunkStart + 1;
    while (hunkEnd < lines.length && lines[hunkEnd] !== '@@') hunkEnd += 1;
    const hunk = lines.slice(hunkStart, hunkEnd);
    const addedRefs = new Set(hunk.flatMap((line) => (line.startsWith('+') ? [REF.exec(line.slice(1))?.[1]].filter((ref) => ref !== undefined) : [])));
    let index = 0;
    while (index < hunk.length) {
      const line = hunk[index] ?? '';
      if (!line.startsWith('-')) {
        out.push(line);
        index += 1;
        continue;
      }
      const run: string[] = [];
      while (index < hunk.length && (hunk[index] ?? '').startsWith('-')) run.push((hunk[index++] ?? '').slice(1));
      const keeps = (body: string): boolean => vital.has(body) || addedRefs.has(REF.exec(body)?.[1] ?? '');
      const counted = run.filter((body) => !keeps(body));
      if (counted.length < REMOVED_RUN) {
        out.push(...run.map((body) => `-${body}`));
        continue;
      }
      let placed = false;
      for (const body of run) {
        if (keeps(body)) out.push(`-${body}`);
        else if (!placed) {
          placed = true;
          const indent = /^\s*/.exec(body)?.[0] ?? '';
          out.push(`-${indent}(${counted.length} lines removed: ${runName(counted[0] ?? '')}, … ${runName(counted.at(-1) ?? '')})`);
        }
      }
    }
    hunkStart = hunkEnd;
  }
  return out.join('\n');
}

/** What a counted run says a line was: its name or text, held to `RUN_NAME` characters, else the line without its ref. */
function runName(body: string): string {
  const quoted = QUOTED.exec(body)?.[0];
  if (quoted === undefined) return JSON.stringify(body.trim().replace(REF, '').slice(0, RUN_NAME));
  let text: string;
  try {
    text = JSON.parse(quoted) as string;
  } catch {
    text = quoted.slice(1, -1);
  }
  return JSON.stringify(text.length > RUN_NAME ? `${text.slice(0, RUN_NAME - 1)}…` : text);
}
