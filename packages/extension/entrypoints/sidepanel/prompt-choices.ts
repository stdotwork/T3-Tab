import type { PermissionDecision, PromptKind, SitePermission } from '../../src/permissions';

export interface PromptChoice {
  decision: PermissionDecision;
  /** Says exactly what the button grants. */
  label: string;
  /** The rest of what a lasting choice means, under its label. */
  detail?: string;
  danger?: true;
}

/**
 * The buttons of a permission prompt. The ask line says what is asked, so the primary answer is plain "Allow once": it
 * allows that one request. A read prompt's lasting choice grants reading only.
 */
export function promptChoices(tool: PromptKind): PromptChoice[] {
  return [
    { decision: 'allow-once', label: 'Allow once' },
    tool === 'read'
      ? { decision: 'always-allow-read', label: 'Always allow reading on this site', detail: 'Opening, acting and JavaScript still ask' }
      : { decision: 'always-allow', label: 'Always allow everything on this site', detail: 'Reading, opening, acting and JavaScript' },
    { decision: 'decline', label: 'Decline', danger: true },
  ];
}

export interface SiteChoice {
  setting: SitePermission;
  /** Says exactly what the setting grants; read out and shown on hover. */
  label: string;
  /** The word on the control. The row's status line spells out the setting in force. */
  short: string;
}

/** What a site's setting lets sessions do, in words. */
export function siteStatus(setting: SitePermission): string {
  if (setting === 'allow') return 'Everything allowed: reading, opening, acting, JavaScript';
  if (setting === 'read') return 'Reading allowed; opening, acting and JavaScript ask';
  return 'Asks before reading, opening, acting and JavaScript';
}

/** The settings a site can have, each labelled with what it grants. */
export const SITE_CHOICES: readonly SiteChoice[] = [
  { setting: 'ask', label: 'Ask every time', short: 'Ask' },
  { setting: 'read', label: 'Always allow reading', short: 'Reading' },
  { setting: 'allow', label: 'Always allow everything', short: 'Everything' },
];

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
