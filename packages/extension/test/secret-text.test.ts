import { afterEach, describe, expect, it } from 'vitest';

import { forgetClosedTab, noteOpenedTab } from '../src/opened-tabs';
import {
  addressForms,
  forgetSecrets,
  knownSecrets,
  matcher,
  rememberSecrets,
  scrubReported,
  shortScrub,
  shortScrubber,
} from '../src/secret-text';

describe('the matcher', () => {
  it('finds values whatever their case, and ignores values under four characters', () => {
    const found = matcher(['Hunter2x', 'ab']);
    expect(found.scrub('Say HUNTER2X, hunter2X and ab')).toBe('Say <redacted>, <redacted> and ab');
    expect(found.size).toBe(1);
  });

  it('joins values that overlap or start alike into one range, taking out the longest', () => {
    const found = matcher(['hunter2x', 'hunter2xyz', 'xyzzy1']);
    expect(found.scrub('a hunter2xyz b hunter2x c')).toBe('a <redacted> b <redacted> c');
    expect(found.scrub('hunter2xyzzy1!')).toBe('<redacted>!');
  });

  it('never matches inside its own marker, and starts again after it', () => {
    const found = matcher(['reda', 'acted']);
    expect(found.scrub('a <redacted> and reda')).toBe('a <redacted> and <redacted>');
    expect(found.scrub('<redacted>')).toBeUndefined();
    // A value cannot be put together from the end of one marker and what follows.
    expect(found.scrub('<redacted>cted')).toBeUndefined();
  });

  it('follows a value longer than its pattern limit to its end', () => {
    const body = Array.from({ length: 400 }, (_, index) => String.fromCharCode(0x4e00 + index)).join('');
    const found = matcher([`${body}TAIL`]);
    expect(found.scrub(`x ${body}TAIL y`)).toBe('x <redacted> y');
    // As far as the text follows the value, it is hidden, so no part of the value stays.
    expect(found.scrub(`x ${body}OTHER y`)).toBe('x <redacted>OTHER y');
  });

  it('keeps its positions for text whose letters change length when lower-cased', () => {
    const found = matcher(['secretvalue']);
    expect(found.scrub('İİİ SecretValue İİİ')).toBe('İİİ <redacted> İİİ');
  });

  it('costs one pass over the text however many values start alike', () => {
    const needles = Array.from({ length: 3_000 }, (_, index) => `PINVAL${index}x`);
    const text = `${needles.join(' ')} `.repeat(3);
    const found = matcher(needles);
    const started = performance.now();
    const scrubbed = found.scrub(text) ?? '';
    expect(performance.now() - started).toBeLessThan(500);
    expect(scrubbed).not.toContain('PINVAL');
  });
});

describe('short values', () => {
  it('are matched as whole words only, whatever their case', () => {
    expect(shortScrub('Item 42 of 420, a42 and X42y', ['42'])).toBe('Item <redacted> of 420, a42 and X42y');
    expect(shortScrub('PIN ab and cab', ['AB'])).toBe('PIN <redacted> and cab');
  });

  it('leave values of four characters or more to the matcher, and a marker alone', () => {
    expect(shortScrub('long value here', ['long value'])).toBeUndefined();
    expect(shortScrub('a <redacted> and red', ['red'])).toBe('a <redacted> and <redacted>');
    expect(shortScrubber([])('anything')).toBeUndefined();
  });
});

describe('addresses', () => {
  it('forms of a value as an address holds it', () => {
    expect(addressForms(['p@ss w&rd']).sort()).toEqual(['p%40ss%20w%26rd', 'p%40ss+w%26rd', 'p@ss%20w&rd', 'p@ss w&rd'].sort());
    expect(() => addressForms(['\ud800lone'])).not.toThrow();
  });
});

describe('what is remembered about a tab', () => {
  afterEach(() => {
    forgetSecrets(1);
    forgetSecrets(2);
  });

  it('is kept per tab, for values of four characters or more, and forgotten with the tab', () => {
    rememberSecrets(1, ['hunter2x', 'abc']);
    expect(knownSecrets(1)).toEqual(['hunter2x']);
    expect(knownSecrets(2)).toEqual([]);
    forgetSecrets(1);
    expect(knownSecrets(1)).toEqual([]);
  });

  it('lapses after half an hour', () => {
    rememberSecrets(1, ['hunter2x'], 1_000);
    expect(knownSecrets(1, 1_000 + 29 * 60_000)).toEqual(['hunter2x']);
    expect(knownSecrets(1, 1_000 + 31 * 60_000)).toEqual([]);
  });

  it('is taken out of a title and an address, in the forms an address holds it', () => {
    rememberSecrets(1, ['p@ss w&rd']);
    expect(scrubReported(1, 'Welcome p@ss w&rd', false)).toBe('Welcome <redacted>');
    expect(scrubReported(1, 'https://a.test/login?pw=p%40ss%20w%26rd&x=1', true)).toBe('https://a.test/login?pw=<redacted>&x=1');
    expect(scrubReported(1, 'https://a.test/login?pw=p%40ss+w%26rd', true)).toBe('https://a.test/login?pw=<redacted>');
    expect(scrubReported(2, 'https://a.test/login?pw=p%40ss%20w%26rd', true)).toBe('https://a.test/login?pw=p%40ss%20w%26rd');
    expect(scrubReported(undefined, 'Welcome p@ss w&rd', false)).toBe('Welcome p@ss w&rd');
  });

  it('keeps no entry for a tab with no value, so tabs without secrets do not push out the values of one', () => {
    rememberSecrets(1, ['hunter2x']);
    for (let tab = 1_000; tab < 1_300; tab += 1) rememberSecrets(tab, ['abc', '']);
    expect(knownSecrets(1)).toEqual(['hunter2x']);
    expect(knownSecrets(1_000)).toEqual([]);
  });

  it('reaches every open tab of the tree of openers, which a form can be sent into by name, whenever it is learnt', () => {
    // Tab 1 opened 2 and 3; 3 opened 4. Tab 9 is no relation.
    noteOpenedTab(1, 2, Promise.resolve());
    noteOpenedTab(1, 3, Promise.resolve());
    noteOpenedTab(3, 4, Promise.resolve());
    try {
      // Learnt on the opener after its tabs were opened: a form with target="results" sent into tab 2.
      rememberSecrets(1, ['NAMED-SECRET-91']);
      expect(scrubReported(2, 'https://a.test/?pw=NAMED-SECRET-91', true)).toBe('https://a.test/?pw=<redacted>');
      expect(knownSecrets(4)).toEqual(['NAMED-SECRET-91']);
      expect(knownSecrets(9)).toEqual([]);
      // A popup's form sent into its opener, or into a sibling, after the tab that opened them closed.
      forgetClosedTab(1);
      forgetSecrets(1);
      rememberSecrets(2, ['popup-secret']);
      expect(knownSecrets(4)).toEqual(['NAMED-SECRET-91', 'popup-secret']);
      expect(knownSecrets(1)).toEqual([]);
    } finally {
      for (const tab of [1, 2, 3, 4]) {
        forgetClosedTab(tab);
        forgetSecrets(tab);
      }
    }
  });
});
