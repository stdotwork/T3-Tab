import { describe, expect, it } from 'vitest';

import { type FindLine, findLines, MAX_QUERY_LENGTH } from '../src/reader/find.js';

const lines = Array.from({ length: 30 }, (_, index) => `row ${index}`);
/** The longest matching line printed whole. */
const MAX_PRINTED = 200;

describe('find', () => {
  it('returns only the matching line, and the line before a short one, which says whose it is', async () => {
    expect((await findLines(lines, 'row 10')).text).toBe('row 9\nrow 10');
    // A price keeps its book's line; nothing after it.
    const books = ['  e5 link "Sharp Objects"', '"£47.82"', '"In stock"', '  e6 button "Add to basket"'];
    expect((await findLines(books, '£')).text).toBe('  e5 link "Sharp Objects"\n"£47.82"');
  });

  it('prints a long matching line alone', async () => {
    const prose = `"${'A rate limit of sixty requests per minute applies to each token, '.repeat(2)}and a limited call returns 429."`;
    expect(prose.length).toBeGreaterThan(100);
    expect((await findLines(['## Limits', prose], 'rate limit')).text).toBe(prose);
    // One past the longest printed whole is cut around its match.
    const longer = `"${'x'.repeat(MAX_PRINTED)} rate limit"`;
    expect((await findLines(['## Limits', longer], 'rate limit')).text).toBe(`…${longer.slice(longer.indexOf('rate limit') - 80)}`);
  });

  it('prints a long line around its match and marks both cuts', async () => {
    const long = `  "${'a'.repeat(900)} needle ${'b'.repeat(900)}"`;
    for (const options of [{}, { regex: true }]) {
      const { text } = await findLines([long], 'needle', options);
      expect(text).toContain(' needle ');
      expect(text.startsWith('  …')).toBe(true);
      expect(text.endsWith('…')).toBe(true);
      expect(text.length).toBeLessThan(180);
    }
  });

  it('keeps the start of a long context line, marked', async () => {
    const { text } = await findLines([`e1 link "${'c'.repeat(900)}"`, 'needle'], 'needle');
    const [context] = text.split('\n');
    expect(context?.startsWith('e1 link "ccc')).toBe(true);
    expect(context?.endsWith('…')).toBe(true);
    // A paragraph beside the match keeps less than a matching line would.
    expect(context?.length).toBeLessThanOrEqual(121);
  });

  it('matches literal text by default, including regex punctuation', async () => {
    expect((await findLines(lines, 'row (3|5)$')).text).toBe('No matches for "row (3|5)$".');
    expect((await findLines(['link "About"', 'link "Contact"'], 'link "(about|home)"')).matches).toBe(0);
  });

  it('matches case-insensitively as a regular expression only when asked', async () => {
    expect((await findLines(lines, 'ROW (3|5)$', { regex: true })).text).toBe('row 2\nrow 3\nrow 4\nrow 5');
  });

  it('prints a line once, and no separators', async () => {
    expect((await findLines(lines, 'row (3|4)$', { regex: true })).text).toBe('row 2\nrow 3\nrow 4');
    expect((await findLines(lines, 'row (3|9)$', { regex: true })).text).toBe('row 2\nrow 3\nrow 8\nrow 9');
  });

  it('prints a text line as a read does, unless the query matched only in an address', async () => {
    const page: FindLine[] = [
      { line: '## History' },
      { line: '"Written by [Tim](e1) at CERN."', search: '"Written by [Tim](e1) → /wiki/Tim at CERN."' },
      { line: '  e2 link "CERN" → /wiki/CERN' },
      { line: '"£4"' },
    ];
    for (const options of [{}, { regex: true }]) {
      expect((await findLines(page, 'at CERN', options)).text).toBe('## History\n"Written by [Tim](e1) at CERN."');
      expect((await findLines(page, '/wiki/Tim', options)).text).toBe('## History\n"Written by [Tim](e1) → /wiki/Tim at CERN."');
      // The line kept before a short match is printed whole, a link with its address.
      expect((await findLines(page, '£', options)).text).toBe('  e2 link "CERN" → /wiki/CERN\n"£4"');
    }
  });

  it('reports no match', async () => {
    expect(await findLines(lines, 'absent')).toEqual({ text: 'No matches for "absent".', matches: 0 });
  });

  it('treats regex punctuation literally when the flag is absent', async () => {
    const result = await findLines(['a (b', 'c'], '(b');
    expect(result.matches).toBe(1);
    expect(result.text).toBe('a (b');
  });

  it('reports an invalid regular expression clearly', async () => {
    await expect(findLines(lines, '(unclosed', { regex: true })).rejects.toThrow(/Invalid find regex/);
  });

  it('caps the query length', async () => {
    await expect(findLines(lines, 'x'.repeat(MAX_QUERY_LENGTH + 1), { regex: true })).rejects.toThrow(/maximum 200/);
  });

  it('stops a catastrophic regular expression at the timeout', async () => {
    const started = Date.now();
    await expect(findLines([`${'a'.repeat(400)}!`], '(a+)+$', { regex: true, timeoutMs: 100 })).rejects.toThrow(
      /timed out/,
    );
    expect(Date.now() - started).toBeLessThan(1_500);
  });

  it('caps the matches it shows and says how many it left out', async () => {
    const many = Array.from({ length: 100 }, (_, index) => `item ${index}`);
    const result = await findLines(many, 'item');
    expect(result.matches).toBe(100);
    expect(result.text).toContain('(80 more matches; narrow the query)');
  });
});
