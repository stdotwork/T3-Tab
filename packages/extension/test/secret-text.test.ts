import { afterEach, describe, expect, it } from 'vitest';

import { forgetClosedTab, joinTree, rebuildOpenerTrees, treeOfTab } from '../src/opened-tabs';
import {
  addressForms,
  forgetSecrets,
  knownSecrets,
  matcher,
  promoteAddressSecrets,
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

  describe('in a tree of openers', () => {
    const trees: number[] = [];
    const tree = (opener: number, ...tabs: number[]): void => {
      for (const tab of tabs) joinTree(opener, tab);
      trees.push(opener, ...tabs);
    };
    afterEach(() => {
      for (const tab of trees.splice(0)) {
        forgetClosedTab(tab);
        forgetSecrets(tab);
      }
    });

    it('takes a value of another tab out of the title and address only, never out of the page text', () => {
      // Tab 1 opened 2, as a middle click or a link with a target does; 9 is no relation.
      tree(1, 2);
      rememberSecrets(1, ['2026']);
      expect(knownSecrets(2)).toEqual([]);
      expect(scrubReported(2, 'https://a.test/orders?year=2026', true)).toBe('https://a.test/orders?year=<redacted>');
      expect(scrubReported(9, 'https://a.test/orders?year=2026', true)).toBe('https://a.test/orders?year=2026');
    });

    it('makes a value of the tree that a tab\'s address carries one of the tab\'s own, which its page can echo', () => {
      tree(1, 2, 3);
      // Learnt on the form's tab after the others were opened: a form with target="results" sent into tab 2.
      rememberSecrets(1, ['NAMED-SECRET-91', 'other-secret']);
      promoteAddressSecrets(2, 'https://a.test/secure?password=NAMED-SECRET-91');
      expect(knownSecrets(2)).toEqual(['NAMED-SECRET-91']);
      expect(knownSecrets(3)).toEqual([]);
    });

    it('keeps reaching the tree after the form\'s tab closed, in every direction a name reaches', () => {
      tree(1, 2, 3);
      forgetClosedTab(1);
      forgetSecrets(1);
      rememberSecrets(2, ['popup-secret']);
      expect(scrubReported(3, 'https://a.test/?pw=popup-secret', true)).toBe('https://a.test/?pw=<redacted>');
    });

    it('never pushes out a tab\'s own values, however large the tree', () => {
      rememberSecrets(5, ['unrelated-value']);
      tree(1, ...Array.from({ length: 201 }, (_, index) => 1_000 + index));
      rememberSecrets(1, ['FORM-SECRET-1']);
      for (let tab = 1_000; tab < 1_201; tab += 1) scrubReported(tab, `https://a.test/${tab}`, true);
      rememberSecrets(1_200, ['popup-value']);
      expect(knownSecrets(1)).toEqual(['FORM-SECRET-1']);
      expect(knownSecrets(5)).toEqual(['unrelated-value']);
      expect(scrubReported(1_000, 'https://a.test/?a=FORM-SECRET-1&b=popup-value', true)).toBe('https://a.test/?a=<redacted>&b=<redacted>');
    });

    it('builds its matcher once until a value is added, so listing the tabs of a large tree stays quick', () => {
      tree(1, ...Array.from({ length: 19 }, (_, index) => 2 + index));
      rememberSecrets(1, Array.from({ length: 399 }, (_, index) => `value-${index}-${'x'.repeat(4_990)}`));
      const started = performance.now();
      for (let round = 0; round < 10; round += 1) for (let tab = 2; tab < 21; tab += 1) scrubReported(tab, `https://a.test/${tab}?q=value-1-xx`, true);
      // Built for each call, this took about 90 ms a call here (17 s for these 190); built once, well under a second.
      expect(performance.now() - started).toBeLessThan(2_000);
      rememberSecrets(1, ['later-value']);
      expect(scrubReported(2, 'https://a.test/?pw=later-value', true)).toBe('https://a.test/?pw=<redacted>');
    });

    it('is built again from the openers the browser records when the worker starts, leaving out a tab that closed', async () => {
      const listing = rebuildOpenerTrees(async () => {
        // Tab 33 closes while the browser lists the tabs.
        forgetClosedTab(33);
        return [{ id: 30 }, { id: 31, openerTabId: 30 }, { id: 32, openerTabId: 31 }, { id: 33, openerTabId: 30 }, { id: 34 }];
      });
      await listing;
      trees.push(30, 31, 32, 33, 34);
      expect([treeOfTab(30), treeOfTab(31), treeOfTab(32)]).toEqual([30, 30, 30]);
      expect(treeOfTab(33)).toBeUndefined();
      expect(treeOfTab(34)).toBeUndefined();
      rememberSecrets(32, ['restart-secret']);
      expect(scrubReported(30, 'https://a.test/?pw=restart-secret', true)).toBe('https://a.test/?pw=<redacted>');
    });
  });
});
