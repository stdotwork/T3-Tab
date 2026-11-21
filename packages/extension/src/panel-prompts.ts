import type { PermissionDecision, PromptKind, SitePermission } from './permissions';

export interface PromptChoice {
  decision: PermissionDecision;
  /** Says exactly what the button grants. */
  label: string;
  danger?: true;
}

const ONCE: Record<PromptKind, string> = {
  read: 'Allow reading once',
  open: 'Allow opening once',
  act: 'Allow acting once',
  run_js: 'Allow JavaScript once',
};

const EVERYTHING = 'Always allow everything on this site (reading, opening, acting, JavaScript)';

/** The buttons of a permission prompt. A read prompt's lasting choice grants reading only. */
export function promptChoices(tool: PromptKind): PromptChoice[] {
  return [
    { decision: 'allow-once', label: ONCE[tool] },
    tool === 'read'
      ? { decision: 'always-allow-read', label: 'Always allow reading on this site' }
      : { decision: 'always-allow', label: EVERYTHING },
    { decision: 'decline', label: 'Decline', danger: true },
  ];
}

export interface SiteChoice {
  setting: SitePermission;
  label: string;
}

/** What a site's setting lets sessions do, in words. */
export function siteStatus(setting: SitePermission): string {
  if (setting === 'allow') return 'Everything allowed: reading, opening, acting, JavaScript';
  if (setting === 'read') return 'Reading allowed; opening, acting and JavaScript ask';
  return 'Asks before reading, opening, acting and JavaScript';
}

/** The other settings a site can be switched to, each labelled with what it grants. */
export function siteChoices(setting: SitePermission): SiteChoice[] {
  const all: SiteChoice[] = [
    { setting: 'ask', label: 'Ask every time' },
    { setting: 'read', label: 'Always allow reading' },
    { setting: 'allow', label: 'Always allow everything' },
  ];
  return all.filter((choice) => choice.setting !== setting);
}

/**
 * True when showing `next` instead of `previous` moves a row that stays: a row went away above another, or
 * one appeared above another. Buttons under the owner's pointer can then be a different row's.
 */
export function rowsShifted(previous: readonly string[], next: readonly string[]): boolean {
  const before = new Set(previous);
  const after = new Set(next);
  const staysBelow = (ids: readonly string[], index: number, stays: Set<string>): boolean =>
    ids.slice(index + 1).some((id) => stays.has(id));
  return (
    previous.some((id, index) => !after.has(id) && staysBelow(previous, index, after)) ||
    next.some((id, index) => !before.has(id) && staysBelow(next, index, before))
  );
}
