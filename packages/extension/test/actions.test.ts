import { describe, expect, it } from 'vitest';

import { parseKey } from '../src/actions';

describe('keyboard steps', () => {
  it('maps named keys and single characters to CDP key events', () => {
    expect(parseKey('Enter')).toEqual({ key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' });
    expect(parseKey('Control+A')).toEqual({ key: 'A', code: 'KeyA', keyCode: 65, text: 'A' });
    expect(parseKey('ArrowDown')).toEqual({ key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 });
  });

  it('takes the usual spellings of a key, and keeps a single character as typed', () => {
    const named = (value: string): string => parseKey(value).key;
    expect(['enter', 'ENTER', 'return'].map(named)).toEqual(['Enter', 'Enter', 'Enter']);
    expect(['esc', 'Escape', 'ESC'].map(named)).toEqual(['Escape', 'Escape', 'Escape']);
    expect(['up', 'pgdn', 'del', 'space', 'ctrl+f5'].map(named)).toEqual(['ArrowUp', 'PageDown', 'Delete', ' ', 'F5']);
    expect(parseKey('f12')).toEqual({ key: 'F12', code: 'F12', keyCode: 123 });
    expect(parseKey('a').key).toBe('a');
    expect(parseKey('A').key).toBe('A');
    expect(parseKey('+').key).toBe('+');
    expect(parseKey('Control++').key).toBe('+');
  });

  it('rejects an unknown key name', () => {
    expect(() => parseKey('F13')).toThrow('Unknown key: F13');
  });
});
