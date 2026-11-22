import { describe, expect, it } from 'vitest';

import { promptChoices, rowsShifted, siteChoices, siteStatus } from '../entrypoints/sidepanel/prompt-choices';

describe('what each prompt button says it grants', () => {
  it('limits a read prompt\'s lasting choice to reading', () => {
    expect(promptChoices('read').map((choice) => [choice.decision, choice.label])).toEqual([
      ['allow-once', 'Allow reading once'],
      ['always-allow-read', 'Always allow reading on this site'],
      ['decline', 'Decline'],
    ]);
  });

  it('names everything the lasting choice of an opening, acting or JavaScript prompt grants', () => {
    for (const tool of ['open', 'act', 'run_js'] as const) {
      const choices = promptChoices(tool);
      expect(choices.map((choice) => choice.decision)).toEqual(['allow-once', 'always-allow', 'decline']);
      expect(choices[1]?.label).toBe('Always allow everything on this site (reading, opening, acting, JavaScript)');
    }
    expect(promptChoices('act')[0]?.label).toBe('Allow acting once');
    expect(promptChoices('run_js')[0]?.label).toBe('Allow JavaScript once');
    expect(promptChoices('open')[0]?.label).toBe('Allow opening once');
  });

  it('describes each site setting and offers the other two', () => {
    expect(siteStatus('read')).toBe('Reading allowed; opening, acting and JavaScript ask');
    expect(siteStatus('allow')).toMatch(/^Everything allowed/);
    expect(siteStatus('ask')).toMatch(/^Asks before/);
    expect(siteChoices('read').map((choice) => choice.setting)).toEqual(['ask', 'allow']);
    expect(siteChoices('ask').map((choice) => choice.setting)).toEqual(['read', 'allow']);
    expect(siteChoices('allow').map((choice) => choice.label)).toEqual(['Ask every time', 'Always allow reading']);
  });
});

describe('when prompt rows shift under the pointer', () => {
  it('flags a row removed above another, or inserted above another', () => {
    expect(rowsShifted(['a', 'b'], ['b'])).toBe(true);
    expect(rowsShifted(['a', 'b', 'c'], ['a', 'c'])).toBe(true);
    expect(rowsShifted(['b'], ['a', 'b'])).toBe(true);
    expect(rowsShifted(['a', 'c'], ['a', 'b', 'c'])).toBe(true);
  });

  it('does not flag a row added or removed below the others, or no change', () => {
    expect(rowsShifted(['a', 'b'], ['a'])).toBe(false);
    expect(rowsShifted(['a'], ['a', 'b'])).toBe(false);
    expect(rowsShifted(['a', 'b'], ['a', 'b'])).toBe(false);
    expect(rowsShifted([], ['a'])).toBe(false);
    expect(rowsShifted(['a'], [])).toBe(false);
  });
});
