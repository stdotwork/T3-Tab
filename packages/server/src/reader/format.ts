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
}

/**
 * The text of a node that holds nothing but text, with its whitespace runs already one space, and whether a block of
 * its own is somewhere inside it.
 */
interface Inline {
  text: string;
  blocks: boolean;
}

/** The page as one line per shown node, indented by nesting, with refs on the elements an agent can act on. */
export function renderTree(nodes: AxNode[], refs: RefTable, options: RenderOptions): string[] {
  return renderLines(nodes, refs, options).map((item) => item.line);
}

/** `renderTree`, with each line marked as text or not, so a reply can leave text out to stay short. */
export function renderLines(nodes: AxNode[], refs: RefTable, options: RenderOptions): RenderedLine[] {
  const byId = new Map<string, AxNode>();
  for (const node of nodes) byId.set(node.id, node);
  const root = options.target === undefined ? nodes[0] : nodes.find((node) => node.backendId === options.target && node.ignored !== true);
  if (root === undefined) {
    if (options.target !== undefined) throw new RefGoneError('The element is no longer on the page');
    return [];
  }

  const items: Item[] = [];
  const seen = new Set<string>();
  const limit = (text: string, max: number): string => (options.uncut === true ? text : truncate(text, max));
  const showAddress = addressRule(nodes, options);
  const inline = inlineText(byId, options.all);
  /** How many nodes the depth limit has hidden so far. */
  let hidden = 0;

  const visitChildren = (node: AxNode, at: Context): void => {
    let run: string[] = [];
    const flush = (): void => {
      // Sibling text runs on as the page wrote it: Chromium keeps its real spaces in the text.
      if (run.length > 0) emitText(run.join(''), at);
      run = [];
    };
    for (const childId of node.children) {
      const child = byId.get(childId);
      if (child === undefined) continue;
      const role = child.ignored === true ? '' : child.role.toLowerCase();
      if (TEXT_ROLES.has(role)) {
        run.push(role === 'linebreak' ? ' ' : child.name);
        continue;
      }
      flush();
      visit(child, { ...at, axDepth: at.axDepth + 1 }, false);
    }
    flush();
  };

  const emitText = (raw: string, at: Context): void => {
    const text = normalize(raw);
    // Separators such as `|`, `(` or `·` between links say nothing on a line of their own.
    if (!/[\p{L}\p{N}]/u.test(text) || (at.ancestorName !== '' && at.ancestorName.includes(text)) || text === at.value) return;
    if (options.depth !== undefined && at.level > options.depth) {
      hidden += 1;
      return;
    }
    items.push({ indent: at.level, line: JSON.stringify(limit(text, MAX_TEXT)), isText: true, name: text, keep: at.keep, main: at.main });
  };

  /** A node that holds only text, short enough for one line, prints as that one line. */
  const emitInline = (node: AxNode, at: Context): boolean => {
    if (node.role.toLowerCase() === 'row') return emitRow(node, at);
    const text = inline.of(node);
    if (text === undefined || text.blocks) return false;
    emitText(text.text, at);
    return true;
  };

  /** A table row of text cells prints as one line, its cells apart by `|`. */
  const emitRow = (node: AxNode, at: Context): boolean => {
    const cells: string[] = [];
    for (const child of visibleChildren(node, byId)) {
      const cell = inline.of(child);
      if (cell === undefined || cell.blocks) return false;
      cells.push(normalize(cell.text));
    }
    if (cells.length < 2) return false;
    const line = cells.join(' | ');
    if (normalize(line).length > MAX_TEXT) return false;
    if (cells.some((cell) => cell !== '')) emitText(line, at);
    return true;
  };

  const visit = (node: AxNode, outer: Context, force: boolean): void => {
    if (outer.axDepth > MAX_AX_DEPTH || seen.has(node.id)) return;
    seen.add(node.id);
    if (node.ignored === true) {
      visitChildren(node, outer);
      return;
    }
    const role = node.role.toLowerCase();
    const keep: Keep = role === 'log' ? 'end' : outer.keep !== false ? outer.keep : isLive(node) || ALWAYS_CONTAINERS.has(role) ? 'start' : false;
    const at: Context = { ...outer, keep, main: outer.main || MAIN_ROLES.has(role) };
    let kind = classify(node, options.all);
    if (force && (kind === 'hoist' || kind === 'text' || kind === 'skip')) kind = 'other';
    switch (kind) {
      case 'skip':
        return;
      case 'hoist':
        if (!emitInline(node, at)) visitChildren(node, at);
        return;
      case 'text':
        emitText(node.name, at);
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
        const oneLine = said !== undefined && !said.blocks;
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

  visit(root, { level: 0, ancestorName: '', value: '', axDepth: 0, keep: false, main: false }, options.target !== undefined);
  return dropLabelEchoes(items).map((item) => ({
    line: `${'  '.repeat(item.indent)}${item.line}`,
    text: item.isText,
    keep: item.keep,
    main: item.main,
  }));
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
): { of: (node: AxNode) => Inline | undefined; contents: (node: AxNode) => Inline | undefined } {
  const memo = new Map<string, Inline | null>();
  const busy = new Set<string>();
  const contents = (node: AxNode, depth: number): Inline | undefined => {
    const children: AxNode[] = [];
    for (const id of node.children) {
      const child = byId.get(id);
      if (child !== undefined) children.push(child);
    }
    const flows = children.some((child) => child.ignored !== true && TEXT_ROLES.has(child.role.toLowerCase()));
    const line = new LineText();
    let blocks = false;
    let previousFlows = false;
    for (const child of children) {
      const role = child.ignored === true ? '' : child.role.toLowerCase();
      const inner = of(child, depth + 1);
      if (inner === undefined) return undefined;
      const block = BLOCKS.has(role);
      const flowing = !block && (flows || TEXT_ROLES.has(role) || INLINE_ROLES.has(role));
      if (!line.add(inner.text, !(flowing && previousFlows))) return undefined;
      previousFlows = flowing;
      blocks ||= inner.blocks || block;
    }
    return { text: line.text(), blocks };
  };
  const of = (node: AxNode, depth: number): Inline | undefined => {
    const known = memo.get(node.id);
    if (known !== undefined) return known ?? undefined;
    if (busy.has(node.id) || depth > MAX_AX_DEPTH) return { text: '', blocks: false };
    busy.add(node.id);
    const role = node.role.toLowerCase();
    let result: Inline | undefined;
    if (node.ignored === true) result = contents(node, depth);
    else if (role === 'linebreak') result = { text: ' ', blocks: false };
    else if (SKIP.has(role)) result = { text: '', blocks: false };
    else if (role === 'statictext') {
      const text = collapse(node.name);
      result = text.trim().length > MAX_TEXT ? undefined : { text, blocks: false };
    } else if (classify(node, all) === 'hoist') result = contents(node, depth);
    busy.delete(node.id);
    memo.set(node.id, result ?? null);
    return result;
  };
  return { of: (node) => of(node, 0), contents: (node) => contents(node, 0) };
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
    return `${'#'.repeat(marks)} ${limit(name, MAX_NAME)}`;
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
