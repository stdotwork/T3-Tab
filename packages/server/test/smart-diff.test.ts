import { describe, expect, it } from 'vitest';

import { createSmartDiff } from '../src/reader/smart-diff.js';

const hundred = Array.from({ length: 100 }, (_, index) => `line ${index + 1}: some content here`);

describe('smart diff', () => {
  it('reports no change for identical content', () => {
    const result = createSmartDiff({ oldContent: 'hello\nworld', newContent: 'hello\nworld' });
    expect(result.type).toBe('no-change');
  });

  it('returns a diff with one line of context when a few lines of a long text change', () => {
    const changed = [...hundred];
    changed[50] = 'line 51: MODIFIED content here';
    const result = createSmartDiff({ oldContent: hundred.join('\n'), newContent: changed.join('\n') });
    expect(result.type).toBe('diff');
    expect(result.content.split('\n')).toEqual([
      '@@',
      ' line 50: some content here',
      '-line 51: some content here',
      '+line 51: MODIFIED content here',
      ' line 52: some content here',
    ]);
  });

  it('leaves out the no-newline-at-end-of-file markers', () => {
    const changed = [...hundred];
    changed[99] = 'line 100: MODIFIED content here';
    const result = createSmartDiff({ oldContent: hundred.join('\n'), newContent: changed.join('\n') });
    expect(result.type).toBe('diff');
    expect(result.content).not.toContain('No newline');
    expect(result.content.split('\n')).toEqual([
      '@@',
      ' line 99: some content here',
      '-line 100: some content here',
      '+line 100: MODIFIED content here',
    ]);
  });

  it('falls back to the full text when more than half of the lines changed', () => {
    const changed = hundred.map((line, index) => (index < 60 ? `CHANGED ${index}` : line));
    const result = createSmartDiff({ oldContent: hundred.join('\n'), newContent: changed.join('\n') });
    expect(result.type).toBe('full');
    expect(result.content).toBe(changed.join('\n'));
  });

  it('stays a diff just under the threshold', () => {
    const changed = hundred.map((line, index) => (index < 40 ? `C ${index}` : line));
    const result = createSmartDiff({ oldContent: hundred.join('\n'), newContent: changed.join('\n') });
    expect(result.type).toBe('diff');
  });

  it('honours a custom threshold', () => {
    const changed = hundred.map((line, index) => (index < 40 ? `C ${index}` : line));
    const result = createSmartDiff({ oldContent: hundred.join('\n'), newContent: changed.join('\n'), threshold: 0.3 });
    expect(result.type).toBe('full');
  });

  it('returns the full text when the diff would be no shorter', () => {
    const result = createSmartDiff({ oldContent: 'a\nb\nc\nd\ne', newContent: 'a\nb2\nc\nd\ne' });
    expect(result.type).toBe('full');
  });

  it('returns the full text for all-new and all-removed content', () => {
    expect(createSmartDiff({ oldContent: '', newContent: 'new\ncontent\nhere' }).type).toBe('full');
    expect(createSmartDiff({ oldContent: 'old\ncontent\nhere', newContent: '' })).toEqual({ type: 'full', content: '' });
  });
});
