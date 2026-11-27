import { GROUP_ROLES, type RenderedLine, type View } from './format.js';

/** A default view longer than this, in characters, is outlined in a `read` or `act` reply. */
export const OUTLINE_AT = 6_000;
/** Links, buttons and the like an outline keeps outside forms, the first in page order. */
export const OUTLINE_ACTIONS = 40;
/** Characters of the page's main text an outline keeps, from its start. */
export const OUTLINE_TEXT = 1_500;

export interface Outline {
  lines: RenderedLine[];
  /** What it left out, for its note. */
  actions: number;
  textLines: number;
  characters: number;
}

/**
 * A long page's outline: its headings, landmarks and other containers, every field and every element of a form, live
 * regions and dialogs whole, the first `OUTLINE_ACTIONS` links and buttons, and the first `OUTLINE_TEXT` characters of
 * the main content's text (of the page's, when it has no `main` or `article`). Long lists of links or buttons around the
 * content fold to one line each, as `collapseGroups` folds them; the lists in the content keep their first links.
 */
export function outlineView(view: View): Outline {
  const chrome = new Map(view.groups.filter((group) => group.chrome).map((group) => [group.start, group]));
  const hasMain = view.lines.some((line) => line.text && line.keep === false && line.main);
  const lines: RenderedLine[] = [];
  let actions = 0;
  let leftActions = 0;
  let textRoom = OUTLINE_TEXT;
  let leftText = 0;
  let characters = 0;
  const leaveText = (line: RenderedLine): void => {
    leftText += 1;
    characters += Math.max(0, line.line.trim().length - 2);
  };
  for (let at = 0; at < view.lines.length; at += 1) {
    const group = chrome.get(at);
    if (group !== undefined) {
      lines.push(group.summary());
      for (const inside of view.lines.slice(group.start, group.end)) {
        if (inside.text) leaveText(inside);
        else if (GROUP_ROLES.has(inside.role)) leftActions += 1;
      }
      at = group.end - 1;
      continue;
    }
    const line = view.lines[at];
    if (line === undefined) continue;
    if (line.keep !== false) {
      lines.push(line);
      continue;
    }
    if (line.text) {
      // The first text of the content, in order: once a line does not fit, the rest is left out.
      const size = line.line.length + 1;
      if ((hasMain && !line.main) || size > textRoom) {
        if (!hasMain || line.main) textRoom = 0;
        leaveText(line);
        continue;
      }
      textRoom -= size;
      lines.push(line);
      continue;
    }
    if (GROUP_ROLES.has(line.role) && !line.form) {
      if (actions >= OUTLINE_ACTIONS) {
        // What the element holds goes with it: a story's heading inside its link, a button inside a link.
        const indent = indentOf(line);
        let end = at + 1;
        while (end < view.lines.length && indentOf(view.lines[end]) > indent) end += 1;
        for (const inside of view.lines.slice(at, end)) {
          // A live region or a dialog always prints.
          if (inside.keep !== false) lines.push(inside);
          else if (inside.text) leaveText(inside);
          else if (GROUP_ROLES.has(inside.role)) leftActions += 1;
        }
        at = end - 1;
        continue;
      }
      actions += 1;
    }
    lines.push(line);
  }
  return { lines, actions: leftActions, textLines: leftText, characters };
}

function indentOf(line: RenderedLine | undefined): number {
  return line === undefined ? 0 : line.line.length - line.line.trimStart().length;
}

/** The last line of an outline: that the page was outlined, what it left out, and how to get at the rest. */
export function outlineNote(outline: Outline): string {
  const parts: string[] = [];
  if (outline.actions > 0) parts.push(`${outline.actions} ${outline.actions === 1 ? 'link or button' : 'links and buttons'}`);
  if (outline.textLines > 0) parts.push(`${outline.textLines} text ${outline.textLines === 1 ? 'line' : 'lines'} (${outline.characters} characters)`);
  const left = parts.length === 0 ? '' : `: ${parts.join(', ')} left out`;
  return `(Outline of a long page${left}. find searches them, read a ref for one part, all for the whole page)`;
}
