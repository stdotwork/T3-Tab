import { describe, expect, it } from 'vitest';

import { approvalKey, BUTTON_DELAY_MS, KeyGate, keyedCard, lockAll, promptApproval, t3Approval, updateLocks, type ApprovalModel } from '../entrypoints/sidepanel/approval-model';
import { t3ThreadView, type PendingApproval } from '../entrypoints/sidepanel/lib/thread-model';
import type { PermissionPrompt } from '../src/permissions';

const session = { id: 's', name: 'claude-code · 1234' };
const prompt = (tool: PermissionPrompt['tool'], extra: { tab?: PermissionPrompt['tab'] | null; url?: string } = {}): PermissionPrompt => {
  const tab = extra.tab === undefined ? { id: 7, title: 'Cable Shop – USB-C cables' } : extra.tab;
  return { id: `p-${tool}`, origin: 'http://127.0.0.1:41889', tool, session, ...(tab === null ? {} : { tab }), ...(extra.url === undefined ? {} : { url: extra.url }) };
};
/** The answers in the order a card draws them: Decline, the primary one, then each under More. */
const answers = (model: ApprovalModel): string[] => [model.decline?.decision, model.primary?.decision, ...model.more.map((action) => action.decision)].filter((decision): decision is string => decision !== undefined);
const t3 = (options: PendingApproval['options'], extra: Partial<PendingApproval> = {}): PendingApproval => ({ requestId: 'r1', responseCapability: 'live', kind: 'command', title: 'npm run build', options, ...extra });

describe('one approval card for both kinds of ask', () => {
  it('draws a browser prompt and a T3 approval with the same parts in T3 order', () => {
    const browser = promptApproval(prompt('act'), 'Claude Code');
    const command = t3Approval(
      t3(
        [
          { decision: 'accept', label: 'Approve' },
          { decision: 'acceptForSession', label: 'Always allow this session' },
          { decision: 'decline', label: 'Decline' },
          { decision: 'cancel', label: 'Cancel' },
        ],
        { detail: 'in /home/dev/shop-site' },
      ),
    );
    expect(answers(browser)).toEqual(['decline', 'allow-once', 'always-allow']);
    // T3's own order: Decline and Approve on the row, Cancel and the lasting answer under More.
    expect(answers(command)).toEqual(['decline', 'accept', 'cancel', 'acceptForSession']);
    expect(command.ask).toEqual({ verb: 'Run', subject: 'npm run build', mono: true });
    expect(command.detail).toEqual({ text: 'in /home/dev/shop-site', mono: false });
  });

  it('says who asks, what and on which site, then the tab', () => {
    const model = promptApproval(prompt('run_js'), 'Claude Code');
    expect(model.ask).toEqual({ who: 'Claude Code', verb: 'wants to run JavaScript on', subject: '127.0.0.1:41889', mono: true });
    expect(model.tab).toBe('"Cable Shop – USB-C cables"');
    expect(model.detail).toBeUndefined();
  });

  it('names the address for a page not opened yet', () => {
    const model = promptApproval(prompt('open', { tab: null, url: 'http://127.0.0.1:41889/cart?id=1' }), 'Codex');
    expect(model.detail).toEqual({ text: 'http://127.0.0.1:41889/cart?id=1', mono: true });
    expect(model.tab).toBeUndefined();
  });

  it('names both the address and the tab for a goto, back, forward or reload', () => {
    const model = promptApproval(prompt('open', { tab: { id: 9, title: 'Checkout' }, url: 'https://shop.test/cart' }), 'Codex');
    expect(model.detail).toEqual({ text: 'https://shop.test/cart', mono: true });
    expect(model.tab).toBe('in "Checkout"');
    expect(promptApproval(prompt('open', { tab: { id: 9, title: '' }, url: 'https://shop.test/' }), 'Codex').tab).toBe('in "(untitled)"');
  });

  it('keeps each answer saying what it grants, the lasting one under More', () => {
    const read = promptApproval(prompt('read'), 'Claude Code');
    expect(read.primary?.label).toBe('Allow reading once');
    expect(read.more).toEqual([{ decision: 'always-allow-read', label: 'Always allow reading on this site', detail: 'Opening, acting and JavaScript still ask' }]);
    const act = promptApproval(prompt('act'), 'Claude Code');
    expect(act.primary?.label).toBe('Allow acting once');
    expect(act.more).toEqual([{ decision: 'always-allow', label: 'Always allow everything on this site', detail: 'Reading, opening, acting and JavaScript' }]);
    expect(act.decline?.label).toBe('Decline');
  });

  it('strips control characters a page or an agent put in a title', () => {
    const model = promptApproval(prompt('act', { tab: { id: 7, title: 'Shop\u0007\u001b[2J' } }), 'Claude\u0000 Code');
    expect(model.tab).toBe('"Shop[2J"');
    expect(model.ask.who).toBe('Claude Code');
  });
});

describe('a T3 approval draws only the answers T3 offers', () => {
  it('has no primary answer when T3 offers no accept, and no Decline when it offers no decline', () => {
    const model = t3Approval(t3([{ decision: 'acceptForSession', label: 'Always allow this session' }, { decision: 'cancel', label: 'Cancel' }]));
    expect(model.primary).toBeUndefined();
    expect(model.decline).toBeUndefined();
    expect(answers(model)).toEqual(['cancel', 'acceptForSession']);
  });

  it('carries T3\'s warning on an answer', () => {
    const model = t3Approval(t3([{ decision: 'accept', label: 'Approve', warning: 'Runs outside the sandbox' }, { decision: 'decline', label: 'Decline' }]));
    expect(model.primary).toEqual({ decision: 'accept', label: 'Approve', warning: 'Runs outside the sandbox' });
    expect(model.decline).toEqual({ decision: 'decline', label: 'Decline' });
  });

  it('offers no answer unless T3 says the provider can still take one, in T3\'s words', () => {
    expect(t3Approval(t3([{ decision: 'accept', label: 'Approve' }])).unanswerable).toBeUndefined();
    const gone = t3Approval(t3([{ decision: 'accept', label: 'Approve' }], { responseCapability: 'not_resumable' }));
    expect(gone.unanswerable).toBe('Provider process is gone. Interrupt or restart the run to respond.');
    const view = (capability?: { type: string }) =>
      t3ThreadView({
        thread: { id: 't', title: 'Thread' },
        runs: [],
        runtimeRequests: [{ id: 'r8', kind: 'approval', status: 'pending', ...(capability === undefined ? {} : { responseCapability: capability }) }],
        visibleTurnItems: [{ item: { id: 'item-8', type: 'approval_request', status: 'waiting', requestId: 'r8', requestKind: 'command', prompt: 'ls' } }],
      } as never).approval?.responseCapability;
    expect(view({ type: 'live' })).toBe('live');
    expect(view({ type: 'message' })).toBe('not_resumable');
    expect(view()).toBe('not_resumable');
  });

  it('gives an approval without options T3\'s own default answers', () => {
    const view = t3ThreadView({
      thread: { id: 't', title: 'Thread' },
      runs: [],
      runtimeRequests: [{ id: 'r9', kind: 'approval', status: 'pending', responseCapability: { type: 'live' } }],
      visibleTurnItems: [{ item: { id: 'item-9', type: 'approval_request', status: 'waiting', requestId: 'r9', requestKind: 'file-read', prompt: '/etc/hosts' } }],
    } as never);
    expect(view.approval).toMatchObject({ requestId: 'r9', entryId: 'item-9' });
    const model = t3Approval(view.approval!);
    expect(answers(model)).toEqual(['decline', 'accept', 'cancel', 'acceptForSession']);
    expect(model.ask).toEqual({ verb: 'Read', subject: '/etc/hosts', mono: true });
  });
});

describe('locks shared by every card of a screen', () => {
  const step = (locks: Map<string, number>, before: { order: string[]; keyed: string | undefined }, order: string[], keyed: string | undefined, now: number) => {
    updateLocks(locks, before, order, keyed, now);
    return { order, keyed };
  };
  const lockedAt = (locks: Map<string, number>, id: string, now: number): boolean => (locks.get(id) ?? 0) > now;

  it('locks a T3 approval when the browser prompt above it is answered and goes', () => {
    const locks = new Map<string, number>();
    let seen = step(locks, { order: [], keyed: undefined }, ['prompt:a', 't3:r1'], 'prompt:a', 0);
    expect(lockedAt(locks, 't3:r1', 1_000)).toBe(false);
    seen = step(locks, seen, ['t3:r1'], 't3:r1', 1_000);
    expect(lockedAt(locks, 't3:r1', 1_000 + BUTTON_DELAY_MS - 1)).toBe(true);
    expect(lockedAt(locks, 't3:r1', 1_000 + BUTTON_DELAY_MS)).toBe(false);
    expect(locks.has('prompt:a')).toBe(false);
  });

  it('locks a card whenever it becomes the keyed card, even when the list did not change', () => {
    const locks = new Map<string, number>();
    let seen = step(locks, { order: [], keyed: undefined }, ['prompt:a', 'prompt:b'], 'prompt:a', 0);
    seen = step(locks, seen, ['prompt:a', 'prompt:b'], 'prompt:b', 5_000);
    expect(lockedAt(locks, 'prompt:b', 5_000 + BUTTON_DELAY_MS - 1)).toBe(true);
    expect(lockedAt(locks, 'prompt:a', 5_000)).toBe(false);
    step(locks, seen, ['prompt:a', 'prompt:b'], undefined, 9_000);
    expect(lockedAt(locks, 'prompt:b', 9_000)).toBe(false);
  });

  it('locks every card when the panel is shown again', () => {
    const locks = new Map<string, number>([['prompt:a', 0]]);
    lockAll(locks, ['prompt:a', 't3:r1'], 2_000);
    expect(lockedAt(locks, 'prompt:a', 2_000 + BUTTON_DELAY_MS - 1)).toBe(true);
    expect(lockedAt(locks, 't3:r1', 2_000 + BUTTON_DELAY_MS - 1)).toBe(true);
    expect(lockedAt(locks, 't3:r1', 2_000 + BUTTON_DELAY_MS)).toBe(false);
  });

  it('keys the first card fully on screen, and none when none is', () => {
    expect(keyedCard(['prompt:a', 'prompt:b', 't3:r1'], new Set(['prompt:b', 't3:r1']))).toBe('prompt:b');
    expect(keyedCard(['prompt:a'], new Set())).toBeUndefined();
  });
});

describe('a key answers only a fresh press', () => {
  it('ignores an Enter held through the change of keyed card until it is released', () => {
    const gate = new KeyGate();
    expect(gate.down('Enter')).toBe(true);
    gate.changed();
    expect(gate.down('Enter')).toBe(false);
    gate.up('Enter');
    expect(gate.down('Enter')).toBe(true);
  });

  it('takes the first press on a new card when no key was held', () => {
    const gate = new KeyGate();
    expect(gate.down('Enter')).toBe(true);
    gate.up('Enter');
    gate.changed();
    expect(gate.down('Enter')).toBe(true);
  });

  it('does not wait on keys that cannot answer, and forgets held keys when the panel loses focus', () => {
    const gate = new KeyGate();
    gate.down('a');
    gate.changed();
    expect(gate.down('Enter')).toBe(true);
    gate.changed();
    gate.reset();
    expect(gate.down('Escape')).toBe(true);
  });
});

describe('the keys that answer a card', () => {
  const element = (tag: string, matches: (selector: string) => boolean = () => false) => ({ tagName: tag, closest: (selector: string) => (matches(selector) ? {} : null) });
  const field = element('TEXTAREA', (selector) => selector.includes('textarea'));
  const button = element('BUTTON', (selector) => selector.startsWith('button'));
  const body = element('BODY');
  const inCard = element('DIV');
  const card = { contains: (node: never) => node === (inCard as never) || node === (button as never) };
  const key = (name: string, extra: Record<string, unknown> = {}) => ({ key: name, repeat: false, defaultPrevented: false, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, target: body, ...extra });

  it('answers Enter with the primary answer and Escape with Decline', () => {
    expect(approvalKey(key('Enter'), card)).toBe('primary');
    expect(approvalKey(key('Escape'), card)).toBe('decline');
    expect(approvalKey(key('a'), card)).toBeUndefined();
  });

  it('leaves keys typed in a field, held down, with a modifier, mid-composition or already handled', () => {
    expect(approvalKey(key('Enter', { target: field }), card)).toBeUndefined();
    expect(approvalKey(key('Escape', { target: field }), card)).toBeUndefined();
    expect(approvalKey(key('Enter', { repeat: true }), card)).toBeUndefined();
    for (const modifier of ['metaKey', 'ctrlKey', 'altKey', 'shiftKey']) expect(approvalKey(key('Enter', { [modifier]: true }), card)).toBeUndefined();
    expect(approvalKey(key('Escape', { defaultPrevented: true }), card)).toBeUndefined();
    expect(approvalKey(key('Enter', { isComposing: true }), card)).toBeUndefined();
    expect(approvalKey(key('Enter', { keyCode: 229 }), card)).toBeUndefined();
  });

  it('takes no key while a popover, menu or dialog is open over the panel', () => {
    expect(approvalKey(key('Enter'), card, true)).toBeUndefined();
    expect(approvalKey(key('Escape'), card, true)).toBeUndefined();
  });

  it('leaves Enter on a button to that button', () => {
    expect(approvalKey(key('Enter', { target: button }), card)).toBeUndefined();
  });

  it('declines on Escape only from the panel body or inside the card, never from another control', () => {
    expect(approvalKey(key('Escape', { target: inCard }), card)).toBe('decline');
    expect(approvalKey(key('Escape', { target: button }), card)).toBe('decline');
    const elsewhere = element('BUTTON', (selector) => selector.startsWith('button'));
    expect(approvalKey(key('Escape', { target: elsewhere }), card)).toBeUndefined();
    expect(approvalKey(key('Escape', { target: elsewhere }), null)).toBeUndefined();
  });
});
