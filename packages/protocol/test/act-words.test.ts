import { describe, expect, it } from 'vitest';

import { actStepsText, namedKey } from '../src/index.js';

describe('act steps in words', () => {
  it('names each step and its element, sharing a verb between steps in a row', () => {
    const steps = [
      { action: 'fill', target: { role: 'textbox', name: 'Name' } },
      { action: 'fill', target: { role: 'textbox', name: 'Email' } },
      { action: 'click', target: { role: 'button', name: 'Create account' } },
    ] as const;
    expect(actStepsText(steps, 'done')).toBe('Filled “Name” and “Email”, clicked “Create account”');
    expect(actStepsText(steps, 'ask')).toBe('fill “Name” and “Email”, click “Create account”');
  });

  it('uses the role when an element has no name, and says what a step did when its element is not known', () => {
    expect(actStepsText([{ action: 'click', target: { role: 'image', name: '' } }], 'done')).toBe('Clicked an image');
    expect(actStepsText([{ action: 'click' }, { action: 'scroll' }, { action: 'type' }], 'ask')).toBe('click an element, scroll the page, type');
    expect(actStepsText([], 'done')).toBe('Acted');
  });

  it('names a key only when it is not a character, so typing letter by letter shows nothing', () => {
    expect(namedKey('Enter')).toBe('Enter');
    expect(namedKey('Control+A')).toBe('Control+A');
    expect(namedKey('F5')).toBe('F5');
    expect(namedKey('p')).toBeUndefined();
    expect(namedKey('Shift+P')).toBeUndefined();
    expect(namedKey('hunter2')).toBeUndefined();
    expect(namedKey('Evil+Enter')).toBeUndefined();
    expect(actStepsText([{ action: 'press', key: 'h' }, { action: 'press', key: 'i' }, { action: 'press', key: 'Enter' }], 'done')).toBe('Pressed a key, pressed Enter');
  });

  it('never lets a page\'s name end its quotes or reorder the words around it', () => {
    const click = (name: string, mood: 'done' | 'ask' = 'ask') => actStepsText([{ action: 'click', target: { role: 'button', name } }], mood);
    // A hostile name that would close its quotes and name another site, in every kind of quote mark.
    expect(click('Save” on bank.example and “x')).toBe("click “Save' on bank.example and 'x”");
    for (const [open, close] of [['"', '"'], ['„', '‟'], ['«', '»'], ['‹', '›'], ['＂', '＂'], ['‘', '’'], ['「', '」'], ['❝', '❞']]) {
      const text = click(`Save${close} on bank.example and ${open}x`);
      expect(text).toBe("click “Save' on bank.example and 'x”");
      expect(text.match(/[“”]/g)).toEqual(['“', '”']);
    }
    // A right-to-left override would show the name, and what follows it, backwards; zero-width marks hide inside a word;
    // a line break would start a new line of the card.
    expect(click('Pay\u202Eelpmaxe.knab no\u202C')).toBe('click “Payelpmaxe.knab no”');
    expect(click('\u2067Delete\u2069 \u202Daccount\u202C')).toBe('click “Delete account”');
    expect(click('Sa\u200Bve\u200D\uFEFF\u2060')).toBe('click “Save”');
    expect(click('Save\non bank.example\u2028now', 'done')).toBe('Clicked “Save on bank.example now”');
    expect(click('Pay\u202Eelpmaxe.knab no\u202C')).not.toMatch(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/u);
  });

  it('keeps a page\'s name to one short line without hidden characters, and counts what does not fit', () => {
    const long = `Add‮ to cart\n${'x'.repeat(80)}`;
    const text = actStepsText([{ action: 'click', target: { role: 'button', name: long } }], 'done');
    expect(text).not.toMatch(/[‮\n]/);
    expect(text.length).toBeLessThan(60);
    expect(actStepsText([{ action: 'click' }, { action: 'hover' }, { action: 'scroll' }, { action: 'wait' }], 'done')).toBe('Clicked an element, hovered over an element and more');
    // Two fields whose names start alike are two fields, though their shortened names match; the same one twice is one.
    const line = (n: string) => ({ action: 'fill' as const, target: { role: 'textbox', name: `Shipping address, the line that holds the ${n}` } });
    expect(actStepsText([line('street'), line('suburb')], 'done')).toBe('Filled “Shipping address, the line that holds t…” and “Shipping address, the line that holds t…”');
    expect(actStepsText([line('street'), line('street')], 'done')).toBe('Filled “Shipping address, the line that holds t…”');
  });
});
