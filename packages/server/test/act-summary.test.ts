import { describe, expect, it } from 'vitest';

import { renderTree } from '../src/reader/format.js';
import { RefTable } from '../src/reader/refs.js';
import { actSummary } from '../src/tools.js';
import { ax, signInPage } from './ax-fixtures.js';

describe('what an act batch does, for the owner’s prompt', () => {
  it('names each step’s element as the read printed it, and never what a step types or a character key', () => {
    const refs = new RefTable();
    // e1 form "Login", e2 textbox "Email" value="a@b.c", e3 button "Submit".
    renderTree(signInPage(), refs, { all: false });
    const summary = actSummary(
      [
        { action: 'fill', ref: 'e2', text: 'hunter2' } as never,
        { action: 'press', key: 'x' },
        { action: 'press', key: 'Enter' },
        { action: 'click', ref: 'e3' },
        { action: 'click', ref: 'e99' },
      ],
      refs,
    );
    expect(summary).toEqual([
      { action: 'fill', target: { role: 'textbox', name: 'Email' } },
      { action: 'press' },
      { action: 'press', key: 'Enter' },
      { action: 'click', target: { role: 'button', name: 'Submit' } },
      { action: 'click' },
    ]);
    expect(JSON.stringify(summary)).not.toMatch(/hunter2|a@b\.c/);
  });

  it('knows a link written into a line of text by its name', () => {
    const refs = new RefTable();
    const nodes = [ax(1, 'RootWebArea', '', [2]), ax(2, 'paragraph', '', [3, 4, 5]), ax(3, 'StaticText', 'Read the '), ax(4, 'link', 'returns policy', [6]), ax(5, 'StaticText', ' before you buy anything from this shop today.'), ax(6, 'StaticText', 'returns policy')];
    const lines = renderTree(nodes, refs, { all: false });
    expect(lines.join('\n')).toContain('[returns policy](e1)');
    expect(refs.targetOf('e1')).toEqual({ role: 'link', name: 'returns policy' });
  });
});
