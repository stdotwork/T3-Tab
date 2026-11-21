import { describe, expect, it } from 'vitest';

import { parseKey } from '../src/actions';

describe('keyboard steps', () => {
  it('maps named keys and single characters to CDP key events', () => {
    expect(parseKey('Enter')).toEqual({ key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' });
    expect(parseKey('Control+A')).toEqual({ key: 'A', code: 'KeyA', keyCode: 65, text: 'A' });
    expect(parseKey('ArrowDown')).toEqual({ key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 });
  });

  it('rejects an unknown key name', () => {
    expect(() => parseKey('F13')).toThrow('Unknown key: F13');
  });
});
