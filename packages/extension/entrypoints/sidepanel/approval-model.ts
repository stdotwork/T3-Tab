/*
 * What one approval card shows, for both kinds of ask: a browser permission prompt from any MCP session, and a T3
 * thread's own approval (a command, a file read or change, a permission). Both take T3 Code's approval anatomy
 * (`ComposerPendingApprovalActions` in T3's web app): Decline and the primary answer on the row, every other answer
 * under More. A browser prompt's lasting choice is one of those others, so it is kept but never the dominant button.
 */
import type { PermissionDecision, PermissionPrompt } from '../../src/permissions';
import type { PendingApproval } from './lib/thread-model';
import { promptChoices } from './prompt-choices';

export interface ApprovalAction<D extends string = string> {
  decision: D;
  /** Says exactly what the answer grants. */
  label: string;
  /** The rest of what a lasting choice means, under its label. */
  detail?: string;
}

export interface ApprovalModel<D extends string = string> {
  /** The one line saying what is asked. `subject` is the part set in mono: a site, a command or a path. */
  ask: { who?: string; verb: string; subject: string; mono: boolean };
  /** Where, under it: the tab's title, the address an open would load, or T3's reason. */
  where?: { text: string; mono: boolean };
  decline: ApprovalAction<D>;
  primary: ApprovalAction<D>;
  /** Everything else, in T3's order, behind More. */
  more: ApprovalAction<D>[];
}

const plain = (text: string): string => [...text].filter((character) => (character.codePointAt(0) ?? 0) >= 32).join('');

const VERB: Record<PermissionPrompt['tool'], string> = {
  read: 'wants to read',
  open: 'wants to open',
  act: 'wants to act on',
  run_js: 'wants to run JavaScript on',
};

const hostOf = (origin: string): string => {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
};

/** A browser permission prompt: who asks, the verb and the site; then the tab's title or the address it would open. */
export function promptApproval(prompt: PermissionPrompt, asker: string): ApprovalModel<PermissionDecision> {
  const choices = promptChoices(prompt.tool);
  const pick = (test: (decision: PermissionDecision) => boolean): ApprovalAction<PermissionDecision> => {
    const found = choices.find((choice) => test(choice.decision));
    if (found === undefined) throw new Error(`No ${prompt.tool} prompt choice`);
    return { decision: found.decision, label: found.label, ...(found.detail === undefined ? {} : { detail: found.detail }) };
  };
  const address = prompt.url === undefined ? undefined : plain(prompt.url);
  const title = prompt.tab === undefined || (address !== undefined && prompt.tab.title === '') ? undefined : `"${plain(prompt.tab.title || '(untitled)')}"`;
  const where = address !== undefined ? { text: address, mono: true } : title !== undefined ? { text: title, mono: false } : undefined;
  return {
    ask: { who: plain(asker), verb: VERB[prompt.tool], subject: hostOf(prompt.origin), mono: true },
    ...(where === undefined ? {} : { where }),
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

/** A T3 thread's approval: the command or path asked about, T3's reason under it, and T3's own answers. */
export function t3Approval(approval: PendingApproval): ApprovalModel {
  const kind = T3_VERB[approval.kind] ?? { verb: 'Allow', mono: false };
  const options = [...approval.options].sort((a, b) => rank(a.decision) - rank(b.decision));
  const decline = options.find((option) => option.decision === 'decline') ?? { decision: 'decline', label: 'Decline' };
  const primary = options.find((option) => option.decision === 'accept') ?? { decision: 'accept', label: 'Approve' };
  return {
    ask: { verb: kind.verb, subject: approval.title, mono: kind.mono },
    ...(approval.detail === undefined || approval.detail === '' ? {} : { where: { text: approval.detail, mono: false } }),
    decline: { decision: decline.decision, label: decline.label },
    primary: { decision: primary.decision, label: primary.label },
    more: options.filter((option) => option.decision !== 'decline' && option.decision !== 'accept').map((option) => ({ decision: option.decision, label: option.label })),
  };
}

function rank(decision: string): number {
  const index = T3_ORDER.indexOf(decision);
  return index === -1 ? T3_ORDER.length - 1.5 : index;
}

/**
 * Which key answers a card, if any: Enter gives the primary answer and Escape declines, only with no modifier, not held
 * down, and never while the owner is typing or working a menu or dialog. A key on a button is that button's own.
 */
export function approvalKey(event: { key: string; repeat: boolean; defaultPrevented: boolean; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; target: unknown }): 'primary' | 'decline' | undefined {
  if (event.defaultPrevented || event.repeat || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return undefined;
  const answer = event.key === 'Enter' ? 'primary' : event.key === 'Escape' || event.key === 'Esc' ? 'decline' : undefined;
  if (answer === undefined) return undefined;
  const target = event.target as { closest?: (selector: string) => unknown } | null;
  if (target !== null && typeof target === 'object' && typeof target.closest === 'function') {
    if (target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="dialog"], [role="menu"], [role="listbox"]') !== null) return undefined;
    if (answer === 'primary' && target.closest('button, a[href], summary, [role="button"], [role="menuitem"]') !== null) return undefined;
  }
  return answer;
}
