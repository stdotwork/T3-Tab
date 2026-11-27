import { describe, expect, it, vi } from 'vitest';

import { OUTLINE_AT } from '../src/reader/outline.js';
import { formatRead, LOAD_REPEAT_MS, MAX_OUTPUT_CHARS, TabState, TEXT_BUDGET } from '../src/reader/page.js';
import { ax, buttonPage, docsPage, feed, fieldPage, longArticle, longPage, page, signInPage } from './ax-fixtures.js';

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
    expect(await formatRead(new TabState(), 's1', empty, {})).toContain('(empty page; all also lists images)');
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

  it('masks a redacted field whatever its role, in a read, a find and a diff', async () => {
    const field = (id: number, role: string, name: string): ReturnType<typeof ax> =>
      ax(id, role, name, [], { value: 'hunter2-secret', props: { password: true } });
    const build = (): ReturnType<typeof ax>[] => [
      ax(1, 'RootWebArea', '', [2, 3, 4, 5]),
      field(2, 'combobox', 'PW combo'),
      field(3, 'searchbox', 'PW search'),
      field(4, 'spinbutton', 'PW spin'),
      field(5, 'slider', 'PW slider'),
    ];
    const state = new TabState();
    const reply = await formatRead(state, 's1', page(build()), { all: true });
    for (const name of ['combobox "PW combo"', 'searchbox "PW search"', 'spinbutton "PW spin"', 'slider "PW slider"']) {
      expect(reply).toContain(`${name} value=<redacted>`);
    }
    expect(reply).not.toContain('hunter2');
    expect(reply).not.toContain('value="');
    const found = await formatRead(state, 's1', page(build()), { find: 'PW combo' });
    expect(found).toContain('combobox "PW combo" value=<redacted>');
    expect(found).not.toContain('hunter2');
    const changed = build();
    changed[1] = ax(2, 'combobox', 'PW combo', [], { value: 'another-secret', props: { password: true, invalid: true } });
    const diff = await formatRead(state, 's1', page(changed), {});
    expect(diff).toContain('value=<redacted>');
    expect(diff).not.toContain('another-secret');
  });

  it('cuts a long reply at a line and says how to read the rest', async () => {
    const reply = await formatRead(new TabState(), 's1', page(buttonPage(2_000)), { all: true });
    expect(reply.length).toBeLessThanOrEqual(MAX_OUTPUT_CHARS);
    expect(reply).toMatch(/… truncated at 12000 characters\. Use find, a ref subtree or depth to read the rest\.$/);
    expect(reply).not.toContain('"Button 2000"');
  });
});

describe('a load reply', () => {
  it('carries a short page and is the baseline: a full read right after it, unchanged, is not sent again', async () => {
    const state = new TabState();
    const loaded = await formatRead(state, 's', page(signInPage()), { load: true });
    expect(loaded).toContain('# Sign in');
    expect(await formatRead(state, 's', page(signInPage()), { full: true })).toBe(
      'tab 7\nNo changes since the load\'s reply, which showed the whole page.',
    );
    // Only right after the load: a second full read is the whole page again.
    expect(await formatRead(state, 's', page(signInPage()), { full: true })).toContain('# Sign in');
  });

  it('sends a full read whole when it comes later than a read sent with the load would', async () => {
    const state = new TabState();
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    try {
      await formatRead(state, 's', page(signInPage()), { load: true });
      now.mockReturnValue(1_000_000 + LOAD_REPEAT_MS);
      expect(await formatRead(state, 's', page(signInPage()), { full: true })).toContain('# Sign in');
    } finally {
      now.mockRestore();
    }
  });

  it('sends a full read whole when the page changed since the load', async () => {
    const state = new TabState();
    await formatRead(state, 's', page(signInPage()), { load: true });
    const changed = await formatRead(state, 's', page(buttonPage(3)), { full: true });
    expect(changed).toContain('# Buttons');
  });

  it('leaves a long page to the read sent with it, and sets no baseline', async () => {
    const state = new TabState();
    const long = page(buttonPage(400));
    const loaded = await formatRead(state, 's', long, { load: true });
    expect(loaded).toMatch(/^tab 7: Test page — http:\/\/localhost\/test\n\(The page is [\d,]+ characters, too long for this reply: read shows it, find searches it\.\)$/);
    // The read gets the page, outlined because it is long.
    const read = await formatRead(state, 's', long, {});
    expect(read).toContain('"Button 40"');
    expect(read).toMatch(/\(Outline of a long page: 360 links and buttons left out\. .*\)$/);
    // A find on a long page is still answered.
    expect(await formatRead(new TabState(), 's', long, { load: true, find: 'Button 399' })).toContain('Button 399');
  });

  it('keeps the earlier baseline when a long page is left out', async () => {
    const state = new TabState();
    await formatRead(state, 's', page(buttonPage(400)), {});
    await formatRead(state, 's', page(buttonPage(400)), { load: true });
    expect(await formatRead(state, 's', page(buttonPage(400)), {})).toBe('tab 7\nNo changes since the last read.');
  });
});

describe('find', () => {
  it('returns only the matching lines, searching every node unless told otherwise', async () => {
    const reply = await formatRead(new TabState(), 's1', page(signInPage()), { find: 'hello' });
    expect(reply).toBe('tab 7: Test page — http://localhost/test\n  e3 button "Submit"\n"Hello there"');
    const pictured = [ax(1, 'RootWebArea', '', [2]), ax(2, 'image', 'A hello sign')];
    expect(await formatRead(new TabState(), 's1', page(pictured), { find: 'hello' })).toContain('img "A hello sign"');
    expect(await formatRead(new TabState(), 's1', page(pictured), { find: 'hello', all: false })).toContain('No matches for "hello"');
  });

  it('searches text the default view left out', async () => {
    const reply = await formatRead(new TabState(), 's1', page(longArticle(400)), { find: 'Sentence 399 ' });
    expect(reply).toContain('"Sentence 399 of the article');
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

  it('keeps a price with its book, and a link found by name says where it goes', async () => {
    const book = (id: number, title: string, price: string): ReturnType<typeof ax>[] => [
      ax(id, 'listitem', '', [id + 1, id + 2, id + 3]),
      ax(id + 1, 'link', title, [], { props: { url: `http://localhost/catalogue/${id}/index.html` } }),
      ax(id + 2, 'paragraph', '', [id + 4]),
      ax(id + 3, 'paragraph', '', [id + 5]),
      ax(id + 4, 'StaticText', price),
      ax(id + 5, 'StaticText', 'In stock'),
    ];
    const nodes = [ax(1, 'RootWebArea', '', [2]), ax(2, 'list', '', [10, 20]), ...book(10, 'Sharp Objects', '£47.82'), ...book(20, 'The Exiled', '£43.45')];
    const prices = await formatRead(new TabState(), 's1', page(nodes), { find: '£' });
    // Only the matches and the line before each, with its address (a cut title is whole there): no stock lines, no separators.
    expect(prices.split('\n').slice(1)).toEqual([
      'e1 link "Sharp Objects" → /catalogue/10/index.html',
      '"£47.82"',
      'e2 link "The Exiled" → /catalogue/20/index.html',
      '"£43.45"',
    ]);
    const title = await formatRead(new TabState(), 's1', page(nodes), { find: 'exiled' });
    expect(title.split('\n').slice(1)).toEqual(['"In stock"', 'e2 link "The Exiled" → /catalogue/20/index.html']);
  });

  it('is much shorter than the page it searches', async () => {
    const full = await formatRead(new TabState(), 's1', page(buttonPage(200)), {});
    const found = await formatRead(new TabState(), 's1', page(buttonPage(200)), { find: 'Button 77"' });
    expect(found.split('\n')).toHaveLength(1 + 2);
    expect(found.length).toBeLessThan(full.length / 20);
  });
});

describe('text in the default view', () => {
  it('shows a short page whole: its text, lists and live regions', async () => {
    const nodes = [
      ax(1, 'RootWebArea', '', [2, 3, 5, 7]),
      ax(2, 'heading', 'Activity log', [], { props: { level: 1 } }),
      ax(3, 'alert', '', [4]),
      ax(4, 'StaticText', 'Incorrect username or password.'),
      ax(5, 'list', 'Entries', [6]),
      ax(6, 'listitem', '', [8]),
      ax(7, 'button', 'Load more'),
      ax(8, 'StaticText', '#1 · Deploy finished · ref XD-8919'),
    ];
    expect(await formatRead(new TabState(), 's1', page(nodes), {})).toBe(
      [
        'tab 7: Test page — http://localhost/test',
        '# Activity log',
        'alert "Incorrect username or password."',
        'e1 list "Entries"',
        '  "#1 · Deploy finished · ref XD-8919"',
        'e2 button "Load more"',
      ].join('\n'),
    );
  });

  it('keeps every element and as much text as the budget allows, the main content first, and says what it left out', async () => {
    const reply = await formatRead(new TabState(), 's1', page(longArticle(400)), {});
    const lines = reply.split('\n');
    expect(reply).toContain('e1 link "Home"');
    expect(reply).toContain('e2 button "Subscribe"');
    expect(reply).toContain('"Sentence 1 of the article');
    expect(reply).not.toContain('Sentence 399 ');
    // The footer's text comes after the article's, so it is the part left out.
    expect(reply).not.toContain('Footer text');
    expect(reply).toContain('alert "Saved."');
    const text = lines.filter((line) => line.trimStart().startsWith('"')).join('\n');
    expect(text.length).toBeLessThanOrEqual(TEXT_BUDGET);
    expect(text.length).toBeGreaterThan(TEXT_BUDGET - 200);
    expect(lines.at(-1)).toMatch(/^\(\d+ text lines left out, \d+ characters: find searches them, read a ref for one part, all for the whole page\)$/);
  });

  it('folds a long sidebar to one line so the main text has room, and keeps every link in reach', async () => {
    const state = new TabState();
    const reply = await formatRead(state, 's1', page(docsPage(500, 60)), {});
    const lines = reply.split('\n');
    expect(lines[1]).toBe('e1 navigation "Sidebar" (500 links; read e1): "Guide to topic 0", "Guide to topic 1", "Guide to topic 2", "Guide to topic 3", …');
    expect(reply).not.toContain('e2 link "Guide to topic 0"');
    expect(lines[2]).toBe('# Getting started');
    // The text, with its links written in.
    expect(lines[3]).toBe('"Paragraph 0 explains one part of the subject, in words, and then points to [related page 0](e502) for the details that this page leaves out."');
    expect(reply).toContain('e562 button "Edit this page"');
    expect(lines.at(-1)).toMatch(/^\(\d+ text lines left out, \d+ characters, \d+ links in them: find searches them/);
    // The sidebar's ref lists its links with the refs they had all along; find reaches one in the folded list and one in
    // text the budget left out.
    const sidebar = await formatRead(state, 's1', page(docsPage(500, 60)), { ref: 'e1' });
    expect(sidebar).toContain('  e2 link "Guide to topic 0"');
    expect(await formatRead(state, 's1', page(docsPage(500, 60)), { find: 'topic 499' })).toContain('e501 link "Guide to topic 499"');
    expect(await formatRead(state, 's1', page(docsPage(500, 60)), { find: 'related page 59' })).toContain('[related page 59](e561)');
    // A later read shows only what changed, as before.
    expect(await formatRead(state, 's1', page(docsPage(500, 60)), {})).toBe('tab 7\nNo changes since the last read.');
  });

  it('counts the text of a folded list as left out', async () => {
    const nodes = docsPage(500, 60);
    const sidebar = nodes.find((node) => node.id === '2')!;
    sidebar.children.push('9000');
    nodes.push(ax(9000, 'StaticText', 'Version 4.2 of the guides'));
    const reply = await formatRead(new TabState(), 's1', page(nodes), {});
    expect(reply).not.toContain('Version 4.2');
    const [, lines] = /\((\d+) text lines left out/.exec(reply.split('\n').at(-1)!)!;
    const withoutIt = await formatRead(new TabState(), 's1', page(docsPage(500, 60)), {});
    const [, before] = /\((\d+) text lines left out/.exec(withoutIt.split('\n').at(-1)!)!;
    expect(Number(lines)).toBe(Number(before) + 1);
  });

  it('finds a link written into text by its address, and prints the address on the matching line only', async () => {
    const nodes = [
      ax(1, 'RootWebArea', '', [2, 6]),
      ax(2, 'paragraph', '', [3, 4, 5]),
      ax(3, 'StaticText', 'The first browser was written in 1990 by '),
      ax(4, 'link', 'Tim Berners-Lee', [], { props: { url: 'http://localhost/wiki/Tim_Berners-Lee' } }),
      ax(5, 'StaticText', ' at CERN, as a tool for sharing papers.'),
      ax(6, 'paragraph', '', [7]),
      ax(7, 'StaticText', 'It ran on NeXT computers.'),
    ];
    const state = new TabState();
    expect(await formatRead(state, 's1', page(nodes), {})).toContain('[Tim Berners-Lee](e1) at CERN');
    const found = await formatRead(state, 's1', page(nodes), { find: '/wiki/Tim_Berners' });
    expect(found).toContain('[Tim Berners-Lee](e1 → /wiki/Tim_Berners-Lee) at CERN');
    // A search for the text prints the line as a read does, around its match.
    expect(await formatRead(state, 's1', page(nodes), { find: 'NeXT' })).toContain('"The first browser was written in 1990 by [Tim Berners-Lee](e1) at CERN');
  });

  it('leaves a page that fits as it is', async () => {
    const reply = await formatRead(new TabState(), 's1', page(docsPage(20, 3)), {});
    expect(reply).toContain('  e2 link "Guide to topic 0"');
    expect(reply).toContain('  e21 link "Guide to topic 19"');
  });

  it('gives text no more room than the cap leaves after the elements', async () => {
    const nodes = buttonPage(450);
    nodes[0] = { ...nodes[0]!, children: [...nodes[0]!.children, '9000'] };
    nodes.push(ax(9000, 'paragraph', '', [9001]), ax(9001, 'StaticText', 'A closing remark that does not fit.'));
    // A depth that hides nothing shows the default view whole: a long page's outline would leave the buttons out.
    const reply = await formatRead(new TabState(), 's1', page(nodes), { depth: 5 });
    expect(reply).toContain('"Button 450"');
    expect(reply).not.toContain('closing remark');
    expect(reply).toMatch(/\(1 text lines left out, 35 characters/);
    expect(reply.length).toBeLessThanOrEqual(MAX_OUTPUT_CHARS);
  });

  it('keeps the note when the elements alone pass the cap', async () => {
    const nodes = buttonPage(2_000);
    nodes[0] = { ...nodes[0]!, children: ['9000', ...nodes[0]!.children] };
    nodes.push(ax(9000, 'paragraph', '', [9001]), ax(9001, 'StaticText', 'An intro.'));
    const reply = await formatRead(new TabState(), 's1', page(nodes), { depth: 5 });
    expect(reply).toContain('… truncated at 12000 characters.');
    expect(reply).toMatch(/\(1 text lines left out, 9 characters: .*\)$/);
  });

  it('holds a long log to the budget, newest entries first, and keeps the controls after it', async () => {
    const ids = Array.from({ length: 400 }, (_, index) => 1_000 + index * 2);
    const nodes = [
      ax(1, 'RootWebArea', '', [2, 3, 4]),
      ax(2, 'log', 'Chat', ids),
      ax(3, 'textbox', 'Message'),
      ax(4, 'button', 'Send'),
      ...ids.flatMap((id, index) => [ax(id, 'paragraph', '', [id + 1]), ax(id + 1, 'StaticText', `Message ${index + 1}: hello there, this is a chat line.`)]),
    ];
    const reply = await formatRead(new TabState(), 's1', page(nodes), {});
    expect(reply).toContain('e1 log "Chat"');
    expect(reply).toContain('Message 400: hello');
    expect(reply).not.toContain('"Message 1: hello');
    expect(reply).toContain('e3 button "Send"');
    expect(reply).toMatch(/\(\d+ text lines left out, \d+ characters: .*\)$/);
    expect(reply.length).toBeLessThanOrEqual(MAX_OUTPUT_CHARS);
    const text = reply.split('\n').filter((line) => line.trimStart().startsWith('"')).join('\n');
    expect(text.length).toBeLessThanOrEqual(TEXT_BUDGET);
  });

  it('keeps a dialog\'s buttons and the start of its text when the text is long', async () => {
    const ids = Array.from({ length: 300 }, (_, index) => 1_000 + index * 2);
    const nodes = [
      ax(1, 'RootWebArea', '', [2]),
      ax(2, 'dialog', 'Terms', [...ids, 3]),
      ax(3, 'button', 'Accept'),
      ...ids.flatMap((id, index) => [ax(id, 'paragraph', '', [id + 1]), ax(id + 1, 'StaticText', `Clause ${index + 1}. The service is provided as is, without warranty of any kind.`)]),
    ];
    const reply = await formatRead(new TabState(), 's1', page(nodes), {});
    expect(reply).toContain('"Clause 1. The service');
    expect(reply).not.toContain('Clause 300.');
    expect(reply).toContain('e2 button "Accept"');
    expect(reply).toMatch(/text lines left out/);
  });

  it('keeps a change within the cap, its changed elements before its text', async () => {
    const state = new TabState();
    await formatRead(state, 's1', page(buttonPage(450)), {});
    // One button in five renamed (about 10,000 characters of diff), and 80 paragraphs of new text.
    const nodes = buttonPage(450).map((node) => (node.role === 'button' && Number(node.id) % 5 === 0 ? { ...node, name: `${node.name} renamed` } : node));
    const ids = Array.from({ length: 80 }, (_, index) => 9_000 + index * 2);
    nodes[0] = { ...nodes[0]!, children: [...nodes[0]!.children, ...ids.map(String)] };
    nodes.push(...ids.flatMap((id, index) => [ax(id, 'paragraph', '', [id + 1]), ax(id + 1, 'StaticText', `New paragraph ${index + 1}, which says something long enough to count.`)]));
    const reply = await formatRead(state, 's1', page(nodes), {});
    expect(reply).toContain('Changed since the last read:');
    expect(reply).toContain('+e446 button "Button 446 renamed"');
    expect(reply).not.toContain('truncated at');
    expect(reply).toMatch(/\(\d+ changed text lines left out, \d+ characters: .*\)$/);
    expect(reply.length).toBeLessThanOrEqual(MAX_OUTPUT_CHARS);
  });

  it('gives a ref read all the text that fits under the cap', async () => {
    const state = new TabState();
    await formatRead(state, 's1', page(longArticle(400)), {});
    const reply = await formatRead(state, 's1', page(longArticle(400)), { ref: 'e3' });
    expect(reply).toContain('Sentence 150 ');
    expect(reply.length).toBeGreaterThan(TEXT_BUDGET * 2);
  });

  it('shows new text in a change, within the budget', async () => {
    const state = new TabState();
    await formatRead(state, 's1', page(feed(10)), {});
    const grown = await formatRead(state, 's1', page(feed(14)), {});
    expect(grown).toContain('Changed since the last read:');
    expect(grown).toContain('+  "#14 · Entry"');
    const flooded = await formatRead(state, 's1', page(feed(600)), {});
    expect(flooded).toContain('"#15 · Entry"');
    expect(flooded).not.toContain('"#600 · Entry"');
    expect(flooded).toMatch(/text lines left out/);
  });

  it('shows a live region\'s message on the page a form posts back to', async () => {
    const state = new TabState();
    const form = (message: string | undefined, epoch: number) =>
      page(
        [
          ax(1, 'RootWebArea', '', message === undefined ? [2, 3] : [4, 2, 3]),
          ax(2, 'textbox', 'Password', [], { props: { password: true }, value: 'hunter2' }),
          ax(3, 'button', 'Sign in'),
          ax(4, 'paragraph', '', [5], { props: { live: 'assertive' } }),
          ax(5, 'StaticText', message ?? ''),
        ],
        { epoch },
      );
    await formatRead(state, 's1', form(undefined, 1), {});
    const reloaded = await formatRead(state, 's1', form('Incorrect username or password.', 2), {});
    expect(reloaded).toContain('"Incorrect username or password."');
    expect(reloaded).toContain('textbox "Password" value=<redacted>');
    expect(reloaded).not.toContain('hunter2');
  });
});

describe('an outline of a long page', () => {
  const note = /\n\(Outline of a long page: 91 links and buttons, 8 text lines \(2400 characters\) left out\. find searches them, read a ref for one part, all for the whole page\)$/;

  it('keeps the shape and the first of the rest, and says how to get at what it left out', async () => {
    const whole = await formatRead(new TabState(), 's1', page(longPage()), { depth: 9 });
    expect(whole.length).toBeGreaterThan(OUTLINE_AT);
    const reply = await formatRead(new TabState(), 's1', page(longPage()), {});
    expect(reply).toMatch(note);
    expect(reply.length).toBeLessThan(whole.length / 2);
    // Headings, landmarks, the form with its field and button, the live region and the dialog.
    for (const line of ['# Report', 'e22 form "Search"', '  e23 textbox "Query"', '  e24 button "Go"', 'e25 list "Items"', 'alert "Report saved."', 'e138 dialog "Cookies"', '  "We use cookies."', '  e139 button "Accept"']) {
      expect(reply.split('\n')).toContain(line);
    }
    // The first links, and the first text of the main content.
    expect(reply).toContain('e65 link "Item 40"');
    expect(reply).not.toContain('"Item 41"');
    expect(reply).toContain('"Paragraph 4 of the report');
    expect(reply).not.toContain('"Paragraph 5 of the report');
    // Long lists around the content fold to one line each; a left-out link takes what it holds with it.
    expect(reply).toContain('e1 navigation "Site" (20 links; read e1): "Nav 1"');
    expect(reply).toContain('e127 contentinfo "Footer" (10 links; read e127)');
    expect(reply).not.toContain('Story');
  });

  it('outlines a full read and the whole page an act replies with, not a load, a ref, depth, all, find or a diff', async () => {
    expect(await formatRead(new TabState(), 's1', page(longPage()), { full: true })).toMatch(note);
    expect(await formatRead(new TabState(), 's1', page(longPage()), { echoed: [] })).toMatch(note);
    expect(await formatRead(new TabState(), 's1', page(longPage()), { load: true })).toContain('too long for this reply');
    for (const options of [{ ref: 'e25' }, { depth: 9 }, { all: true }, { find: 'Item' }]) {
      const state = new TabState();
      // A ref read needs the ref handed out first.
      await formatRead(state, 's0', page(longPage()), {});
      expect(await formatRead(state, 's1', page(longPage()), options)).not.toContain('Outline of a long page');
    }
    const state = new TabState();
    await formatRead(state, 's1', page(longPage()), {});
    const changed = longPage().map((node) => (node.id === '590' ? { ...node, name: 'Item ninety-one' } : node));
    expect(await formatRead(state, 's1', page(changed), {})).toBe(
      'tab 7\nChanged since the last read:\n@@\n   e115 link "Item 90"\n-  e116 link "Item 91"\n+  e116 link "Item ninety-one"\n   e117 link "Item 92"',
    );
  });

  it('keeps every line in the baseline, so a later read sees a change to what it left out', async () => {
    const state = new TabState();
    await formatRead(state, 's1', page(longPage()), {});
    expect(await formatRead(state, 's1', page(longPage()), {})).toBe('tab 7\nNo changes since the last read.');
    const changed = longPage().map((node) => (node.id === '323' ? { ...node, name: 'Paragraph 12 was rewritten.' } : node));
    const reply = await formatRead(state, 's1', page(changed), {});
    expect(reply).toContain('+"Paragraph 12 was rewritten."');
  });

  it('leaves a long page whole when its outline would not be shorter', async () => {
    const reply = await formatRead(new TabState(), 's1', page(fieldPage(300)), {});
    expect(reply.length).toBeGreaterThan(OUTLINE_AT);
    expect(reply).toContain('e300 textbox "Field 300"');
    expect(reply).not.toContain('Outline');
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
