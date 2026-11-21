import { describe, expect, it } from 'vitest';

import { findLines, MAX_QUERY_LENGTH } from '../src/reader/find.js';

const lines = Array.from({ length: 30 }, (_, index) => `row ${index}`);

describe('find', () => {
  it('returns matching lines with one line of context either side', async () => {
    expect((await findLines(lines, 'row 10')).text).toBe('row 9\nrow 10\nrow 11');
  });

  it('matches literal text by default, including regex punctuation', async () => {
    expect((await findLines(lines, 'row (3|5)$')).text).toBe('No matches for "row (3|5)$".');
    expect((await findLines(['link "About"', 'link "Contact"'], 'link "(about|home)"')).matches).toBe(0);
  });

  it('matches case-insensitively as a regular expression only when asked', async () => {
    expect((await findLines(lines, 'ROW (3|5)$', { regex: true })).text).toBe('row 2\nrow 3\nrow 4\nrow 5\nrow 6');
  });

  it('merges neighbouring matches into one block', async () => {
    expect((await findLines(lines, 'row (3|4)$', { regex: true })).text).toBe('row 2\nrow 3\nrow 4\nrow 5');
  });

  it('separates distant matches', async () => {
    expect((await findLines(lines, 'row (3|9)$', { regex: true })).text).toBe('row 2\nrow 3\nrow 4\n--\nrow 8\nrow 9\nrow 10');
  });

  it('reports no match', async () => {
    expect(await findLines(lines, 'absent')).toEqual({ text: 'No matches for "absent".', matches: 0 });
  });

  it('treats regex punctuation literally when the flag is absent', async () => {
    const result = await findLines(['a (b', 'c'], '(b');
    expect(result.matches).toBe(1);
    expect(result.text).toBe('a (b\nc');
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
