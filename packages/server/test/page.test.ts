import { describe, expect, it } from 'vitest';

import { formatRead, MAX_OUTPUT_CHARS, TabState } from '../src/reader/page.js';
import { ax, buttonPage, page, signInPage } from './ax-fixtures.js';

describe('reading a page', () => {
  it('returns the full text on the first read, with a header line', async () => {
    const reply = await formatRead(new TabState(), 's1', page(buttonPage(30)), {});
    const lines = reply.split('\n');
    expect(lines[0]).toBe('tab 7: Test page — http://localhost/test');
    expect(lines[1]).toBe('# Buttons');
    expect(lines).toHaveLength(2 + 30);
    expect(lines[2]).toBe('e1 button "Button 1"');
  });

  it('says so when nothing changed', async () => {
    const state = new TabState();
    await formatRead(state, 's1', page(buttonPage(30)), {});
    expect(await formatRead(state, 's1', page(buttonPage(30)), {})).toBe('tab 7\nNo changes since the last read.');
  });

  it('prints the title and address once, then only the tab id until they change', async () => {
    const state = new TabState();
    const header = 'tab 7: Test page — http://localhost/test';
    expect((await formatRead(state, 's1', page(buttonPage(30)), {})).split('\n')[0]).toBe(header);
    expect((await formatRead(state, 's1', page(buttonPage(30)), {})).split('\n')[0]).toBe('tab 7');
    expect((await formatRead(state, 's1', page(buttonPage(30)), { find: 'Button 3' })).split('\n')[0]).toBe('tab 7');
    // Another session has not seen this tab yet.
    expect((await formatRead(state, 's2', page(buttonPage(30)), {})).split('\n')[0]).toBe(header);
    // A new title or address, on the same document or a new one, is printed again.
    const retitled = page(buttonPage(30), { title: 'Renamed' });
    expect((await formatRead(state, 's1', retitled, {})).split('\n')[0]).toBe('tab 7: Renamed — http://localhost/test');
    const moved = page(buttonPage(30), { url: 'http://localhost/next', epoch: 2 });
    expect((await formatRead(state, 's1', moved, {})).split('\n')[0]).toBe('tab 7: Test page — http://localhost/next');
    expect((await formatRead(state, 's1', moved, {})).split('\n')[0]).toBe('tab 7');
  });

  it('returns only the changed lines on a later read', async () => {
    const state = new TabState();
    await formatRead(state, 's1', page(buttonPage(30)), {});
    const changed = buttonPage(30).map((node) => (node.id === '110' ? { ...node, name: 'Renamed' } : node));
    const reply = await formatRead(state, 's1', page(changed), {});
    expect(reply).toBe(
      [
        'tab 7',
        'Changed since the last read:',
        '@@',
        ' e10 button "Button 10"',
        '-e11 button "Button 11"',
        '+e11 button "Renamed"',
        ' e12 button "Button 12"',
      ].join('\n'),
    );
  });

  it('shows new elements as added lines with refs after the last one', async () => {
    const state = new TabState();
    await formatRead(state, 's1', page(buttonPage(30)), {});
    const grown = buttonPage(30);
    grown[0] = { ...grown[0]!, children: [...grown[0]!.children, '500'] };
    grown.push(ax(500, 'link', 'Fresh'));
    const reply = await formatRead(state, 's1', page(grown), {});
    expect(reply).toContain('+e31 link "Fresh"');
    expect(reply.split('\n').length).toBeLessThan(10);
  });

  it('falls back to the full text when more than half of it changed', async () => {
    const state = new TabState();
    await formatRead(state, 's1', page(buttonPage(30)), {});
    const reply = await formatRead(state, 's1', page(buttonPage(30, 'Other')), {});
    expect(reply).not.toContain('Changed since');
    expect(reply.split('\n')).toHaveLength(2 + 30);
    expect(reply).toContain('"Other 30"');
  });

  it('returns everything when asked for the full page', async () => {
    const state = new TabState();
    await formatRead(state, 's1', page(buttonPage(30)), {});
    const reply = await formatRead(state, 's1', page(buttonPage(30)), { full: true });
    expect(reply.split('\n')).toHaveLength(2 + 30);
  });

  it('keeps each session\'s baseline apart, and each view of the page apart', async () => {
    const state = new TabState();
    await formatRead(state, 's1', page(buttonPage(30)), {});
    expect((await formatRead(state, 's2', page(buttonPage(30)), {})).split('\n')).toHaveLength(2 + 30);
    expect(await formatRead(state, 's1', page(buttonPage(30)), { all: true })).toContain('"Button 30"');
  });

  it('forgets refs and baselines when the document is replaced', async () => {
    const state = new TabState();
    await formatRead(state, 's1', page(buttonPage(30)), {});
    const reply = await formatRead(state, 's1', page(buttonPage(30), { epoch: 2 }), {});
    expect(reply).not.toContain('No changes');
    expect(reply).toContain('e1 button "Button 1"');
    await expect(formatRead(state, 's1', page(buttonPage(30), { epoch: 3 }), { ref: 'e5' })).rejects.toThrow(/Unknown ref e5/);
  });

  it('says there is nothing to show on an empty view', async () => {
    const empty = page([ax(1, 'RootWebArea')]);
    expect(await formatRead(new TabState(), 's1', empty, {})).toContain('(no interactive elements; use all to see the text)');
    expect(await formatRead(new TabState(), 's1', empty, { all: true })).toContain('(empty page)');
  });

  it('masks a password field without revealing its value or length', async () => {
    const nodes = [
      ax(1, 'RootWebArea', '', [2]),
      ax(2, 'textbox', 'Password', [], { value: 'hunter2-secret', props: { password: true } }),
    ];
    const reply = await formatRead(new TabState(), 's1', page(nodes), { all: true });
    expect(reply).toContain('textbox "Password" value=<redacted>');
    expect(reply).not.toContain('hunter2');
    expect(reply).not.toContain('value="');
  });

  it('cuts a long reply at a line and says how to read the rest', async () => {
    const reply = await formatRead(new TabState(), 's1', page(buttonPage(2_000)), {});
    expect(reply.length).toBeLessThan(MAX_OUTPUT_CHARS + 200);
    expect(reply).toMatch(/… truncated at 12000 characters\. Use find, a ref subtree or depth to read the rest\.$/);
    expect(reply).not.toContain('"Button 2000"');
  });
});

describe('find', () => {
  it('returns only the matching lines, searching all text unless told otherwise', async () => {
    const reply = await formatRead(new TabState(), 's1', page(signInPage()), { find: 'hello' });
    expect(reply).toBe('tab 7: Test page — http://localhost/test\n  e3 button "Submit"\n"Hello there"');
    expect(await formatRead(new TabState(), 's1', page(signInPage()), { find: 'hello', all: false })).toContain(
      'No matches for "hello"',
    );
  });

  it('treats an empty query as no query', async () => {
    const reply = await formatRead(new TabState(), 's1', page(buttonPage(30)), { find: '' });
    expect(reply.split('\n')).toHaveLength(2 + 30);
  });

  it('leaves the baseline of the plain read alone', async () => {
    const state = new TabState();
    await formatRead(state, 's1', page(buttonPage(30)), {});
    await formatRead(state, 's1', page(buttonPage(30)), { find: 'Button 5' });
    expect(await formatRead(state, 's1', page(buttonPage(30)), {})).toContain('No changes since the last read.');
  });

  it('is much shorter than the page it searches', async () => {
    const full = await formatRead(new TabState(), 's1', page(buttonPage(200)), {});
    const found = await formatRead(new TabState(), 's1', page(buttonPage(200)), { find: 'Button 77"' });
    expect(found.split('\n')).toHaveLength(1 + 3);
    expect(found.length).toBeLessThan(full.length / 20);
  });
});

describe('a subtree by ref', () => {
  it('reads only that element, and refuses a ref it never gave out', async () => {
    const state = new TabState();
    await formatRead(state, 's1', page(signInPage()), {});
    const reply = await formatRead(state, 's1', page(signInPage()), { ref: 'e1' });
    expect(reply.split('\n').slice(1)).toEqual([
      'e1 form "Login"',
      '  e2 textbox "Email" value="a@b.c" [required]',
      '  e3 button "Submit"',
    ]);
    await expect(formatRead(state, 's1', page(signInPage()), { ref: 'e40' })).rejects.toThrow(/Unknown ref e40/);
  });

  it('says when the element left the page', async () => {
    const state = new TabState();
    await formatRead(state, 's1', page(signInPage()), {});
    const withoutForm = signInPage().filter((node) => !['3', '4', '5', '6', '7', '9'].includes(node.id));
    await expect(formatRead(state, 's1', page(withoutForm), { ref: 'e1' })).rejects.toThrow(/e1 is no longer on the page/);
  });
});
