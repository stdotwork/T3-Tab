import type { AxNode } from '@t3-tab/protocol';
import { describe, expect, it } from 'vitest';

import type { SetValue } from '../src/reader/echo.js';
import { formatRead, TabState } from '../src/reader/page.js';
import { ax, page } from './ax-fixtures.js';

type Fields = { name?: string; email?: string; country?: string; nameFlags?: Record<string, boolean>; welcome?: string };

/** The sign-up form of the token benchmark: two text fields, a country select with three options, a button. */
function form(fields: Fields = {}): AxNode[] {
  const country = fields.country ?? 'Australia';
  const option = (id: number, name: string): AxNode =>
    ax(id, 'option', name, [], country === name ? { props: { selected: true } } : {});
  const nodes = [
    ax(1, 'RootWebArea', 'Sign up', [2, 3, ...(fields.welcome === undefined ? [] : [11])]),
    ax(2, 'heading', 'Create an account', [], { props: { level: 1 } }),
    ax(3, 'form', 'Sign up', [4, 5, 6, 10]),
    ax(4, 'textbox', 'Name', [], { props: { required: true, ...fields.nameFlags }, ...(fields.name === undefined ? {} : { value: fields.name }) }),
    ax(5, 'textbox', 'Email', [], fields.email === undefined ? {} : { value: fields.email }),
    ax(6, 'combobox', 'Country', [7, 8, 9], { value: country, props: { expanded: false } }),
    option(7, 'Australia'),
    option(8, 'Brazil'),
    option(9, 'Canada'),
    ax(10, 'button', 'Create account'),
  ];
  if (fields.welcome !== undefined) nodes.push(ax(11, 'paragraph', '', [12]), ax(12, 'StaticText', fields.welcome));
  return nodes;
}

const fillName = (text: string): SetValue => ({ ref: 'e2', kind: 'value', text });
const fillEmail = (text: string): SetValue => ({ ref: 'e3', kind: 'value', text });
const pickCountry = (text: string): SetValue => ({ ref: 'e4', kind: 'select', text });

/** Reads the blank form (which gives the refs: e1 form, e2 Name, e3 Email, e4 Country, e5-e7 options, e8 button). */
async function readBlank(): Promise<TabState> {
  const state = new TabState();
  const first = await formatRead(state, 's', page(form()), {});
  expect(first).toContain('e2 textbox "Name" [required]');
  expect(first).toContain('e4 combobox "Country" value="Australia" [collapsed]');
  return state;
}

describe('an act reply leaves out what the batch set', () => {
  it('says which refs were set and what else changed, not the values it just typed', async () => {
    const state = await readBlank();
    const after = page(form({ name: 'Ada Lovelace', email: 'ada@example.com', country: 'Brazil', welcome: 'Welcome Ada Lovelace (ada@example.com)' }));
    const reply = await formatRead(state, 's', after, { echoed: [fillName('Ada Lovelace'), fillEmail('ada@example.com'), pickCountry('Brazil')] });
    expect(reply).toBe(
      [
        'tab 7',
        'Set e2, e3, e4.',
        'Text changed since the last read:',
        '@@',
        '   button "Create account"',
        '+"Welcome Ada Lovelace (ada@example.com)"',
      ].join('\n'),
    );
    expect(reply).not.toContain('Ada Lovelace" [required]');
    expect(reply).not.toContain('value="Brazil"');
    expect(reply).toContain('"Welcome Ada Lovelace (ada@example.com)"');
  });

  it('is only a short line when nothing else changed', async () => {
    const state = await readBlank();
    const after = page(form({ name: 'Ada', country: 'Canada' }));
    const reply = await formatRead(state, 's', after, { echoed: [fillName('Ada'), pickCountry('Canada')] });
    expect(reply).toBe('tab 7\nSet e2, e4. Nothing else changed.');
  });

  it('shows the same change in full when the batch set nothing', async () => {
    const state = await readBlank();
    const reply = await formatRead(state, 's', page(form({ name: 'Ada' })), {});
    expect(reply).toContain('+  e2 textbox "Name" value="Ada" [required]');
  });

  it('keeps a value the page changed on its own, such as a mask', async () => {
    const state = await readBlank();
    const reply = await formatRead(state, 's', page(form({ name: 'Ada', email: '(555) 12' })), {
      echoed: [fillName('Ada'), fillEmail('555 12')],
    });
    expect(reply).toContain('Set e2.');
    expect(reply).toContain('+  e3 textbox "Email" value="(555) 12"');
    expect(reply).not.toMatch(/^[+-] +e2/m);
  });

  it('keeps a line that changed in another way too, such as a validation flag', async () => {
    const state = await readBlank();
    const reply = await formatRead(state, 's', page(form({ name: 'A', nameFlags: { invalid: true } })), { echoed: [fillName('A')] });
    expect(reply).not.toContain('Set e2');
    expect(reply).toContain('+  e2 textbox "Name" value="A" [required invalid]');
  });

  it('keeps a select the page put on another option than the one chosen', async () => {
    const state = await readBlank();
    const reply = await formatRead(state, 's', page(form({ country: 'Canada' })), { echoed: [pickCountry('Brazil')] });
    expect(reply).not.toContain('Set e4');
    expect(reply).toContain('e4 combobox "Country" value="Canada"');
  });

  it('keeps a select it cannot match to the option by name', async () => {
    const state = await readBlank();
    const reply = await formatRead(state, 's', page(form({ country: 'Brazil' })), { echoed: [pickCountry('BR')] });
    expect(reply).not.toContain('Set e4');
    expect(reply).toContain('value="Brazil"');
  });

  it('keeps a field set twice in one batch, whose last value the lines cannot vouch for', async () => {
    const state = await readBlank();
    const reply = await formatRead(state, 's', page(form({ name: 'Second' })), { echoed: [fillName('First'), fillName('Second')] });
    expect(reply).toContain('value="Second"');
  });

  it('knows a typed value on top of what was there', async () => {
    const state = new TabState();
    await formatRead(state, 's', page(form({ name: 'Ada' })), {});
    const reply = await formatRead(state, 's', page(form({ name: 'Ada Lovelace' })), {
      echoed: [{ ref: 'e2', kind: 'value', text: ' Lovelace', appends: true }],
    });
    expect(reply).toBe('tab 7\nSet e2. Nothing else changed.');
  });

  it('compares a long value as the line prints it, cut', async () => {
    const state = await readBlank();
    const long = 'x'.repeat(200);
    const reply = await formatRead(state, 's', page(form({ name: long })), { echoed: [fillName(long)] });
    expect(reply).toBe('tab 7\nSet e2. Nothing else changed.');
  });

  it('knows a field that was emptied', async () => {
    const state = new TabState();
    await formatRead(state, 's', page(form({ name: 'Ada' })), {});
    const reply = await formatRead(state, 's', page(form({})), { echoed: [fillName('')] });
    expect(reply).toBe('tab 7\nSet e2. Nothing else changed.');
  });

  it('still says nothing changed when the batch changed nothing', async () => {
    const state = await readBlank();
    const reply = await formatRead(state, 's', page(form()), { echoed: [fillName('')] });
    expect(reply).toBe('tab 7\nNo changes since the last read.');
  });

  it('keeps later reads right: the baseline is the page as it is, values included', async () => {
    const state = await readBlank();
    await formatRead(state, 's', page(form({ name: 'Ada' })), { echoed: [fillName('Ada')] });
    const again = await formatRead(state, 's', page(form({ name: 'Ada', email: 'a@b.c' })), {});
    expect(again).toContain('+  e3 textbox "Email" value="a@b.c"');
    expect(again).not.toMatch(/^[+-] +e2/m);
  });
});
