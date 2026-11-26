import type { AxNode } from '@t3-tab/protocol';
import { describe, expect, it } from 'vitest';

import { RefGoneError, renderLines, renderTree } from '../src/reader/format.js';
import { RefTable } from '../src/reader/refs.js';
import { ax, signInPage } from './ax-fixtures.js';

describe('tree to text', () => {
  it('lists interactive elements with refs, headings and named containers as structure, and the text, without echoing labels or a control\'s own text', () => {
    const expected = ['# Sign in', 'e1 form "Login"', '  e2 textbox "Email" value="a@b.c" [required]', '  e3 button "Submit"', '"Hello there"'];
    expect(renderTree(signInPage(), new RefTable(), { all: false })).toEqual(expected);
    expect(renderTree(signInPage(), new RefTable(), { all: true })).toEqual(expected);
  });

  it('walks through ignored nodes and hoists unnamed wrappers', () => {
    const nodes = [
      ax(1, 'RootWebArea', '', [2]),
      ax(2, 'generic', '', [3], { ignored: true }),
      ax(3, 'generic', '', [4]),
      ax(4, 'button', 'Deep'),
    ];
    expect(renderTree(nodes, new RefTable(), { all: false })).toEqual(['e1 button "Deep"']);
  });

  it('merges text runs under one parent and drops text the nearest named ancestor already says', () => {
    const nodes = [
      ax(1, 'RootWebArea', '', [2, 5]),
      ax(2, 'paragraph', '', [3, 4]),
      ax(3, 'StaticText', 'Hello '),
      ax(4, 'StaticText', 'world'),
      ax(5, 'link', 'Read more about cats', [6, 7]),
      ax(6, 'StaticText', 'Read more '),
      ax(7, 'StaticText', 'about cats'),
    ];
    expect(renderTree(nodes, new RefTable(), { all: true })).toEqual(['"Hello world"', 'e1 link "Read more about cats"']);
  });

  it('prints state flags', () => {
    const nodes = [
      ax(1, 'RootWebArea', '', [2, 3, 4, 5, 6]),
      ax(2, 'checkbox', 'Agree', [], { props: { checked: 'true' } }),
      ax(3, 'checkbox', 'Some', [], { props: { checked: 'mixed' } }),
      ax(4, 'button', 'Menu', [], { props: { expanded: false, disabled: true } }),
      ax(5, 'option', 'Red', [], { props: { selected: true } }),
      ax(6, 'checkbox', 'Off', [], { props: { checked: 'false' } }),
    ];
    expect(renderTree(nodes, new RefTable(), { all: false })).toEqual([
      'e1 checkbox "Agree" [checked]',
      'e2 checkbox "Some" [checked=mixed]',
      'e3 button "Menu" [disabled collapsed]',
      'e4 option "Red" [selected]',
      'e5 checkbox "Off"',
    ]);
  });

  it('shows heading levels, escapes quotes and shortens long names', () => {
    const long = 'x'.repeat(300);
    const nodes = [
      ax(1, 'RootWebArea', '', [2, 3, 4]),
      ax(2, 'heading', 'Part two', [], { props: { level: 3 } }),
      ax(3, 'button', 'Say "hi"'),
      ax(4, 'link', long),
    ];
    const lines = renderTree(nodes, new RefTable(), { all: false });
    expect(lines[0]).toBe('### Part two');
    expect(lines[1]).toBe('e1 button "Say \\"hi\\""');
    expect(lines[2]?.length).toBeLessThan(180);
    expect(lines[2]).toMatch(/…"$/);
  });

  it('does not repeat a text field\'s value as its content', () => {
    const nodes = [
      ax(1, 'RootWebArea', '', [2]),
      ax(2, 'textbox', 'Name', [3], { value: 'Ada' }),
      ax(3, 'StaticText', 'Ada'),
    ];
    expect(renderTree(nodes, new RefTable(), { all: true })).toEqual(['e1 textbox "Name" value="Ada"']);
  });

  it('shows images in all mode only, each with a ref so it can be hovered or clicked', () => {
    const nodes = [ax(1, 'RootWebArea', '', [2, 3]), ax(2, 'image', 'A cat'), ax(3, 'image', '')];
    expect(renderTree(nodes, new RefTable(), { all: false })).toEqual([]);
    expect(renderTree(nodes, new RefTable(), { all: true })).toEqual(['e1 img "A cat"', 'e2 img']);
  });

  it('keeps unnamed interactive elements and always shows dialogs', () => {
    const nodes = [ax(1, 'RootWebArea', '', [2]), ax(2, 'dialog', '', [3]), ax(3, 'button', '')];
    expect(renderTree(nodes, new RefTable(), { all: false })).toEqual(['e1 dialog', '  e2 button']);
  });

  it('limits nesting by depth, counting shown nodes only', () => {
    const lines = renderTree(signInPage(), new RefTable(), { all: false, depth: 0 });
    expect(lines).toEqual(['# Sign in', 'e1 form "Login" …', '"Hello there"']);
    expect(renderTree(signInPage(), new RefTable(), { all: false, depth: 1 })).not.toContainEqual(expect.stringContaining('…'));
  });

  it('shows a link address only where the name does not tell links apart', () => {
    const link = (id: string, name: string, url: string, backendId: number): AxNode => ({ id, role: 'link', name, children: [], backendId, props: { url } });
    const nodes: AxNode[] = [
      { id: 'r', role: 'RootWebArea', name: '', children: ['1', '2', '3', '4', '5', '6'] },
      link('1', 'Edit', 'https://a.test/items/1?x=1', 11),
      link('2', 'Edit', 'https://a.test/items/2', 12),
      link('3', 'About', 'https://a.test/about', 13),
      link('4', '', 'https://user:pw@b.test/pic', 14),
      link('5', 'Run', 'javascript:alert(1)', 15),
      link('6', 'Run', 'https://a.test/run', 16),
    ];
    const options = { all: false, linkAddresses: 'ambiguous', pageUrl: 'https://a.test/list' } as const;
    expect(renderTree(nodes, new RefTable(), options)).toEqual([
      'e1 link "Edit" → /items/1?x=1',
      'e2 link "Edit" → /items/2',
      'e3 link "About"',
      'e4 link → https://b.test/pic',
      'e5 link "Run"',
      'e6 link "Run" → /run',
    ]);
    expect(renderTree(nodes, new RefTable(), { ...options, target: 13 })).toEqual(['e1 link "About" → /about']);
    expect(renderTree(nodes, new RefTable(), { all: false })).not.toContainEqual(expect.stringContaining('→'));
  });

  it('renders only the subtree of a target element, and reports one that is gone', () => {
    const refs = new RefTable();
    renderTree(signInPage(), refs, { all: false });
    expect(renderTree(signInPage(), refs, { all: false, target: 3 })).toEqual([
      'e1 form "Login"',
      '  e2 textbox "Email" value="a@b.c" [required]',
      '  e3 button "Submit"',
    ]);
    expect(() => renderTree(signInPage(), refs, { all: false, target: 999 })).toThrow(RefGoneError);
  });

  it('prints a live region that says one short thing on one line, and nothing for an empty one', () => {
    const nodes = [
      ax(1, 'RootWebArea', '', [2, 4, 5, 8]),
      ax(2, 'alert', '', [3]),
      ax(3, 'StaticText', 'Incorrect username or password.'),
      ax(4, 'status', '', []),
      ax(5, 'status', 'Cart', [6, 7]),
      ax(6, 'StaticText', '3 items'),
      ax(7, 'button', 'Undo'),
      ax(8, 'generic', '', [9], { props: { live: 'polite' } }),
      ax(9, 'StaticText', 'Step 1 of 4'),
    ];
    const lines = renderLines(nodes, new RefTable(), { all: false });
    expect(lines.map((item) => item.line)).toEqual([
      'alert "Incorrect username or password."',
      'e1 status "Cart"',
      '  "3 items"',
      '  e2 button "Undo"',
      '"Step 1 of 4"',
    ]);
    // The text of a live region is kept whatever a size budget leaves out.
    expect(lines.filter((item) => item.text).every((item) => item.keep)).toBe(true);
  });

  it('prints a long live message whole, up to a line of text', () => {
    const message = `Your session expired. ${'Sign in again to keep your changes. '.repeat(8)}`.trim();
    const nodes = [ax(1, 'RootWebArea', '', [2]), ax(2, 'status', '', [3]), ax(3, 'StaticText', message)];
    expect(renderTree(nodes, new RefTable(), { all: false })).toEqual([`status ${JSON.stringify(message)}`]);
  });

  it('marks the text of a dialog to keep and the text of the main content as main', () => {
    const nodes = [
      ax(1, 'RootWebArea', '', [2, 4, 6]),
      ax(2, 'paragraph', '', [3]),
      ax(3, 'StaticText', 'Header blurb'),
      ax(4, 'main', '', [5]),
      ax(5, 'StaticText', 'The article'),
      ax(6, 'dialog', 'Cookies', [7]),
      ax(7, 'StaticText', 'We use cookies.'),
    ];
    const lines = renderLines(nodes, new RefTable(), { all: false });
    expect(lines).toEqual([
      { line: '"Header blurb"', text: true, keep: false, main: false },
      { line: '"The article"', text: true, keep: false, main: true },
      { line: 'e1 dialog "Cookies"', text: false, keep: true, main: false },
      { line: '  "We use cookies."', text: true, keep: true, main: false },
    ]);
  });

  it('prints a table row of text cells as one line', () => {
    const nodes = [
      ax(1, 'RootWebArea', '', [2]),
      ax(2, 'table', 'Sales', [3, 4, 5]),
      ax(3, 'row', '', [10, 11]),
      ax(4, 'row', '', [12, 13]),
      ax(5, 'row', '', [14, 15]),
      ax(10, 'columnheader', '', [20]),
      ax(11, 'columnheader', '', [21]),
      ax(12, 'cell', '', [22]),
      ax(13, 'cell', '', [23]),
      ax(14, 'cell', '', [24]),
      ax(15, 'cell', '', [25]),
      ax(20, 'StaticText', 'Region'),
      ax(21, 'StaticText', 'Revenue'),
      ax(22, 'StaticText', 'West'),
      ax(23, 'StaticText', '$14,784'),
      ax(24, 'StaticText', 'East'),
      ax(25, 'link', 'Details'),
    ];
    expect(renderTree(nodes, new RefTable(), { all: false })).toEqual([
      'e1 table "Sales"',
      '  "Region | Revenue"',
      '  "West | $14,784"',
      '  "East"',
      '  e2 link "Details"',
    ]);
  });

  it('runs the text of a block together across inline wrappers, but keeps blocks and long text apart', () => {
    const long = 'word '.repeat(250);
    const nodes = [
      ax(1, 'RootWebArea', '', [2, 6, 9, 13]),
      ax(2, 'paragraph', '', [3, 4]),
      ax(3, 'StaticText', 'Account balance: '),
      ax(4, 'strong', '', [5]),
      ax(5, 'StaticText', '$1,284.50'),
      ax(6, 'generic', '', [7, 8]),
      ax(7, 'paragraph', '', [17]),
      ax(8, 'paragraph', '', [18]),
      ax(9, 'paragraph', '', [10, 11]),
      ax(10, 'StaticText', long),
      ax(11, 'emphasis', '', [12]),
      ax(12, 'StaticText', 'end'),
      ax(13, 'list', '', [14, 15]),
      ax(14, 'listitem', '', [19]),
      ax(15, 'listitem', '', [16]),
      ax(16, 'StaticText', '#2 · User invited'),
      ax(17, 'StaticText', 'First'),
      ax(18, 'StaticText', 'Second'),
      ax(19, 'StaticText', '#1 · Deploy finished'),
    ];
    const lines = renderTree(nodes, new RefTable(), { all: false });
    expect(lines[0]).toBe('"Account balance: $1,284.50"');
    expect(lines.slice(1, 3)).toEqual(['"First"', '"Second"']);
    expect(lines[3]).toMatch(/^"word word .*…"$/);
    expect(lines[4]).toBe('"end"');
    expect(lines.slice(5)).toEqual(['"#1 · Deploy finished"', '"#2 · User invited"']);
  });

  it('leaves out separators between links and icon-font glyphs', () => {
    const nodes = [
      ax(1, 'RootWebArea', '', [2, 3, 4, 5]),
      ax(2, 'link', 'new'),
      ax(3, 'StaticText', ' | '),
      ax(4, 'link', 'past'),
      ax(5, 'StaticText', '\ue00c In stock'),
    ];
    expect(renderTree(nodes, new RefTable(), { all: false })).toEqual(['e1 link "new"', 'e2 link "past"', '"In stock"']);
  });

  it('survives a node that lists itself as a child', () => {
    const nodes = [ax(1, 'RootWebArea', '', [2]), ax(2, 'group', 'Loop', [2, 1])];
    expect(renderTree(nodes, new RefTable(), { all: false })).toEqual(['e1 group "Loop"']);
  });
});

describe('refs', () => {
  it('keep their number for an element across reads, and give new elements the next one', () => {
    const refs = new RefTable();
    const first = renderTree(signInPage(), refs, { all: false });
    const withExtra = [
      ...signInPage().map((node) => (node.id === '1' ? { ...node, children: ['11', ...node.children] } : node)),
      ax(11, 'button', 'Banner'),
    ];
    const second = renderTree(withExtra, refs, { all: false });
    expect(first).toContain('  e3 button "Submit"');
    expect(second).toContain('  e3 button "Submit"');
    expect(second[0]).toBe('e4 button "Banner"');
  });

  it('map back to the element they stand for', () => {
    const refs = new RefTable();
    renderTree(signInPage(), refs, { all: false });
    expect(refs.backendIdOf('e3')).toBe(6);
    expect(refs.backendIdOf('e99')).toBeUndefined();
  });
});
