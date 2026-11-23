import { describe, expect, it } from 'vitest';

import { RefGoneError, renderTree } from '../src/reader/format.js';
import { RefTable } from '../src/reader/refs.js';
import { ax, signInPage } from './ax-fixtures.js';

describe('tree to text', () => {
  it('lists interactive elements with refs, and headings and named containers as structure', () => {
    const lines = renderTree(signInPage(), new RefTable(), { all: false });
    expect(lines).toEqual([
      '# Sign in',
      'e1 form "Login"',
      '  e2 textbox "Email" value="a@b.c" [required]',
      '  e3 button "Submit"',
    ]);
  });

  it('adds the text of the page in all mode, without echoing labels or a control\'s own text', () => {
    const lines = renderTree(signInPage(), new RefTable(), { all: true });
    expect(lines).toEqual([
      '# Sign in',
      'e1 form "Login"',
      '  e2 textbox "Email" value="a@b.c" [required]',
      '  e3 button "Submit"',
      '"Hello there"',
    ]);
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
    expect(lines).toEqual(['# Sign in', 'e1 form "Login"']);
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
