import { LINK_MARK, type RenderedLine, type View } from './format.js';

/** A default view longer than this, in characters, is outlined in a `read` or `act` reply. */
export const OUTLINE_AT = 7_000;
/** The longest outline sent, as a share of the view: one that saves less is not worth what it leaves out. */
export const OUTLINE_MAX_SHARE = 0.75;
/** Links, and buttons away from fields, an outline keeps outside forms: the first in page order. */
export const OUTLINE_LINKS = 40;
/** What counts toward `OUTLINE_LINKS`: what a page's long lists hold. */
const CAPPED = new Set(['link', 'button', 'popupbutton', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab', 'option', 'treeitem', 'disclosuretriangle']);
/** Fields: a button among the few elements after one is the field's (a submit, a search), and is always kept. */
const FIELDS = new Set(['textbox', 'searchbox', 'combobox', 'checkbox', 'radio', 'switch', 'slider', 'spinbutton', 'listbox', 'textfield', 'colorwell', 'date', 'datetime', 'inputtime', 'time']);
const BUTTONS = new Set(['button', 'popupbutton']);
/** How many element lines after a field its buttons may come. */
const NEAR_FIELD = 3;
/** Characters of the page's main text an outline keeps, from its start. */
export const OUTLINE_TEXT = 1_500;

export interface Outline {
  lines: RenderedLine[];
  /** What it left out, for its note: links, and the buttons and list items counted with them. */
  links: number;
  others: number;
  /** The text lines it left out. */
  text: string[];
}

/**
 * A long page's outline: its headings, landmarks and other containers, every field, everything inside a form (its text
 * too: labels, hints, errors), the buttons just after a field, live regions and dialogs whole, the first `OUTLINE_LINKS`
 * links and other buttons and list items, and the first `OUTLINE_TEXT` characters of the main content's text (of the
 * page's, when it has no `main` or `article`, and then only while links are still being kept). Long lists of links or
 * buttons around the content fold to one line each, as `collapseGroups` folds them; the lists in the content keep their
 * first links.
 */
export function outlineView(view: View): Outline {
  const chrome = new Map(view.groups.filter((group) => group.chrome).map((group) => [group.start, group]));
  const hasMain = view.lines.some((line) => line.text && line.keep === false && line.main);
  const lines: RenderedLine[] = [];
  const text: string[] = [];
  let links = 0;
  let leftLinks = 0;
  let leftOthers = 0;
  let textRoom = OUTLINE_TEXT;
  let sinceField = Number.POSITIVE_INFINITY;
  // What a dropped link or a folded list takes with it: its text, and its links in the count.
  const leave = (from: number, to: number): void => {
    for (const inside of view.lines.slice(from, to)) {
      // A live region or a dialog always prints.
      if (inside.keep !== false) lines.push(inside);
      else if (inside.text) text.push(inside.line);
      else if (inside.role === 'link') leftLinks += 1;
      else if (CAPPED.has(inside.role)) leftOthers += 1;
    }
  };
  for (let at = 0; at < view.lines.length; at += 1) {
    const group = chrome.get(at);
    if (group !== undefined) {
      lines.push(group.summary());
      leave(group.start, group.end);
      at = group.end - 1;
      continue;
    }
    const line = view.lines[at];
    if (line === undefined) continue;
    if (line.keep !== false || line.form) {
      lines.push(line);
      continue;
    }
    if (line.text) {
      // The first text of the content, in order: once a line does not fit, the rest is left out. Without a main, the
      // text past the last kept link belongs to rows whose links went (a list's numbers, points and bylines).
      const size = line.line.length + 1;
      const past = !hasMain && links >= OUTLINE_LINKS;
      if ((hasMain && !line.main) || past || size > textRoom) {
        if (!past && (!hasMain || line.main)) textRoom = 0;
        text.push(line.line);
        continue;
      }
      textRoom -= size;
      lines.push(line);
      continue;
    }
    sinceField = FIELDS.has(line.role) ? 0 : sinceField + 1;
    if (CAPPED.has(line.role) && !(BUTTONS.has(line.role) && sinceField <= NEAR_FIELD)) {
      if (links >= OUTLINE_LINKS) {
        // What the link holds goes with it: a story's heading inside its link, a button inside a link.
        const indent = indentOf(line);
        let end = at + 1;
        while (end < view.lines.length && indentOf(view.lines[end]) > indent) end += 1;
        leave(at, end);
        at = end - 1;
        continue;
      }
      links += 1;
    }
    lines.push(line);
  }
  return { lines, links: leftLinks, others: leftOthers, text };
}

function indentOf(line: RenderedLine | undefined): number {
  return line === undefined ? 0 : line.line.length - line.line.trimStart().length;
}

/** The last line of an outline: that the page was outlined, what it left out, and how to get at the rest. */
export function outlineNote(outline: Outline): string {
  const parts: string[] = [];
  const elements = outline.links + outline.others;
  if (elements > 0) parts.push(`${elements} ${outline.others === 0 ? (elements === 1 ? 'link' : 'links') : 'links and buttons'}`);
  let size = '';
  if (outline.text.length > 0) {
    parts.push(`${outline.text.length} text ${outline.text.length === 1 ? 'line' : 'lines'}`);
    const characters = outline.text.reduce((sum, line) => sum + Math.max(0, line.trim().length - 2), 0);
    const marks = outline.text.reduce((sum, line) => sum + (line.match(LINK_MARK) ?? []).length, 0);
    size = `, ${characters} characters${marks === 0 ? '' : `, ${marks} ${marks === 1 ? 'link' : 'links'} in them`}`;
  }
  const left = parts.length === 0 ? '' : `: ${parts.join(' and ')} left out${size}`;
  return `(Outline of a long page${left}. find searches them, read a ref for one part, full for the whole view)`;
}
