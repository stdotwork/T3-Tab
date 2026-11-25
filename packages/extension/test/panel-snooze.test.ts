import { describe, expect, it } from 'vitest';

import { DEFAULT_SNOOZE_PRESETS, snoozeChoices, snoozePresets } from '../entrypoints/sidepanel/lib/snooze';
import { projectHue, projectInitials } from '../entrypoints/sidepanel/ui';

const at = (text: string): Date => new Date(text);

describe("T3's snooze menu", () => {
  it('lists the defaults on a Wednesday afternoon in T3\'s words, soonest first', () => {
    const choices = snoozeChoices(DEFAULT_SNOOZE_PRESETS, at('2026-11-25T14:06:00'), 'en-US');
    expect(choices.map((choice) => choice.label)).toEqual(['In 1 hour', 'In 3 hours', 'This evening', 'Tomorrow', 'Next week']);
    expect(choices.map((choice) => choice.whenLabel)).toEqual(['3:06 PM', '5:06 PM', '6:00 PM', '9:00 AM', 'Mon 9:00 AM']);
    expect(new Date(choices[4]?.snoozedUntil ?? '').getTime()).toBe(at('2026-11-30T09:00:00').getTime());
  });

  it('leaves out a time today that has passed', () => {
    const labels = snoozeChoices(DEFAULT_SNOOZE_PRESETS, at('2026-11-25T19:00:00'), 'en-US').map((choice) => choice.label);
    expect(labels).toEqual(['In 1 hour', 'In 3 hours', 'Tomorrow', 'Next week']);
  });

  it('keeps one choice when two presets land on the same minute (Sunday: tomorrow and Monday are both 9:00)', () => {
    const choices = snoozeChoices(DEFAULT_SNOOZE_PRESETS, at('2026-11-29T10:00:00'), 'en-US');
    expect(choices.filter((choice) => choice.whenLabel === '9:00 AM')).toHaveLength(1);
    expect(choices.map((choice) => choice.label)).toEqual(['In 1 hour', 'In 3 hours', 'This evening', 'Tomorrow']);
  });

  it("names whole days and hours, and uses the owner's list from T3's settings only when it is valid", () => {
    expect(snoozeChoices([{ kind: 'after', minutes: 2880 }], at('2026-11-25T14:00:00'), 'en-US')[0]?.label).toBe('In 2 days');
    expect(snoozePresets([{ kind: 'after', minutes: 30 }])).toEqual([{ kind: 'after', minutes: 30 }]);
    expect(snoozePresets([{ kind: 'at', day: 'someday', time: '09:00' }])).toBe(DEFAULT_SNOOZE_PRESETS);
    expect(snoozePresets(undefined)).toBe(DEFAULT_SNOOZE_PRESETS);
  });
});

describe("T3's project avatar", () => {
  // Letters and colours as T3 Code's own sidebar draws these projects.
  it.each([
    ['t3-in-chrome', 'T3', 'indigo'],
    ['proj-alpha', 'PA', 'yellow'],
    ['virtus-umbrella', 'VU', 'sky'],
  ])('%s is %s in %s', (name, initials, hue) => {
    expect(projectInitials(name)).toBe(initials);
    expect(projectHue(name)).toBe(hue);
  });
});
