import { describe, expect, it } from 'vitest';

import { promptChoices, rowsShifted, SITE_CHOICES, siteStatus } from '../entrypoints/sidepanel/prompt-choices';

describe('what each prompt button says it grants', () => {
  it('limits a read prompt\'s lasting choice to reading', () => {
    expect(promptChoices('read').map((choice) => [choice.decision, choice.label])).toEqual([
      ['allow-once', 'Allow once'],
      ['always-allow-read', 'Always allow reading on this site'],
      ['decline', 'Decline'],
    ]);
  });

  it('names everything the lasting choice of an opening, acting or JavaScript prompt grants', () => {
    for (const tool of ['open', 'act', 'run_js'] as const) {
      const choices = promptChoices(tool);
      expect(choices.map((choice) => choice.decision)).toEqual(['allow-once', 'always-allow', 'decline']);
      expect(choices[1]?.label).toBe('Always allow everything on this site');
      expect(choices[1]?.detail).toBe('Reading, opening, acting and JavaScript');
    }
    expect(promptChoices('read')[1]?.detail).toBe('Opening, acting and JavaScript still ask');
    // The ask line says what is asked; the primary answer is the same plain words for every kind.
    for (const tool of ['read', 'open', 'act', 'run_js'] as const) expect(promptChoices(tool)[0]?.label).toBe('Allow once');
  });

  it('describes each site setting and names what each choice grants', () => {
    expect(siteStatus('read')).toBe('Reading allowed; opening, acting and JavaScript ask');
    expect(siteStatus('allow')).toMatch(/^Everything allowed/);
    expect(siteStatus('ask')).toMatch(/^Asks before/);
    expect(SITE_CHOICES.map((choice) => [choice.setting, choice.label])).toEqual([
      ['ask', 'Ask every time'],
      ['read', 'Always allow reading'],
      ['allow', 'Always allow everything'],
    ]);
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
