import { describe, expect, it } from 'vitest';

import { findLines } from '../src/reader/find.js';

const lines = Array.from({ length: 30 }, (_, index) => `row ${index}`);

describe('find', () => {
  it('returns matching lines with one line of context either side', () => {
    expect(findLines(lines, 'row 10').text).toBe('row 9\nrow 10\nrow 11');
  });

  it('matches case-insensitively and as a regular expression', () => {
    expect(findLines(lines, 'ROW (3|5)$').text).toBe('row 2\nrow 3\nrow 4\nrow 5\nrow 6');
  });

  it('merges neighbouring matches into one block', () => {
    expect(findLines(lines, 'row (3|4)$').text).toBe('row 2\nrow 3\nrow 4\nrow 5');
  });

  it('separates distant matches', () => {
    expect(findLines(lines, 'row (3|9)$').text).toBe('row 2\nrow 3\nrow 4\n--\nrow 8\nrow 9\nrow 10');
  });

  it('reports no match', () => {
    expect(findLines(lines, 'absent')).toEqual({ text: 'No matches for "absent".', matches: 0 });
  });

  it('searches for a query that is not a valid regular expression as plain text', () => {
    const result = findLines(['a (b', 'c'], '(b');
    expect(result.matches).toBe(1);
    expect(result.text).toBe('a (b\nc');
  });

  it('caps the matches it shows and says how many it left out', () => {
    const many = Array.from({ length: 100 }, (_, index) => `item ${index}`);
    const result = findLines(many, 'item');
    expect(result.matches).toBe(100);
    expect(result.text).toContain('(80 more matches; narrow the query)');
  });
});
