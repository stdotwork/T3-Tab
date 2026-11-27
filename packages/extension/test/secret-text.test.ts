import { afterEach, describe, expect, it } from 'vitest';

import { forgetClosedTab, joinTree, loadOpenerTrees, replaceTreeTab, treeOfTab } from '../src/opened-tabs';
import {
  addressForms,
  forgetSecrets,
  knownSecrets,
  matcher,
  noteCommitted,
  promoteAddressSecrets,
  rememberSecrets,
  replaceSecretsTab,
  scrubKnown,
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

  it('is taken out of an address in the form a GET form writes it, which also encodes !\'()~', () => {
    rememberSecrets(1, ["pa ss!w(rd)'~"]);
    expect(scrubReported(1, 'https://a.test/secure?password=pa+ss%21w%28rd%29%27%7E&x=1', true)).toBe('https://a.test/secure?password=<redacted>&x=1');
    expect(scrubReported(1, 'https://a.test/secure?password=pa%20ss%21w%28rd%29%27%7E', true)).toBe('https://a.test/secure?password=<redacted>');
  });

  it('is taken out of text the page wrote, such as a dialog\'s message, as written', () => {
    rememberSecrets(1, ['hunter2x']);
    expect(scrubKnown(1, 'Tab 1 is waiting on a JavaScript alert: "Saved hunter2x".')).toBe('Tab 1 is waiting on a JavaScript alert: "Saved <redacted>".');
    expect(scrubKnown(2, 'Saved hunter2x')).toBe('Saved hunter2x');
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

    it('comes back from session storage after the worker restarted, merged with a tree a page made meanwhile', async () => {
      // Stored before the restart: 30 opened 31, 32 and 33. Since the restart 31 opened 50; 33 closes during the load.
      joinTree(31, 50);
      trees.push(30, 31, 32, 33, 50);
      await loadOpenerTrees({
        stored: async () => {
          forgetClosedTab(33);
          return { 30: 30, 31: 30, 32: 30, 33: 30, 60: 60 };
        },
        open: async () => [{ id: 30 }, { id: 31 }, { id: 32 }, { id: 33 }, { id: 50 }],
      });
      const tree = treeOfTab(30);
      expect([treeOfTab(31), treeOfTab(32), treeOfTab(50)]).toEqual([tree, tree, tree]);
      expect(treeOfTab(33)).toBeUndefined();
      expect(treeOfTab(60)).toBeUndefined();
      rememberSecrets(32, ['restart-secret']);
      expect(scrubReported(50, 'https://a.test/?pw=restart-secret', true)).toBe('https://a.test/?pw=<redacted>');
    });

    it('is written to session storage as it changes', async () => {
      const written: Array<Record<string, unknown>> = [];
      const host = globalThis as unknown as { chrome?: unknown };
      const before = host.chrome;
      host.chrome = { storage: { session: { set: async (items: Record<string, unknown>) => void written.push(items) } } };
      try {
        tree(70, 71);
        await Promise.resolve();
        expect(written.at(-1)).toEqual({ 't3tab.openerTrees': expect.objectContaining({ 70: 70, 71: 70 }) });
      } finally {
        host.chrome = before;
      }
    });

    it('finds the tree values an address holds without building a matcher for each', () => {
      tree(1, 2);
      const values = Array.from({ length: 399 }, (_, index) => `value-${index}-${'x'.repeat(4_990)}`);
      rememberSecrets(1, values);
      const address = `https://a.test/?q=${values[7] ?? ''}`;
      const started = performance.now();
      for (let round = 0; round < 50; round += 1) scrubReported(2, address, true);
      // One matcher a value took about 46 ms a call (2.3 s for these 50).
      expect(performance.now() - started).toBeLessThan(1_000);
      expect(knownSecrets(2)).toEqual([values[7]]);
    });

    it('keeps a tree\'s values and a tab\'s own when the browser swaps the tab for another', () => {
      tree(1, 2);
      rememberSecrets(2, ['tree-only-value']);
      forgetClosedTab(2);
      forgetSecrets(2);
      rememberSecrets(1, ['own-value']);
      // Tab 1 is the tree's last tab.
      replaceTreeTab(3, 1);
      replaceSecretsTab(3, 1);
      trees.push(3);
      expect(knownSecrets(3)).toEqual(['own-value']);
      expect(knownSecrets(1)).toEqual([]);
      expect(scrubReported(3, 'https://a.test/?a=tree-only-value', true)).toBe('https://a.test/?a=<redacted>');
    });

    it('makes the tree\'s values the own of a tab a form was sent into, which can echo them', () => {
      tree(1, 2);
      rememberSecrets(1, ['posted-secret']);
      noteCommitted({ tabId: 2, frameId: 0, transitionType: 'link' });
      noteCommitted({ tabId: 2, frameId: 3, transitionType: 'form_submit' });
      expect(knownSecrets(2)).toEqual([]);
      noteCommitted({ tabId: 2, frameId: 0, transitionType: 'form_submit' });
      expect(knownSecrets(2)).toEqual(['posted-secret']);
    });
  });
});
