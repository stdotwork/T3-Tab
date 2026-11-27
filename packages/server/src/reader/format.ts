import type { AxNode } from '@t3-tab/protocol';

import type { RefTable } from './refs.js';

export interface RenderOptions {
  /** Every node: also images, unnamed landmarks and other named nodes, besides elements, headings and text. */
  all: boolean;
  /** Backend id of the element to read; its subtree is rendered instead of the page. */
  target?: number | undefined;
  /** Deepest level of shown nesting below the root, counting only shown nodes. */
  depth?: number | undefined;
  /** Print text uncut, for a search: `findLines` cuts each line around its match. */
  uncut?: boolean | undefined;
  /** Which links show their address: every one, or only those a same-named link makes ambiguous. Default: none. */
  linkAddresses?: 'all' | 'ambiguous' | undefined;
  /** The page's address: same-site link addresses print relative to it. */
  pageUrl?: string | undefined;
}

/** The element a ref pointed at is no longer in the page. */
export class RefGoneError extends Error {}

const MAX_NAME = 160;
/** A line of text: long enough for a paragraph, so an answer in one is not cut off mid-sentence. */
const MAX_TEXT = 1_000;
const MAX_VALUE = 80;
const MAX_ADDRESS = 80;
/** Ends the elements a `depth` limit cut short. */
export const MORE_INSIDE = ' …';
const MAX_AX_DEPTH = 600;

const INTERACTIVE = new Set([
  'button',
  'link',
  'textbox',
  'searchbox',
  'combobox',
  'checkbox',
  'radio',
  'switch',
  'slider',
  'spinbutton',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'tab',
  'option',
  'treeitem',
  'listbox',
  'popupbutton',
  'disclosuretriangle',
  'colorwell',
  'date',
  'datetime',
  'inputtime',
  'time',
  'textfield',
]);
const VALUE_ROLES = new Set(['textbox', 'searchbox', 'combobox', 'spinbutton', 'slider', 'textfield']);
/** Their text content is their value, which the line already shows. */
const VALUE_ONLY_CHILDREN = new Set(['textbox', 'searchbox', 'spinbutton', 'textfield']);
/** Shown with a ref when they have a name (and always in `all` mode for the landmarks). */
const CONTAINERS = new Set([
  'form',
  'region',
  'main',
  'navigation',
  'banner',
  'contentinfo',
  'complementary',
  'search',
  'table',
  'grid',
  'list',
  'article',
  'tabpanel',
  'tablist',
  'menu',
  'menubar',
  'toolbar',
  'tree',
  'group',
  'figure',
]);
const LANDMARKS = new Set(['main', 'navigation', 'banner', 'contentinfo', 'complementary', 'search', 'form']);
const ALWAYS_CONTAINERS = new Set(['dialog', 'alertdialog']);
/** Not shown on their own; whatever they hold is. */
const WRAPPERS = new Set([
  'generic',
  'none',
  'presentation',
  'rootwebarea',
  'webarea',
  'document',
  'paragraph',
  'labeltext',
  'legend',
  'row',
  'rowgroup',
  'cell',
  'gridcell',
  'columnheader',
  'rowheader',
  'listitem',
  'menulistpopup',
]);
/** Dropped with everything below them. A line break is not printed on its own, but is a space in a line of text. */
const SKIP = new Set(['inlinetextbox', 'linebreak', 'listmarker']);
/** Live regions: what they say is the page's answer to the last thing done (an error, a count, a saved note). */
const LIVE_ROLES = new Set(['alert', 'status', 'log']);
/** Live regions that say one thing at a time: one short message prints on one line. A log keeps its entries apart. */
const MESSAGE_ROLES = new Set(['alert', 'status']);
/**
 * Text-level elements that never start a block, so their text runs on from the text beside them with no space added:
 * `<em>Java</em>Script`, `H<sub>2</sub>O`. Chromium keeps the real spaces of inline text in the text itself.
 */
const INLINE_ROLES = new Set(['emphasis', 'strong', 'subscript', 'superscript', 'code', 'mark', 'abbr', 'time', 'insertion', 'deletion']);
/** Roles whose own text is part of a line of text. */
const TEXT_ROLES = new Set(['statictext', 'linebreak']);
/** Roles that start a block of their own: their text is never run together with the text around them. */
const BLOCKS = new Set([
  'paragraph',
  'listitem',
  'row',
  'rowgroup',
  'cell',
  'gridcell',
  'columnheader',
  'rowheader',
  'labeltext',
  'legend',
  'blockquote',
  'caption',
  'term',
  'definition',
  'list',
  'table',
  'grid',
  'heading',
  'figure',
  'article',
  'region',
  'section',
  'group',
  'form',
  'main',
  'navigation',
  'banner',
  'contentinfo',
  'complementary',
  'search',
  'alert',
  'status',
  'log',
]);
/** Text inside these is the page's main content, shown first when not all of the page's text fits. */
const MAIN_ROLES = new Set(['main', 'article']);
/** Landmarks whose fields and buttons belong together: an outline keeps all of them. */
const FORM_ROLES = new Set(['form', 'search']);
/** Landmarks around a page's content: their long lists of links give way first. */
const CHROME_ROLES = new Set(['navigation', 'banner', 'contentinfo', 'complementary']);
/** Fewest links or buttons a list must hold to be folded to one line. */
const MIN_GROUP = 8;
/** Characters of names a folded list's line shows. */
const GROUP_PREVIEW = 80;
/** The name of a link that moves on through a list: its next page, more of it. */
const ONWARD = /\b(next|more|older|newer|previous|prev|load|show all|see all|view all|page \d+)\b|[›»→]/i;
/** Least text outside a list in the main content that folding the list makes room for. */
const MIN_TEXT_ROOM = 1_000;
/** What a folded list may hold: elements an agent finds again by reading its ref or with `find`. */
export const GROUP_ROLES = new Set(['link', 'button', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab', 'option', 'treeitem', 'disclosuretriangle', 'popupbutton']);
/** A list holding one of these is not folded: headings, fields, and the elements a page says something with. */
const BLOCKING_ROLES = new Set([
  'heading',
  'textbox',
  'searchbox',
  'combobox',
  'checkbox',
  'radio',
  'switch',
  'slider',
  'spinbutton',
  'listbox',
  'textfield',
  'colorwell',
  'date',
  'datetime',
  'inputtime',
  'time',
  'dialog',
  'alertdialog',
  'alert',
  'status',
  'log',
]);

type Kind = 'interactive' | 'container' | 'heading' | 'text' | 'other' | 'skip' | 'hoist';

/**
 * Text a reply shows before any other text when not all of it fits: the text of a live region or a dialog. `start` keeps
 * its first lines, `end` (a log, whose newest entries come last) its last ones.
 */
export type Keep = false | 'start' | 'end';

interface Item {
  indent: number;
  line: string;
  isText: boolean;
  name: string;
  keep: Keep;
  main: boolean;
  /** The role of the element on this line; empty for text. */
  role: string;
  /** Inside a form or search landmark. */
  form: boolean;
  /** The node whose own line this is. */
  source?: AxNode | undefined;
}

/** One printed line, and what a size budget needs to know about it. */
export interface RenderedLine {
  line: string;
  /** Plain text, not an element or a heading. */
  text: boolean;
  /** Text of a live region or a dialog, shown first. */
  keep: Keep;
  /** Inside the page's `main` or an `article`. */
  main: boolean;
  /** In a search, the line with the address of every link written into it, which `find` searches. */
  search?: string | undefined;
  /** The role of the element on this line: empty for text, `group` for a folded list's line. */
  role: string;
  /** Inside a form or search landmark. */
  form: boolean;
}

/** Where a node sits: what its lines inherit from the nodes above it. */
interface Context {
  level: number;
  ancestorName: string;
  /** The value of the nearest field above: text inside it repeating that value says nothing the field's line does not. */
  value: string;
  axDepth: number;
  keep: Keep;
  main: boolean;
  /** Inside a navigation, banner, footer or sidebar landmark. */
  chrome: boolean;
  /** Inside a form or search landmark. */
  form: boolean;
}

/**
 * The text of a node that holds nothing but text, with its whitespace runs already one space, and whether a block of
 * its own is somewhere inside it.
 */
interface Inline {
  text: string;
  blocks: boolean;
  /** Letters and digits outside link names and inside them: text is prose when its own words outweigh its links'. */
  words: number;
  linkWords: number;
  links: number;
  /** Whether its first words are a link's: a line headed by a link (a product, a story) is that link's, not prose. */
  linkFirst: boolean;
}

/** A piece of a line of text: text, or a node whose text runs on with it (a link, a `<b>`), kept to visit on its own. */
interface Piece {
  inline: Inline;
  node?: AxNode;
}

/**
 * A long list of links or buttons in a view (a menu, a sidebar, a footer, a table of files): its lines can give way to
 * one line that counts them and names the ref that lists them, so the page's text has room.
 */
export interface Group {
  /** Its lines, `lines[start]` up to but not including `lines[end]`. */
  start: number;
  end: number;
  /** Outside the page's main content, or in a navigation, banner, footer or sidebar landmark: given way first. */
  chrome: boolean;
  /** The line that stands for the group; it hands out the group's ref. */
  summary: () => RenderedLine;
}

/** A view: its lines, and the long lists of links or buttons in it, which never overlap. */
export interface View {
  lines: RenderedLine[];
  groups: Group[];
}

/** The page as one line per shown node, indented by nesting, with refs on the elements an agent can act on. */
export function renderTree(nodes: AxNode[], refs: RefTable, options: RenderOptions): string[] {
  return renderLines(nodes, refs, options).map((item) => item.line);
}

/** `renderTree`, with each line marked as text or not, so a reply can leave text out to stay short. */
export function renderLines(nodes: AxNode[], refs: RefTable, options: RenderOptions): RenderedLine[] {
  return renderView(nodes, refs, options).lines;
}

/** `renderLines`, and the long lists of links or buttons in the view, which `collapseGroups` can fold away. */
export function renderView(nodes: AxNode[], refs: RefTable, options: RenderOptions): View {
  const byId = new Map<string, AxNode>();
  for (const node of nodes) byId.set(node.id, node);
  const root = options.target === undefined ? nodes[0] : nodes.find((node) => node.backendId === options.target && node.ignored !== true);
  if (root === undefined) {
    if (options.target !== undefined) throw new RefGoneError('The element is no longer on the page');
    return { lines: [], groups: [] };
  }

  const items: Item[] = [];
  /** The lines each node printed, for finding the long lists of links among them. */
  const spans: Span[] = [];
  const seen = new Set<string>();
  const limit = (text: string, max: number): string => (options.uncut === true ? text : truncate(text, max));
  const showAddress = addressRule(nodes, options);
  // A link in a line of text is written into it, `[name](e12)`; its ref is the one its own line would carry. Its address
  // shows only where its name is ambiguous, in a search too: prose holds many links, and reading one's ref shows it.
  const markAddress = options.linkAddresses === 'all' ? addressRule(nodes, { ...options, linkAddresses: 'ambiguous' }) : showAddress;
  /** In a search, the address of each link written into text without one, so the search still finds it. */
  const searchAddress = new Map<string, string>();
  const linkMark = (node: AxNode): string | undefined => {
    const name = normalize(node.name);
    if (name === '' || node.backendId === undefined || flagList(node.props).length > 0) return undefined;
    const ref = refs.refFor(node.backendId);
    const address = markAddress(node);
    const full = showAddress(node);
    if (address === undefined && full !== undefined) searchAddress.set(ref, full);
    // The name is escaped like all text, so neither a page's text nor a link's name can pass for a link.
    return `[${escapeMarks(limit(name, MAX_NAME))}](${ref}${address === undefined ? '' : ` → ${address}`})`;
  };
  const inline = inlineText(byId, options.all, linkMark);
  /** How many nodes the depth limit has hidden so far. */
  let hidden = 0;

  const visitChildren = (node: AxNode, at: Context): void => {
    const inner = { ...at, axDepth: at.axDepth + 1 };
    // Text, and the links and text-level elements it flows around, run on as the page wrote them: Chromium keeps
    // their real spaces in the text.
    const flows = node.children.some((id) => {
      const child = byId.get(id);
      return child !== undefined && child.ignored !== true && TEXT_ROLES.has(child.role.toLowerCase());
    });
    let run: Piece[] = [];
    const flush = (): void => {
      if (run.length > 0) emitRun(run, inner);
      run = [];
    };
    for (const childId of node.children) {
      const child = byId.get(childId);
      if (child === undefined) continue;
      const role = child.ignored === true ? '' : child.role.toLowerCase();
      if (TEXT_ROLES.has(role)) {
        run.push({ inline: plainInline(role === 'linebreak' ? ' ' : escapeMarks(collapse(child.name))) });
        continue;
      }
      const joins = flows && !BLOCKS.has(role) ? inline.of(child, true) : undefined;
      if (joins !== undefined && !joins.blocks) {
        run.push({ inline: joins, node: child });
        continue;
      }
      flush();
      visit(child, inner, false);
    }
    flush();
  };

  /**
   * Prints a run of pieces as lines of text, its links written in, when it is prose. Otherwise its links (and the
   * elements holding them) print on lines of their own, between the text around them, so a list of links stays a list.
   */
  const emitRun = (run: Piece[], at: Context): void => {
    if (isProse(sumInline(run.map((piece) => piece.inline)))) {
      // A paragraph too long for one line is cut between pieces, never inside a link.
      let line: Inline[] = [];
      let length = 0;
      for (const piece of run) {
        if (line.length > 0 && length + piece.inline.text.length > MAX_TEXT) {
          emitText(sumInline(line), at);
          line = [];
          length = 0;
        }
        line.push(piece.inline);
        length += piece.inline.text.length;
      }
      if (line.length > 0) emitText(sumInline(line), at);
      return;
    }
    let text: Inline[] = [];
    for (const piece of run) {
      if (piece.node === undefined) {
        text.push(piece.inline);
        continue;
      }
      if (text.length > 0) emitText(sumInline(text), at);
      text = [];
      visit(piece.node, at, false);
    }
    if (text.length > 0) emitText(sumInline(text), at);
  };

  const emitText = (inline: Inline, at: Context): void => {
    const text = normalize(inline.text);
    const plain = unescapeMarks(text);
    // Separators such as `|`, `(` or `·` between links say nothing on a line of their own.
    if (!/[\p{L}\p{N}]/u.test(text) || (at.ancestorName !== '' && at.ancestorName.includes(plain)) || plain === at.value) return;
    if (options.depth !== undefined && at.level > options.depth) {
      hidden += 1;
      return;
    }
    items.push({
      indent: at.level,
      line: JSON.stringify(limit(text, MAX_TEXT)),
      isText: true,
      name: plain,
      keep: at.keep,
      main: at.main,
      role: '',
      form: at.form,
    });
  };

  /** A node that holds only text and the links in it, short enough for one line, prints as that one line. */
  const emitInline = (node: AxNode, at: Context): boolean => {
    if (node.role.toLowerCase() === 'row') return emitRow(node, at);
    const text = inline.of(node);
    if (text === undefined || text.blocks || !isProse(text)) return false;
    emitText(text, at);
    return true;
  };

  /** A table row of text cells prints as one line, its cells apart by `|`. */
  const emitRow = (node: AxNode, at: Context): boolean => {
    const cells: Inline[] = [];
    for (const child of visibleChildren(node, byId)) {
      const cell = inline.of(child);
      if (cell === undefined || cell.blocks) return false;
      cells.push({ ...cell, text: normalize(cell.text) });
    }
    if (cells.length < 2) return false;
    const row = sumInline(cells, ' | ');
    if (normalize(row.text).length > MAX_TEXT || !isProse(row)) return false;
    if (cells.some((cell) => cell.text !== '')) emitText(row, at);
    return true;
  };

  const visit = (node: AxNode, outer: Context, force: boolean): void => {
    const start = items.length;
    const role = node.role.toLowerCase();
    const at: Context = {
      ...outer,
      main: outer.main || MAIN_ROLES.has(role),
      chrome: outer.chrome || CHROME_ROLES.has(role),
      form: outer.form || FORM_ROLES.has(role),
    };
    visitNode(node, at, force);
    if (node.ignored !== true && node.backendId !== undefined && items.length - start >= MIN_GROUP) {
      spans.push({ node, start, end: items.length, main: at.main, chrome: at.chrome });
    }
  };

  const visitNode = (node: AxNode, outer: Context, force: boolean): void => {
    if (outer.axDepth > MAX_AX_DEPTH || seen.has(node.id)) return;
    seen.add(node.id);
    if (node.ignored === true) {
      visitChildren(node, outer);
      return;
    }
    const role = node.role.toLowerCase();
    const keep: Keep = role === 'log' ? 'end' : outer.keep !== false ? outer.keep : isLive(node) || ALWAYS_CONTAINERS.has(role) ? 'start' : false;
    const at: Context = { ...outer, keep };
    let kind = classify(node, options.all);
    if (force && (kind === 'hoist' || kind === 'text' || kind === 'skip')) kind = 'other';
    switch (kind) {
      case 'skip':
        return;
      case 'hoist':
        if (!emitInline(node, at)) visitChildren(node, at);
        return;
      case 'text':
        emitText(plainInline(escapeMarks(node.name)), at);
        return;
      default: {
        if (options.depth !== undefined && at.level > options.depth) {
          hidden += 1;
          return;
        }
        let name = normalize(node.name);
        // A live region that says one short thing prints it on one line, `alert "Wrong password."`, with no ref: there
        // is nothing in it to act on or read further. An empty one prints nothing.
        const said = MESSAGE_ROLES.has(role) && name === '' ? inline.contents(node) : undefined;
        const oneLine = said !== undefined && !said.blocks && said.links === 0;
        if (oneLine) {
          name = normalize(said.text);
          if (name === '') return;
        }
        if (role === 'log' && name === '' && inline.contents(node)?.text.trim() === '') return;
        const item: Item = {
          indent: at.level,
          line: oneLine ? `${role} ${JSON.stringify(limit(name, MAX_TEXT))}` : elementLine(node, kind, name, refs, limit, showAddress(node)),
          isText: false,
          name,
          keep: at.keep,
          main: at.main,
          role,
          form: at.form,
          source: node,
        };
        items.push(item);
        if (oneLine || VALUE_ONLY_CHILDREN.has(role)) return;
        const hiddenBefore = hidden;
        const value = VALUE_ROLES.has(role) && node.value !== undefined ? normalize(node.value) : at.value;
        visitChildren(node, { ...at, level: at.level + 1, ancestorName: name !== '' ? name : at.ancestorName, value });
        if (at.level === options.depth && hidden > hiddenBefore) item.line += MORE_INSIDE;
      }
    }
  };

  visit(root, { level: 0, ancestorName: '', value: '', axDepth: 0, keep: false, main: false, chrome: false, form: false }, options.target !== undefined);
  const kept = dropLabelEchoes(items);
  const lines = kept.map(renderedLine);
  if (searchAddress.size > 0) {
    for (const line of lines) {
      if (!line.text) continue;
      const search = line.line.replace(LINK_MARK, (mark: string, ref: string) => {
        const address = searchAddress.get(ref);
        return address === undefined ? mark : `${mark} → ${address}`;
      });
      if (search !== line.line) line.search = search;
    }
  }
  return { lines, groups: findGroups(items, kept, spans.filter((span) => span.node !== root), refs) };
}

function renderedLine(item: Item): RenderedLine {
  return { line: `${'  '.repeat(item.indent)}${item.line}`, text: item.isText, keep: item.keep, main: item.main, role: item.role, form: item.form };
}

/** The lines one node printed, `items[start]` up to `items[end]`. */
interface Span {
  node: AxNode;
  start: number;
  end: number;
  main: boolean;
  chrome: boolean;
}

/**
 * The long lists of links or buttons in a view: the outermost nodes below the root whose lines hold at least `MIN_GROUP`
 * of them, nothing else an agent needs in view (no heading, field, live region or dialog), and no more text than links.
 */
function findGroups(items: Item[], kept: Item[], spans: Span[], refs: RefTable): Group[] {
  const index = new Map<Item, number>();
  kept.forEach((item, at) => index.set(item, at));
  // How many links or buttons, lines that keep a list in view, and characters of text and of elements come before each line.
  const actionsBefore = [0];
  const blockersBefore = [0];
  const textBefore = [0];
  const elementsBefore = [0];
  for (const item of items) {
    actionsBefore.push((actionsBefore.at(-1) ?? 0) + Number(GROUP_ROLES.has(item.role)));
    blockersBefore.push((blockersBefore.at(-1) ?? 0) + Number(item.keep !== false || BLOCKING_ROLES.has(item.role)));
    textBefore.push((textBefore.at(-1) ?? 0) + (item.isText ? item.line.length : 0));
    elementsBefore.push((elementsBefore.at(-1) ?? 0) + (item.isText ? 0 : item.line.length));
  }
  const count = (before: number[], span: Span): number => (before[span.end] ?? 0) - (before[span.start] ?? 0);
  // Without a main landmark, nothing on the page is known to be around its content.
  const hasMain = items.some((item) => item.main);
  // Outermost first; of nodes that printed the same lines, the innermost, which names the list best.
  const ordered = spans.map((span, order) => ({ span, order })).sort((a, b) => a.span.start - b.span.start || b.span.end - a.span.end || a.order - b.order);
  const groups: Group[] = [];
  let taken = -1;
  for (const { span } of ordered) {
    // A list, not a section: no more of its text than of its links.
    if (span.start < taken || count(actionsBefore, span) < MIN_GROUP || count(blockersBefore, span) > 0) continue;
    if (count(textBefore, span) > count(elementsBefore, span)) continue;
    const members = items.slice(span.start, span.end);
    const actions = members.filter((item) => GROUP_ROLES.has(item.role));
    const shown = members.filter((item) => index.has(item));
    const first = shown[0];
    const last = shown.at(-1);
    if (first === undefined || last === undefined) continue;
    taken = span.end;
    const start = index.get(first) ?? 0;
    const end = (index.get(last) ?? 0) + 1;
    groups.push({
      start,
      end,
      chrome: span.chrome || (hasMain && !span.main),
      summary: () => groupSummary(span.node, first, actions, refs),
    });
  }
  return groups;
}

/** One line for a group: its own line when it has one, else a ref for it, then how many links or buttons it holds. */
function groupSummary(node: AxNode, first: Item, actions: Item[], refs: RefTable): RenderedLine {
  const own = first.source === node;
  const ref = refs.refFor(node.backendId ?? 0);
  const role = node.role.toLowerCase();
  const head = own ? first.line : `${ref} ${WRAPPERS.has(role) ? 'group' : role}`;
  const counts = new Map<string, number>();
  for (const item of actions) counts.set(item.role, (counts.get(item.role) ?? 0) + 1);
  const count = [...counts]
    .sort((a, b) => b[1] - a[1])
    .map(([role, n]) => `${n} ${n === 1 ? role : `${role}s`}`)
    .join(', ');
  const names: string[] = [];
  let length = 0;
  for (const item of actions) {
    if (item.name === '') continue;
    const name = JSON.stringify(truncate(item.name, 40));
    if (length + name.length > GROUP_PREVIEW) break;
    names.push(name);
    length += name.length + 2;
  }
  // A list's last link often moves on (Next, More, Older): it stays named, so folding never hides the way forward.
  const last = actions.at(-1);
  const onward = last !== undefined && last.name !== '' && names.length < actions.length && ONWARD.test(last.name);
  const more = names.length < actions.length ? `, …${onward && last !== undefined ? `, ${JSON.stringify(truncate(last.name, 40))}` : ''}` : '';
  const line = `${head} (${count}; read ${ref})${names.length > 0 ? `: ${names.join(', ')}${more}` : ''}`;
  return { line: `${'  '.repeat(first.indent)}${line}`, text: false, keep: false, main: first.main, role: 'group', form: first.form };
}

/**
 * The view with as many groups folded to one line each as it takes for its elements and `textBudget` characters of its
 * text (or all of it, if less) to fit in `room`: first those outside the page's main content, then the rest, largest
 * first. A group in the main content is folded only to make room for text outside it: where the page is mostly its
 * links (the stories of a news site, the results of a search), they stay, and a cut at the cap still shows the first.
 * Also returns the text lines inside the folded groups, which the reply counts as left out.
 */
export function collapseGroups(view: View, room: number, textBudget: number): { lines: RenderedLine[]; folded: string[] } {
  const size = (line: RenderedLine): number => line.line.length + 1;
  let elements = 0;
  let text = 0;
  for (const line of view.lines) {
    if (line.text) text += size(line);
    else elements += size(line);
  }
  const fits = (): boolean => elements + Math.min(textBudget, text) <= room;
  if (fits()) return { lines: view.lines, folded: [] };
  const measured = view.groups.map((group) => {
    let groupElements = 0;
    let groupText = 0;
    for (const line of view.lines.slice(group.start, group.end)) {
      if (line.text) groupText += size(line);
      else groupElements += size(line);
    }
    return { group, elements: groupElements, text: groupText };
  });
  const candidates = measured
    .filter((item) => item.group.chrome || text - item.text >= MIN_TEXT_ROOM)
    .sort((a, b) => Number(b.group.chrome) - Number(a.group.chrome) || b.elements - a.elements);
  const folded = new Map<number, RenderedLine>();
  for (const item of candidates) {
    if (fits()) break;
    const summary = item.group.summary();
    if (size(summary) >= item.elements) continue;
    folded.set(item.group.start, summary);
    elements -= item.elements - size(summary);
    text -= item.text;
  }
  if (folded.size === 0) return { lines: view.lines, folded: [] };
  const out: RenderedLine[] = [];
  // The text a folded list held, for the note that says what a reply left out.
  const foldedText: string[] = [];
  for (let at = 0; at < view.lines.length; at += 1) {
    const summary = folded.get(at);
    const line = view.lines[at];
    if (summary === undefined) {
      if (line !== undefined) out.push(line);
      continue;
    }
    out.push(summary);
    const end = view.groups.find((group) => group.start === at)?.end ?? at + 1;
    for (const inside of view.lines.slice(at, end)) if (inside.text) foldedText.push(inside.line);
    at = end - 1;
  }
  return { lines: out, folded: foldedText };
}

/** An `aria-live` region that announces its changes, or a role that does. */
function isLive(node: AxNode): boolean {
  const live = node.props?.live;
  return live === 'polite' || live === 'assertive' || LIVE_ROLES.has(node.role.toLowerCase());
}

/** The children of a node, looking through ignored ones. */
function visibleChildren(node: AxNode, byId: Map<string, AxNode>, depth = 0): AxNode[] {
  const out: AxNode[] = [];
  for (const id of node.children) {
    const child = byId.get(id);
    if (child === undefined || child === node || depth > MAX_AX_DEPTH) continue;
    if (child.ignored === true) out.push(...visibleChildren(child, byId, depth + 1));
    else out.push(child);
  }
  return out;
}

/**
 * The text of a node with nothing inside it but text and the wrappers around text, or `undefined` when something
 * inside it prints a line of its own (an element, a heading, a named container) or its text is longer than a line.
 * `contents` is the same for what a node holds, whatever the node itself is. Each node's text is built once and never
 * grows past a line, so a page of many small text nodes (highlighted code) costs time in proportion to its size.
 *
 * Pieces run together with no space added where they flow as one line of text: Chromium keeps the real spaces of
 * inline text in the text itself (`$<span>1,284</span>.50` is "$", "1,284", ".50"). They flow when the node holds text
 * of its own beside them, or when both are text-level elements (`<em>`, `<sub>`). Boxes side by side with nothing
 * between them (flex items, block `<div>`s, inline blocks: "Price" and "$5") are apart by a space, as on screen.
 */
function inlineText(
  byId: Map<string, AxNode>,
  all: boolean,
  linkMark: (node: AxNode) => string | undefined,
): { of: (node: AxNode, inFlow?: boolean) => Inline | undefined; contents: (node: AxNode) => Inline | undefined } {
  const memo = new Map<string, Inline | null>();
  const busy = new Set<string>();
  /** `inFlow`: the node sits in running text, so a link inside it is part of that text. */
  const contents = (node: AxNode, depth: number, inFlow: boolean): Inline | undefined => {
    const children: AxNode[] = [];
    for (const id of node.children) {
      const child = byId.get(id);
      if (child !== undefined) children.push(child);
    }
    const flows = children.some((child) => child.ignored !== true && TEXT_ROLES.has(child.role.toLowerCase()));
    const line = new LineText();
    let blocks = false;
    let previousFlows = false;
    let words = 0;
    let linkWords = 0;
    let links = 0;
    let linkFirst: boolean | undefined;
    for (const child of children) {
      const role = child.ignored === true ? '' : child.role.toLowerCase();
      const block = BLOCKS.has(role);
      const inner = of(child, depth + 1, !block && (flows || inFlow));
      if (inner === undefined) return undefined;
      const flowing = !block && (flows || TEXT_ROLES.has(role) || INLINE_ROLES.has(role));
      if (!line.add(inner.text, !(flowing && previousFlows))) return undefined;
      previousFlows = flowing;
      blocks ||= inner.blocks || block;
      words += inner.words;
      linkWords += inner.linkWords;
      links += inner.links;
      if (linkFirst === undefined && inner.words + inner.linkWords > 0) linkFirst = inner.linkFirst;
    }
    return { text: line.text(), blocks, words, linkWords, links, linkFirst: linkFirst ?? false };
  };
  const of = (node: AxNode, depth: number, inFlow: boolean): Inline | undefined => {
    const key = inFlow ? `${node.id} flow` : node.id;
    const known = memo.get(key);
    if (known !== undefined) return known ?? undefined;
    if (busy.has(node.id) || depth > MAX_AX_DEPTH) return plainInline('');
    busy.add(node.id);
    const role = node.role.toLowerCase();
    let result: Inline | undefined;
    if (node.ignored === true) result = contents(node, depth, inFlow);
    else if (role === 'linebreak') result = plainInline(' ');
    else if (SKIP.has(role)) result = plainInline('');
    else if (role === 'statictext') {
      const text = collapse(node.name);
      result = text.trim().length > MAX_TEXT ? undefined : plainInline(escapeMarks(text));
    } else if (role === 'link') result = inFlow ? linkInline(node, contents(node, depth, false), linkMark) : undefined;
    else if (classify(node, all) === 'hoist') result = contents(node, depth, inFlow);
    busy.delete(node.id);
    memo.set(key, result ?? null);
    return result;
  };
  return { of: (node, inFlow = false) => of(node, 0, inFlow), contents: (node) => contents(node, 0, false) };
}

/** A link with only text inside, written into the text around it; `undefined` for one that needs a line of its own. */
function linkInline(node: AxNode, inside: Inline | undefined, linkMark: (node: AxNode) => string | undefined): Inline | undefined {
  if (inside === undefined || inside.blocks || inside.links > 0) return undefined;
  const mark = linkMark(node);
  return mark === undefined ? undefined : { text: mark, blocks: false, words: 0, linkWords: wordCount(node.name), links: 1, linkFirst: true };
}

function plainInline(text: string): Inline {
  return { text, blocks: false, words: wordCount(text), linkWords: 0, links: 0, linkFirst: false };
}

/** Pieces as one: their text run on (or apart by `separator`), their counts added. */
function sumInline(pieces: Inline[], separator = ''): Inline {
  return {
    text: pieces.map((piece) => piece.text).join(separator),
    blocks: pieces.some((piece) => piece.blocks),
    words: pieces.reduce((sum, piece) => sum + piece.words, 0),
    linkWords: pieces.reduce((sum, piece) => sum + piece.linkWords, 0),
    links: pieces.reduce((sum, piece) => sum + piece.links, 0),
    linkFirst: pieces.find((piece) => piece.words + piece.linkWords > 0)?.linkFirst ?? false,
  };
}

/**
 * Text that is mostly its own words, with links in it (a paragraph), rather than mostly links with a little text
 * between them (a menu, a list of stories) or a link with a line about it (a product, a search result): the first prints
 * as one line with its links written in.
 */
function isProse(inline: Inline): boolean {
  return inline.links === 0 || (!inline.linkFirst && inline.words >= inline.linkWords);
}

function wordCount(text: string): number {
  return text.match(/[\p{L}\p{N}]/gu)?.length ?? 0;
}

/** A line of text built from pieces whose whitespace runs are one space; it refuses to grow past `MAX_TEXT`. */
class LineText {
  private readonly parts: string[] = [];
  private length = 0;
  private endsInSpace = true;

  /** Adds a piece, after a space when `apart` and there is none at the joint. False once the line is too long. */
  add(piece: string, apart: boolean): boolean {
    let text = piece;
    if (this.endsInSpace && text.startsWith(' ')) text = text.slice(1);
    else if (apart && !this.endsInSpace && text !== '' && !text.startsWith(' ')) text = ` ${text}`;
    if (text === '') return true;
    this.parts.push(text);
    this.length += text.length;
    this.endsInSpace = text.endsWith(' ');
    // A space may sit at each end; it is trimmed when the line is printed.
    return this.length <= MAX_TEXT + 2;
  }

  text(): string {
    return this.parts.join('');
  }
}

/** Whitespace runs as one space, with the ends kept: whether a piece starts or ends in a space decides how it joins. */
function collapse(value: string): string {
  return value.replace(/\p{Co}/gu, '').replace(/\s+/g, ' ');
}

function classify(node: AxNode, all: boolean): Kind {
  const role = node.role.toLowerCase();
  const named = normalize(node.name) !== '';
  if (SKIP.has(role)) return 'skip';
  if (INTERACTIVE.has(role)) return 'interactive';
  if (role === 'heading') return named ? 'heading' : 'hoist';
  if (role === 'statictext') return 'text';
  if (ALWAYS_CONTAINERS.has(role)) return 'container';
  if (LIVE_ROLES.has(role)) return 'container';
  if (CONTAINERS.has(role)) return named || (all && LANDMARKS.has(role)) ? 'container' : 'hoist';
  // With `all`, an image gets a ref even without a name, so it can be hovered or clicked.
  if (all && role === 'image') return 'other';
  if (all && named && !WRAPPERS.has(role)) return 'other';
  return 'hoist';
}

/** Decides which links print their address, so an agent can tell two links of the same name apart. */
function addressRule(nodes: AxNode[], options: RenderOptions): (node: AxNode) => string | undefined {
  if (options.linkAddresses === undefined) return () => undefined;
  const base = parseUrl(options.pageUrl);
  const address = (node: AxNode): string | undefined =>
    node.role.toLowerCase() === 'link' && typeof node.props?.url === 'string' ? shortAddress(node.props.url, base) : undefined;
  if (options.linkAddresses === 'all') return address;
  const byName = new Map<string, Set<string>>();
  for (const node of nodes) {
    // By the raw address: a link whose address is not printed still makes its name ambiguous.
    if (node.ignored === true || node.role.toLowerCase() !== 'link' || typeof node.props?.url !== 'string') continue;
    const name = normalize(node.name);
    byName.set(name, (byName.get(name) ?? new Set()).add(node.props.url));
  }
  return (node) => {
    const name = normalize(node.name);
    // The element the agent asked about by ref always says where it goes.
    const asked = options.target !== undefined && node.backendId === options.target;
    return asked || name === '' || (byName.get(name)?.size ?? 0) > 1 ? address(node) : undefined;
  };
}

function parseUrl(value: string | undefined): URL | undefined {
  if (value === undefined) return undefined;
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

const SHOWN_LINK_PROTOCOLS = new Set(['http:', 'https:', 'mailto:', 'tel:']);

/** A link's address, short: relative on the page's own site, never its credentials, and nothing that is not a place. */
function shortAddress(raw: string, base: URL | undefined): string | undefined {
  let url: URL;
  try {
    url = new URL(raw, base);
  } catch {
    return undefined;
  }
  if (!SHOWN_LINK_PROTOCOLS.has(url.protocol)) return undefined;
  url.username = '';
  url.password = '';
  const sameSite = base !== undefined && url.origin === base.origin;
  return truncate(sameSite ? `${url.pathname}${url.search}${url.hash}` : url.href, MAX_ADDRESS);
}

function elementLine(
  node: AxNode,
  kind: Kind,
  name: string,
  refs: RefTable,
  limit: (text: string, max: number) => string,
  address: string | undefined,
): string {
  const role = node.role.toLowerCase();
  const passwordField = node.props?.password === true || node.props?.password === 'true';
  if (kind === 'heading') {
    const level = node.props?.level;
    const marks = typeof level === 'number' ? Math.min(Math.max(Math.trunc(level), 1), 6) : 2;
    return `${'#'.repeat(marks)} ${escapeMarks(limit(name, MAX_NAME))}`;
  }
  const parts: string[] = [];
  if ((kind === 'interactive' || kind === 'container' || role === 'image') && node.backendId !== undefined) {
    parts.push(refs.refFor(node.backendId));
  }
  parts.push(role === 'image' ? 'img' : role);
  if (name !== '') parts.push(JSON.stringify(limit(name, MAX_NAME)));
  if (address !== undefined) parts.push(`→ ${address}`);
  if (passwordField) {
    parts.push('value=<redacted>');
  } else if (VALUE_ROLES.has(role) && node.value !== undefined && node.value !== '') {
    parts.push(`value=${JSON.stringify(limit(normalize(node.value), MAX_VALUE))}`);
  }
  const flags = flagList(node.props);
  if (flags.length > 0) parts.push(`[${flags.join(' ')}]`);
  return parts.join(' ');
}

function flagList(props: AxNode['props']): string[] {
  if (props === undefined) return [];
  const flags: string[] = [];
  const { checked, disabled, expanded, selected, pressed, required, readonly, invalid } = props;
  if (isTrue(checked)) flags.push('checked');
  else if (checked === 'mixed') flags.push('checked=mixed');
  if (isTrue(disabled)) flags.push('disabled');
  if (isTrue(expanded)) flags.push('expanded');
  else if (expanded !== undefined && isFalse(expanded)) flags.push('collapsed');
  if (isTrue(selected)) flags.push('selected');
  if (isTrue(pressed)) flags.push('pressed');
  else if (pressed === 'mixed') flags.push('pressed=mixed');
  if (isTrue(required)) flags.push('required');
  if (isTrue(readonly)) flags.push('readonly');
  if (isTrue(invalid)) flags.push('invalid');
  return flags;
}

function isTrue(value: string | number | boolean | undefined): boolean {
  return value === true || value === 'true';
}

function isFalse(value: string | number | boolean | undefined): boolean {
  return value === false || value === 'false';
}

/** A label's text sits right above the field it names; the field's line already says it. */
function dropLabelEchoes(items: Item[]): Item[] {
  return items.filter((item, index) => {
    if (!item.isText) return true;
    const next = items[index + 1];
    if (next === undefined || next.isText || next.name === '') return true;
    return stripColon(item.name).toLowerCase() !== next.name.toLowerCase();
  });
}

function stripColon(value: string): string {
  return value.endsWith(':') ? value.slice(0, -1).trimEnd() : value;
}

/**
 * Text with `[`, `]` and `\\` escaped by a backslash. Text lines and headings are escaped, so only T3-Tab's own marks,
 * `[name](e12)`, read as links: a page that writes `[Cancel](e2)` gets `\\[Cancel\\](e2)`.
 */
export function escapeMarks(value: string): string {
  return value.replace(/[\\[\]]/g, '\\$&');
}

function unescapeMarks(value: string): string {
  return value.replace(/\\([\\[\]])/g, '$1');
}

/**
 * A link written into a printed line of text: `](e12)` or `](e12 → /path)` closing a name. A printed text line is a JSON
 * string, which doubles every backslash, so a bracket the escaping kept (`\\]`) prints after 2, 6, 10… backslashes and a
 * mark's own after 0, 4, 8….
 */
export const LINK_MARK = /(?<!\\)(?:\\{4})*\]\((e\d+)(?=\)| →)/g;

/** Whitespace collapsed, and no private-use characters: icon fonts draw those, and they mean nothing as text. */
function normalize(value: string): string {
  return value.replace(/\p{Co}/gu, '').replace(/\s+/g, ' ').trim();
}

/** A field's value as a line shows it: whitespace collapsed and cut at `MAX_VALUE`. */
export function shownValue(value: string): string {
  return truncate(normalize(value), MAX_VALUE);
}

export function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}
