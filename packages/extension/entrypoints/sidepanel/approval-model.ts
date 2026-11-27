/*
 * What one approval card shows, for both kinds of ask: a browser permission prompt from any MCP session, and a T3
 * thread's own approval (a command, a file read or change, a permission). Both take T3 Code's approval anatomy
 * (`ComposerPendingApprovalActions` in T3's web app): Decline and the primary answer on the row, every other answer
 * under More. A browser prompt's lasting choice is one of those others, so it is kept but never the dominant button.
 */
import { actStepsText, type ActStepSummary } from '@t3-tab/protocol';

import type { PermissionDecision, PermissionPrompt } from '../../src/permissions';
import type { PendingApproval } from './lib/thread-model';
import { promptChoices, rowsShifted } from './prompt-choices';

/** How long a card takes no answer after it appears, after cards shift around it, and after it becomes the keyed card. */
export const BUTTON_DELAY_MS = 500;

export interface ApprovalAction<D extends string = string> {
  decision: D;
  /** Says exactly what the answer grants. */
  label: string;
  /** The rest of what a lasting choice means, under its label. */
  detail?: string;
  /** T3's caution for this answer, shown on it as T3 shows it. */
  warning?: string;
}

export interface ApprovalModel<D extends string = string> {
  /** The one line saying what is asked. `subject` is the part set in mono: a site, a command or a path. */
  ask: { who?: string; verb: string; subject: string; mono: boolean };
  /** A line under it: the address a prompt would load, or T3's reason. */
  detail?: { text: string; mono: boolean };
  /** The tab the ask is about, by its title: `"Title"`, or `in "Title"` under an address. */
  tab?: string;
  /** Absent when the asker offers no such answer: nothing is drawn for it and no key gives it. */
  decline?: ApprovalAction<D>;
  primary?: ApprovalAction<D>;
  /** Everything else, in T3's order, behind More. */
  more: ApprovalAction<D>[];
  /** Why no answer can be given now; every answer is disabled while it is set. */
  unanswerable?: string;
}

const plain = (text: string): string => [...text].filter((character) => (character.codePointAt(0) ?? 0) >= 32).join('');

const VERB: Record<PermissionPrompt['tool'], string> = {
  read: 'wants to read',
  open: 'wants to open',
  act: 'wants to act on',
  run_js: 'wants to run JavaScript on',
};

/** Most characters of what an act prompt says it will do, so the ask line, site and all, stays within the card's three lines. */
const ACT_ASK_MAX = 48;

/**
 * What an act prompt asks to do, from the steps the MCP server described (`click “Add to cart”`): all of it when it is
 * short, else its first part and "and more", else its first step alone with a shorter name and "and more".
 */
function actVerb(steps: readonly ActStepSummary[] | undefined): string {
  if (steps === undefined || steps.length === 0) return VERB.act;
  for (const limits of [{}, { phrases: 1 }]) {
    const words = actStepsText(steps, 'ask', limits);
    if (words.length <= ACT_ASK_MAX) return `wants to ${words} on`;
  }
  const [first] = steps;
  const words = first === undefined ? 'act' : actStepsText([first], 'ask', { name: 24 });
  return `wants to ${words}${steps.length > 1 ? ' and more' : ''} on`;
}

const hostOf = (origin: string): string => {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
};

/**
 * A browser permission prompt: who asks, the verb and the site; then the address it would load, if any, and the tab it is
 * about by its title (a `goto`, `back`, `forward` or `reload` has both).
 */
export function promptApproval(prompt: PermissionPrompt, asker: string): ApprovalModel<PermissionDecision> {
  const choices = promptChoices(prompt.tool);
  const pick = (test: (decision: PermissionDecision) => boolean): ApprovalAction<PermissionDecision> => {
    const found = choices.find((choice) => test(choice.decision));
    if (found === undefined) throw new Error(`No ${prompt.tool} prompt choice`);
    return { decision: found.decision, label: found.label, ...(found.detail === undefined ? {} : { detail: found.detail }) };
  };
  const address = prompt.url === undefined ? undefined : plain(prompt.url);
  const quoted = prompt.tab === undefined ? undefined : `"${plain(prompt.tab.title) || '(untitled)'}"`;
  const tab = quoted === undefined ? undefined : address === undefined ? quoted : `in ${quoted}`;
  return {
    ask: { who: plain(asker), verb: prompt.tool === 'act' ? actVerb(prompt.steps) : VERB[prompt.tool], subject: hostOf(prompt.origin), mono: true },
    ...(address === undefined ? {} : { detail: { text: address, mono: true } }),
    ...(tab === undefined ? {} : { tab }),
    decline: pick((decision) => decision === 'decline'),
    primary: pick((decision) => decision === 'allow-once'),
    more: [pick((decision) => decision !== 'allow-once' && decision !== 'decline')],
  };
}

const T3_VERB: Record<string, { verb: string; mono: boolean }> = {
  command: { verb: 'Run', mono: true },
  'file-change': { verb: 'Change', mono: true },
  'file-read': { verb: 'Read', mono: true },
  permission: { verb: 'Allow', mono: false },
  'mcp-elicitation': { verb: 'Allow', mono: false },
};

/** T3's answer order: Cancel, Decline, the lasting ones, Approve. Decline and Approve go on the row, the rest under More. */
const T3_ORDER = ['cancel', 'decline', 'acceptForSession', 'acceptAlways', 'accept'];

/**
 * A T3 thread's approval: the command or path asked about, T3's reason under it, and only the answers T3 offers. With no
 * `accept` there is no primary answer and Enter gives nothing; with no `decline`, Escape gives nothing.
 */
export function t3Approval(approval: PendingApproval): ApprovalModel {
  const kind = T3_VERB[approval.kind] ?? { verb: 'Allow', mono: false };
  const options = [...approval.options].sort((a, b) => rank(a.decision) - rank(b.decision));
  const action = (option: (typeof options)[number]): ApprovalAction => ({ decision: option.decision, label: option.label, ...(option.warning === undefined || option.warning === '' ? {} : { warning: option.warning }) });
  const decline = options.find((option) => option.decision === 'decline');
  const primary = options.find((option) => option.decision === 'accept');
  return {
    ask: { verb: kind.verb, subject: approval.title, mono: kind.mono },
    ...(approval.detail === undefined || approval.detail === '' ? {} : { detail: { text: approval.detail, mono: false } }),
    ...(decline === undefined ? {} : { decline: action(decline) }),
    ...(primary === undefined ? {} : { primary: action(primary) }),
    more: options.filter((option) => option.decision !== 'decline' && option.decision !== 'accept').map(action),
    // T3's own words when the provider can no longer take an answer (TimelinePendingApprovalRow).
    ...(approval.responseCapability === 'live' ? {} : { unanswerable: 'Provider process is gone. Interrupt or restart the run to respond.' }),
  };
}

function rank(decision: string): number {
  const index = T3_ORDER.indexOf(decision);
  return index === -1 ? T3_ORDER.length - 1.5 : index;
}

export interface KeyLike {
  key: string;
  repeat: boolean;
  defaultPrevented: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  isComposing?: boolean;
  keyCode?: number;
  target: unknown;
}

/** True for Enter and Escape, the two keys that can answer a card. */
export const isAnswerKey = (key: string): boolean => key === 'Enter' || key === 'Escape' || key === 'Esc';

/** Open popovers, menus and dialogs: while one is open it may cover a card, so no key answers one. */
export const COVERING = '.popover, [role="dialog"], [role="menu"]';

/**
 * Which answer a key gives the keyed card, if any: Enter the primary answer, Escape Decline. Only with no modifier, not
 * held down, not mid-composition, never while something `covered` the panel (`COVERING`), and never while the owner
 * types in a field or works a menu or dialog. Enter on a button or link is that control's own. Escape declines only from
 * the panel's body or from inside the card itself.
 */
export function approvalKey(event: KeyLike, card?: { contains: (node: never) => boolean } | null, covered = false): 'primary' | 'decline' | undefined {
  if (covered) return undefined;
  if (event.defaultPrevented || event.repeat || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return undefined;
  if (event.isComposing === true || event.keyCode === 229) return undefined;
  const answer = event.key === 'Enter' ? 'primary' : event.key === 'Escape' || event.key === 'Esc' ? 'decline' : undefined;
  if (answer === undefined) return undefined;
  const target = event.target as { closest?: (selector: string) => unknown; tagName?: string } | null;
  if (target === null || typeof target !== 'object' || typeof target.closest !== 'function') return answer;
  if (target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="dialog"], [role="menu"], [role="listbox"]') !== null) return undefined;
  if (answer === 'primary') return target.closest('button, a[href], summary, [role="button"], [role="menuitem"]') === null ? answer : undefined;
  const onBody = target.tagName === 'BODY' || target.tagName === 'HTML';
  return onBody || card?.contains(target as never) === true ? answer : undefined;
}

/**
 * Brings the locks up to date for one screen's cards, all in one list in key order (browser prompts, then the thread's T3
 * approval), so one card leaving shifts the others whichever kind they are. A card is locked for `BUTTON_DELAY_MS` when
 * it appears, every card when one above another appeared or went away, and a card whenever it becomes the keyed one.
 * `locks` maps a card's id to the time its lock ends; `before` is what the last call saw.
 */
export function updateLocks(locks: Map<string, number>, before: { order: readonly string[]; keyed: string | undefined }, order: readonly string[], keyed: string | undefined, now: number): void {
  const until = now + BUTTON_DELAY_MS;
  if (order.join('\n') !== before.order.join('\n')) {
    const shifted = rowsShifted(before.order, order);
    const seen = new Set(before.order);
    for (const id of order) if (shifted || !seen.has(id)) locks.set(id, until);
    for (const id of locks.keys()) if (!order.includes(id)) locks.delete(id);
  }
  if (keyed !== undefined && keyed !== before.keyed) locks.set(keyed, Math.max(locks.get(keyed) ?? 0, until));
}

/**
 * Locks every card for `BUTTON_DELAY_MS`, as when the panel is shown again after it was hidden: the owner has not seen
 * what the cards hold now.
 */
export function lockAll(locks: Map<string, number>, order: readonly string[], now: number): void {
  for (const id of order) locks.set(id, Math.max(locks.get(id) ?? 0, now + BUTTON_DELAY_MS));
}

/**
 * The card Enter and Escape answer: the first in key order that is fully on screen. None when no card is. Only browser
 * prompts take keys; a T3 approval, as in T3's own client, is answered by click.
 */
export function keyedCard(order: readonly string[], visible: ReadonlySet<string>): string | undefined {
  return order.find((id) => visible.has(id));
}

/**
 * Lets a key answer only a press that began after the card became keyed. An Enter or Escape still held from before the
 * change (the press that answered the card before it, say) answers nothing until it is released.
 */
export class KeyGate {
  private readonly held = new Set<string>();
  private armed = true;

  /** The keyed card changed. */
  changed(): void {
    this.armed = ![...this.held].some(isAnswerKey);
  }

  /** A key went down. True when this press may answer the keyed card. */
  down(key: string): boolean {
    const may = this.armed;
    this.held.add(key);
    return may;
  }

  up(key: string): void {
    this.held.delete(key);
    if (![...this.held].some(isAnswerKey)) this.armed = true;
  }

  /** The panel lost focus, so the key-ups it missed cannot be waited for. */
  reset(): void {
    this.held.clear();
    this.armed = true;
  }
}
