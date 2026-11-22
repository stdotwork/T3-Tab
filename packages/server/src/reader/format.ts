import type { AxNode } from '@t3-tab/protocol';

import type { RefTable } from './refs.js';

export interface RenderOptions {
  /** Every node with text, not only interactive elements, headings and named containers. */
  all: boolean;
  /** Backend id of the element to read; its subtree is rendered instead of the page. */
  target?: number | undefined;
  /** Deepest level of shown nesting below the root, counting only shown nodes. */
  depth?: number | undefined;
}

/** The element a ref pointed at is no longer in the page. */
export class RefGoneError extends Error {}

const MAX_NAME = 160;
const MAX_TEXT = 400;
const MAX_VALUE = 80;
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
/** Dropped with everything below them. */
const SKIP = new Set(['inlinetextbox', 'linebreak', 'listmarker']);

type Kind = 'interactive' | 'container' | 'heading' | 'text' | 'other' | 'skip' | 'hoist';

interface Item {
  indent: number;
  line: string;
  isText: boolean;
  name: string;
}

/** The page as one line per shown node, indented by nesting, with refs on the elements an agent can act on. */
export function renderTree(nodes: AxNode[], refs: RefTable, options: RenderOptions): string[] {
  const byId = new Map<string, AxNode>();
  for (const node of nodes) byId.set(node.id, node);
  const root = options.target === undefined ? nodes[0] : nodes.find((node) => node.backendId === options.target && node.ignored !== true);
  if (root === undefined) {
    if (options.target !== undefined) throw new RefGoneError('The element is no longer on the page');
    return [];
  }

  const items: Item[] = [];
  const seen = new Set<string>();

  const visitChildren = (node: AxNode, level: number, ancestorName: string, axDepth: number): void => {
    let run: string[] = [];
    const flush = (): void => {
      if (run.length > 0) emitText(run.join(''), level, ancestorName);
      run = [];
    };
    for (const childId of node.children) {
      const child = byId.get(childId);
      if (child === undefined) continue;
      if (options.all && child.ignored !== true && child.role.toLowerCase() === 'statictext') {
        run.push(child.name);
        continue;
      }
      flush();
      visit(child, level, ancestorName, axDepth + 1, false);
    }
    flush();
  };

  const emitText = (raw: string, level: number, ancestorName: string): void => {
    if (options.depth !== undefined && level > options.depth) return;
    const text = normalize(raw);
    if (text === '' || (ancestorName !== '' && ancestorName.includes(text))) return;
    items.push({ indent: level, line: JSON.stringify(truncate(text, MAX_TEXT)), isText: true, name: text });
  };

  const visit = (node: AxNode, level: number, ancestorName: string, axDepth: number, force: boolean): void => {
    if (axDepth > MAX_AX_DEPTH || seen.has(node.id)) return;
    seen.add(node.id);
    if (node.ignored === true) {
      visitChildren(node, level, ancestorName, axDepth);
      return;
    }
    let kind = classify(node, options.all);
    if (force && (kind === 'hoist' || kind === 'text' || kind === 'skip')) kind = 'other';
    switch (kind) {
      case 'skip':
        return;
      case 'hoist':
        visitChildren(node, level, ancestorName, axDepth);
        return;
      case 'text':
        emitText(node.name, level, ancestorName);
        return;
      default: {
        if (options.depth !== undefined && level > options.depth) return;
        const name = normalize(node.name);
        items.push({ indent: level, line: elementLine(node, kind, name, refs), isText: false, name });
        if (VALUE_ONLY_CHILDREN.has(node.role.toLowerCase())) return;
        visitChildren(node, level + 1, name !== '' ? name : ancestorName, axDepth);
      }
    }
  };

  visit(root, 0, '', 0, options.target !== undefined);
  return dropLabelEchoes(items).map((item) => `${'  '.repeat(item.indent)}${item.line}`);
}

function classify(node: AxNode, all: boolean): Kind {
  const role = node.role.toLowerCase();
  const named = normalize(node.name) !== '';
  if (SKIP.has(role)) return 'skip';
  if (INTERACTIVE.has(role)) return 'interactive';
  if (role === 'heading') return named ? 'heading' : 'hoist';
  if (role === 'statictext') return all ? 'text' : 'hoist';
  if (ALWAYS_CONTAINERS.has(role)) return 'container';
  if (CONTAINERS.has(role)) return named || (all && LANDMARKS.has(role)) ? 'container' : 'hoist';
  if (all && named && !WRAPPERS.has(role)) return 'other';
  return 'hoist';
}

function elementLine(node: AxNode, kind: Kind, name: string, refs: RefTable): string {
  const role = node.role.toLowerCase();
  const passwordField = node.props?.password === true || node.props?.password === 'true';
  if (kind === 'heading') {
    const level = node.props?.level;
    const marks = typeof level === 'number' ? Math.min(Math.max(Math.trunc(level), 1), 6) : 2;
    return `${'#'.repeat(marks)} ${truncate(name, MAX_NAME)}`;
  }
  const parts: string[] = [];
  if ((kind === 'interactive' || kind === 'container') && node.backendId !== undefined) {
    parts.push(refs.refFor(node.backendId));
  }
  parts.push(role === 'image' ? 'img' : role);
  if (name !== '') parts.push(JSON.stringify(truncate(name, MAX_NAME)));
  if (passwordField) {
    parts.push('value=<redacted>');
  } else if (VALUE_ROLES.has(role) && node.value !== undefined && node.value !== '') {
    parts.push(`value=${JSON.stringify(truncate(normalize(node.value), MAX_VALUE))}`);
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

function normalize(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

export function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}
