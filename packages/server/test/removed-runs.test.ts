import type { AxNode } from '@t3-tab/protocol';
import { describe, expect, it } from 'vitest';

import { formatRead, TabState } from '../src/reader/page.js';
import { countRemovedRuns, REMOVED_RUN } from '../src/reader/removed-runs.js';
import { ax, page } from './ax-fixtures.js';

/** A page of 100 buttons that stay, then whatever `extra` adds, under one root. */
function withStable(extra: AxNode[], top: number[]): AxNode[] {
  const stable = Array.from({ length: 100 }, (_, index) => 900 + index);
  return [ax(1, 'RootWebArea', 'Page', [...top, ...stable]), ...extra, ...stable.map((id, index) => ax(id, 'button', `Keep ${index + 1}`))];
}

/** A combobox with its list of `count` options open, or closed with no list. */
function combo(open: boolean, count = 30): AxNode[] {
  const options = Array.from({ length: count }, (_, index) => 300 + index);
  const nodes = [
    ax(2, 'combobox', 'State', [], { value: open ? 'Wyo' : 'Wyoming', props: { expanded: open } }),
    ax(4, 'button', 'States', [], { props: { expanded: open } }),
    ...(open ? [ax(3, 'listbox', 'States', options), ...options.map((id, index) => ax(id, 'option', `Option ${index + 1}`))] : []),
  ];
  return withStable(nodes, open ? [2, 4, 3] : [2, 4]);
}

async function diffAfter(before: AxNode[], after: AxNode[], options: { all?: boolean } = {}): Promise<string> {
  const state = new TabState();
  await formatRead(state, 's', page(before), options);
  return await formatRead(state, 's', page(after), options);
}

describe('a long run of removed lines in a diff', () => {
  it('is counted in one line, keeping changed elements on both sides and the field that went', async () => {
    const reply = await diffAfter(combo(true), combo(false));
    expect(reply).toBe(
      [
        'tab 7',
        'Changed since the last read:',
        '@@',
        '-e1 combobox "State" value="Wyo" [expanded]',
        '-e2 button "States" [expanded]',
        '-e3 listbox "States"',
        '-  (30 lines removed: "Option 1", … "Option 30")',
        '+e1 combobox "State" value="Wyoming" [collapsed]',
        '+e2 button "States" [collapsed]',
        ' e34 button "Keep 1"',
      ].join('\n'),
    );
  });

  it('keeps every added line whole', async () => {
    const reply = await diffAfter(combo(false), combo(true));
    expect(reply).toMatch(/\n\+ {2}e\d+ option "Option 1"\n/);
    expect(reply).toMatch(/\n\+ {2}e\d+ option "Option 30"\n/);
    expect(reply).not.toContain('lines removed');
  });

  it(`prints a run shorter than ${REMOVED_RUN} lines whole`, async () => {
    const reply = await diffAfter(combo(true, REMOVED_RUN - 1), combo(false, REMOVED_RUN - 1));
    expect(reply).toMatch(new RegExp(`\\n- {2}e\\d+ option "Option ${REMOVED_RUN - 1}"\\n`));
    expect(reply).not.toContain('lines removed');
    const counted = await diffAfter(combo(true, REMOVED_RUN), combo(false, REMOVED_RUN));
    expect(counted).toContain(`-  (${REMOVED_RUN} lines removed: "Option 1", … "Option ${REMOVED_RUN}")`);
  });

  it('keeps the lines of a live region and a dialog that went, and fields, and counts the rest', async () => {
    const buttons = Array.from({ length: 10 }, (_, index) => 400 + index);
    const fields = Array.from({ length: 3 }, (_, index) => 500 + index);
    const before = withStable(
      [
        ax(10, 'alert', '', [11]),
        ax(11, 'StaticText', 'Card number is incomplete.'),
        ax(20, 'dialog', 'Confirm', [22, 21]),
        ax(22, 'paragraph', '', [23]),
        ax(23, 'StaticText', 'Cancel the order you placed today?'),
        ax(21, 'button', 'Cancel order'),
        ...buttons.map((id, index) => ax(id, 'button', `Extra ${index + 1}`)),
        ...fields.map((id, index) => ax(id, 'textbox', `Field ${index + 1}`)),
      ],
      [10, 20, ...buttons, ...fields],
    );
    const reply = await diffAfter(before, withStable([], []));
    expect(reply).toContain('\n-alert "Card number is incomplete."\n');
    expect(reply).toContain('\n-  "Cancel the order you placed today?"\n');
    expect(reply).toMatch(/-e\d+ dialog "Confirm"/);
    expect(reply).toMatch(/- {2}e\d+ button "Cancel order"/);
    for (const name of ['Field 1', 'Field 2', 'Field 3']) expect(reply).toMatch(new RegExp(`-e\\d+ textbox "${name}"`));
    expect(reply).toContain('-(10 lines removed: "Extra 1", … "Extra 10")');
    expect(reply).not.toContain('"Extra 5"');
  });

  it('counts the removed run of an `all` diff too', async () => {
    const reply = await diffAfter(combo(true), combo(false), { all: true });
    expect(reply).toContain('-  (30 lines removed: "Option 1", … "Option 30")');
  });
});

describe('countRemovedRuns', () => {
  const run = (count: number, make: (index: number) => string): string[] => Array.from({ length: count }, (_, index) => `-${make(index + 1)}`);

  it('names text lines by their text, cut, and lines without a name by what is left of them', () => {
    const long = 'x'.repeat(60);
    const diff = ['@@', ' e1 button "A"', ...run(9, (index) => (index === 9 ? 'e9 separator' : `"${index === 1 ? long : `Line ${index}`}"`)), ' e2 button "B"'].join('\n');
    expect(countRemovedRuns(diff, new Set())).toBe(['@@', ' e1 button "A"', `-(9 lines removed: "${'x'.repeat(39)}…", … "separator")`, ' e2 button "B"'].join('\n'));
  });

  it('treats each hunk on its own, so a ref added in another hunk does not keep a line', () => {
    const diff = ['@@', ...run(8, (index) => `e${index} option "O${index}"`), '@@', '+e1 option "O1"'].join('\n');
    expect(countRemovedRuns(diff, new Set())).toBe(['@@', '-(8 lines removed: "O1", … "O8")', '@@', '+e1 option "O1"'].join('\n'));
  });
});
