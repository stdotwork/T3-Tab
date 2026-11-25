/**
 * T3 Code's snooze menu: its default presets, the owner's own list from T3's `snoozePresets` setting when it has one,
 * and each preset's label and wake time worked out as T3's `threadSettled` module does.
 */
export type SnoozePreset = { kind: 'after'; minutes: number } | { kind: 'at'; day: 'today' | 'tomorrow' | Weekday; time: string };
type Weekday = 'sunday' | 'monday' | 'tuesday' | 'wednesday' | 'thursday' | 'friday' | 'saturday';

export interface SnoozeChoice {
  id: string;
  label: string;
  /** The wake time, with a short weekday when it is not today. */
  whenLabel: string;
  snoozedUntil: string;
}

export const DEFAULT_SNOOZE_PRESETS: readonly SnoozePreset[] = [
  { kind: 'after', minutes: 60 },
  { kind: 'after', minutes: 180 },
  { kind: 'at', day: 'today', time: '18:00' },
  { kind: 'at', day: 'tomorrow', time: '09:00' },
  { kind: 'at', day: 'monday', time: '09:00' },
];

const WEEKDAYS: readonly Weekday[] = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const capital = (day: string): string => day.charAt(0).toUpperCase() + day.slice(1);

/** The owner's presets from T3's settings, when they are a valid list; T3's defaults otherwise. */
export function snoozePresets(setting: unknown): readonly SnoozePreset[] {
  if (!Array.isArray(setting) || setting.length === 0 || setting.length > 8) return DEFAULT_SNOOZE_PRESETS;
  const valid = setting.filter(
    (entry): entry is SnoozePreset =>
      typeof entry === 'object' &&
      entry !== null &&
      ((entry.kind === 'after' && Number.isInteger(entry.minutes) && entry.minutes > 0 && entry.minutes <= 43_200) ||
        (entry.kind === 'at' && typeof entry.time === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(entry.time) && (entry.day === 'today' || entry.day === 'tomorrow' || WEEKDAYS.includes(entry.day)))),
  );
  return valid.length === setting.length ? valid : DEFAULT_SNOOZE_PRESETS;
}

function dayOffset(preset: Extract<SnoozePreset, { kind: 'at' }>, now: Date): number {
  if (preset.day === 'today') return 0;
  if (preset.day === 'tomorrow') return 1;
  return (WEEKDAYS.indexOf(preset.day) - now.getDay() + 7) % 7 || 7;
}

function afterLabel(minutes: number): string {
  const count = (value: number, unit: string): string => `In ${value} ${unit}${value === 1 ? '' : 's'}`;
  if (minutes % 1440 === 0) return count(minutes / 1440, 'day');
  if (minutes % 60 === 0) return count(minutes / 60, 'hour');
  return count(minutes, 'minute');
}

function atLabel(preset: Extract<SnoozePreset, { kind: 'at' }>, offset: number): string {
  if (offset === 0) {
    const hour = Number(preset.time.slice(0, 2));
    return hour < 12 ? 'This morning' : hour < 17 ? 'This afternoon' : 'This evening';
  }
  if (offset === 1) return 'Tomorrow';
  if (preset.day === 'monday') return 'Next week';
  if (preset.day === 'today' || preset.day === 'tomorrow') return '';
  return offset === 7 ? `Next ${capital(preset.day)}` : capital(preset.day);
}

const clock = (at: Date, locale?: string): string => at.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' });

/** One preset at `now`; an `at` preset whose time today has passed is left out, as T3 does. */
export function snoozeChoice(preset: SnoozePreset, now: Date, locale?: string): SnoozeChoice | undefined {
  let at: Date;
  let offset = 0;
  if (preset.kind === 'after') at = new Date(now.getTime() + preset.minutes * 60_000);
  else {
    offset = dayOffset(preset, now);
    at = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset, Number(preset.time.slice(0, 2)), Number(preset.time.slice(3)), 0, 0);
    if (at.getTime() <= now.getTime()) return undefined;
  }
  const time = clock(at, locale);
  const timeOnly = (preset.kind === 'at' && !(offset > 1 && preset.day === 'monday')) || at.toDateString() === now.toDateString();
  return {
    id: preset.kind === 'after' ? `after:${preset.minutes}` : `at:${preset.day}:${preset.time}`,
    label: preset.kind === 'after' ? afterLabel(preset.minutes) : atLabel(preset, offset),
    whenLabel: timeOnly ? time : `${at.toLocaleDateString(locale, { weekday: 'short' })} ${time}`,
    snoozedUntil: at.toISOString(),
  };
}

/** The menu: every preset that is still ahead, soonest first, one per minute. */
export function snoozeChoices(presets: readonly SnoozePreset[], now: Date, locale?: string): SnoozeChoice[] {
  const minute = (choice: SnoozeChoice): number => Math.floor(Date.parse(choice.snoozedUntil) / 60_000);
  const seen = new Set<number>();
  return presets
    .flatMap((preset) => snoozeChoice(preset, now, locale) ?? [])
    .sort((a, b) => minute(a) - minute(b))
    .filter((choice) => !seen.has(minute(choice)) && (seen.add(minute(choice)), true));
}
