import { describe, expect, it } from 'vitest';

import { formatRead, MAX_OUTPUT_CHARS, TabState } from '../src/reader/page.js';
import { ax, buttonPage, page, signInPage } from './ax-fixtures.js';

describe('reading a page', () => {
  it('returns the full text on the first read, with a header line', () => {
    const reply = formatRead(new TabState(), 's1', page(buttonPage(30)), {});
    const lines = reply.split('\n');
    expect(lines[0]).toBe('tab 7: Test page — http://localhost/test');
    expect(lines[1]).toBe('# Buttons');
    expect(lines).toHaveLength(2 + 30);
    expect(lines[2]).toBe('e1 button "Button 1"');
  });

  it('says so when nothing changed', () => {
    const state = new TabState();
    formatRead(state, 's1', page(buttonPage(30)), {});
    expect(formatRead(state, 's1', page(buttonPage(30)), {})).toBe(
      'tab 7: Test page — http://localhost/test\nNo changes since the last read.',
    );
  });

  it('returns only the changed lines on a later read', () => {
    const state = new TabState();
    formatRead(state, 's1', page(buttonPage(30)), {});
    const changed = buttonPage(30).map((node) => (node.id === '110' ? { ...node, name: 'Renamed' } : node));
    const reply = formatRead(state, 's1', page(changed), {});
    expect(reply).toBe(
      [
        'tab 7: Test page — http://localhost/test',
        'Changed since the last read:',
        '@@',
        ' e10 button "Button 10"',
        '-e11 button "Button 11"',
        '+e11 button "Renamed"',
        ' e12 button "Button 12"',
      ].join('\n'),
    );
  });

  it('shows new elements as added lines with refs after the last one', () => {
    const state = new TabState();
    formatRead(state, 's1', page(buttonPage(30)), {});
    const grown = buttonPage(30);
    grown[0] = { ...grown[0]!, children: [...grown[0]!.children, '500'] };
    grown.push(ax(500, 'link', 'Fresh'));
    const reply = formatRead(state, 's1', page(grown), {});
    expect(reply).toContain('+e31 link "Fresh"');
    expect(reply.split('\n').length).toBeLessThan(10);
  });

  it('falls back to the full text when more than half of it changed', () => {
    const state = new TabState();
    formatRead(state, 's1', page(buttonPage(30)), {});
    const reply = formatRead(state, 's1', page(buttonPage(30, 'Other')), {});
    expect(reply).not.toContain('Changed since');
    expect(reply.split('\n')).toHaveLength(2 + 30);
    expect(reply).toContain('"Other 30"');
  });

  it('returns everything when asked for the full page', () => {
    const state = new TabState();
    formatRead(state, 's1', page(buttonPage(30)), {});
    const reply = formatRead(state, 's1', page(buttonPage(30)), { full: true });
    expect(reply.split('\n')).toHaveLength(2 + 30);
  });

  it('keeps each session\'s baseline apart, and each view of the page apart', () => {
    const state = new TabState();
    formatRead(state, 's1', page(buttonPage(30)), {});
    expect(formatRead(state, 's2', page(buttonPage(30)), {}).split('\n')).toHaveLength(2 + 30);
    expect(formatRead(state, 's1', page(buttonPage(30)), { all: true })).toContain('"Button 30"');
  });

  it('forgets refs and baselines when the document is replaced', () => {
    const state = new TabState();
    formatRead(state, 's1', page(buttonPage(30)), {});
    const reply = formatRead(state, 's1', page(buttonPage(30), { epoch: 2 }), {});
    expect(reply).not.toContain('No changes');
    expect(reply).toContain('e1 button "Button 1"');
    expect(() => formatRead(state, 's1', page(buttonPage(30), { epoch: 3 }), { ref: 'e5' })).toThrow(/Unknown ref e5/);
  });

  it('says there is nothing to show on an empty view', () => {
    const empty = page([ax(1, 'RootWebArea')]);
    expect(formatRead(new TabState(), 's1', empty, {})).toContain('(no interactive elements; use all to see the text)');
    expect(formatRead(new TabState(), 's1', empty, { all: true })).toContain('(empty page)');
  });

  it('cuts a long reply at a line and says how to read the rest', () => {
    const reply = formatRead(new TabState(), 's1', page(buttonPage(2_000)), {});
    expect(reply.length).toBeLessThan(MAX_OUTPUT_CHARS + 200);
    expect(reply).toMatch(/… truncated at 12000 characters\. Use find, a ref subtree or depth to read the rest\.$/);
    expect(reply).not.toContain('"Button 2000"');
  });
});

describe('find', () => {
  it('returns only the matching lines, searching all text unless told otherwise', () => {
    const reply = formatRead(new TabState(), 's1', page(signInPage()), { find: 'hello' });
    expect(reply).toBe('tab 7: Test page — http://localhost/test\n  e3 button "Submit"\n"Hello there"');
    expect(formatRead(new TabState(), 's1', page(signInPage()), { find: 'hello', all: false })).toContain(
      'No matches for "hello"',
    );
  });

  it('treats an empty query as no query', () => {
    const reply = formatRead(new TabState(), 's1', page(buttonPage(30)), { find: '' });
    expect(reply.split('\n')).toHaveLength(2 + 30);
  });

  it('leaves the baseline of the plain read alone', () => {
    const state = new TabState();
    formatRead(state, 's1', page(buttonPage(30)), {});
    formatRead(state, 's1', page(buttonPage(30)), { find: 'Button 5' });
    expect(formatRead(state, 's1', page(buttonPage(30)), {})).toContain('No changes since the last read.');
  });

  it('is much shorter than the page it searches', () => {
    const full = formatRead(new TabState(), 's1', page(buttonPage(200)), {});
    const found = formatRead(new TabState(), 's1', page(buttonPage(200)), { find: 'Button 77"$' });
    expect(found.split('\n')).toHaveLength(1 + 3);
    expect(found.length).toBeLessThan(full.length / 20);
  });
});

describe('a subtree by ref', () => {
  it('reads only that element, and refuses a ref it never gave out', () => {
    const state = new TabState();
    formatRead(state, 's1', page(signInPage()), {});
    const reply = formatRead(state, 's1', page(signInPage()), { ref: 'e1' });
    expect(reply.split('\n').slice(1)).toEqual([
      'e1 form "Login"',
      '  e2 textbox "Email" value="a@b.c" [required]',
      '  e3 button "Submit"',
    ]);
    expect(() => formatRead(state, 's1', page(signInPage()), { ref: 'e40' })).toThrow(/Unknown ref e40/);
  });

  it('says when the element left the page', () => {
    const state = new TabState();
    formatRead(state, 's1', page(signInPage()), {});
    const withoutForm = signInPage().filter((node) => !['3', '4', '5', '6', '7', '9'].includes(node.id));
    expect(() => formatRead(state, 's1', page(withoutForm), { ref: 'e1' })).toThrow(/e1 is no longer on the page/);
  });
});
