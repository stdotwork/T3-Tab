import { describe, expect, it } from 'vitest';

import { approvalKey, promptApproval, t3Approval, type ApprovalModel } from '../entrypoints/sidepanel/approval-model';
import { t3ThreadView } from '../entrypoints/sidepanel/lib/thread-model';
import type { PermissionPrompt } from '../src/permissions';

const session = { id: 's', name: 'claude-code · 1234' };
const prompt = (tool: PermissionPrompt['tool'], extra: { tab?: PermissionPrompt['tab'] | null; url?: string } = {}): PermissionPrompt => {
  const tab = extra.tab === undefined ? { id: 7, title: 'Cable Shop – USB-C cables' } : extra.tab;
  return { id: `p-${tool}`, origin: 'http://127.0.0.1:41889', tool, session, ...(tab === null ? {} : { tab }), ...(extra.url === undefined ? {} : { url: extra.url }) };
};
/** The answers in the order a card draws them: Decline, the primary one, then each under More. */
const answers = (model: ApprovalModel): string[] => [model.decline.decision, model.primary.decision, ...model.more.map((action) => action.decision)];

describe('one approval card for both kinds of ask', () => {
  it('draws a browser prompt and a T3 approval with the same parts in T3 order', () => {
    const browser = promptApproval(prompt('act'), 'Claude Code');
    const t3 = t3Approval({
      requestId: 'r1',
      kind: 'command',
      title: 'npm run build',
      detail: 'in /home/dev/shop-site',
      options: [
        { decision: 'accept', label: 'Approve' },
        { decision: 'acceptForSession', label: 'Always allow this session' },
        { decision: 'decline', label: 'Decline' },
        { decision: 'cancel', label: 'Cancel' },
      ],
    });
    expect(Object.keys(browser).sort()).toEqual(Object.keys(t3).sort());
    expect(answers(browser)).toEqual(['decline', 'allow-once', 'always-allow']);
    // T3's own order: Decline and Approve on the row, Cancel and the lasting answer under More.
    expect(answers(t3)).toEqual(['decline', 'accept', 'cancel', 'acceptForSession']);
    expect(t3.ask).toEqual({ verb: 'Run', subject: 'npm run build', mono: true });
    expect(t3.where).toEqual({ text: 'in /home/dev/shop-site', mono: false });
  });

  it('says who asks, what and on which site, then the tab', () => {
    const model = promptApproval(prompt('run_js'), 'Claude Code');
    expect(model.ask).toEqual({ who: 'Claude Code', verb: 'wants to run JavaScript on', subject: '127.0.0.1:41889', mono: true });
    expect(model.where).toEqual({ text: '"Cable Shop – USB-C cables"', mono: false });
  });

  it('names the address for a page not opened yet', () => {
    const model = promptApproval(prompt('open', { tab: null, url: 'http://127.0.0.1:41889/cart?id=1' }), 'Codex');
    expect(model.where).toEqual({ text: 'http://127.0.0.1:41889/cart?id=1', mono: true });
  });

  it('keeps each answer saying what it grants, the lasting one under More', () => {
    const read = promptApproval(prompt('read'), 'Claude Code');
    expect(read.primary.label).toBe('Allow reading once');
    expect(read.more).toEqual([{ decision: 'always-allow-read', label: 'Always allow reading on this site', detail: 'Opening, acting and JavaScript still ask' }]);
    const act = promptApproval(prompt('act'), 'Claude Code');
    expect(act.primary.label).toBe('Allow acting once');
    expect(act.more).toEqual([{ decision: 'always-allow', label: 'Always allow everything on this site', detail: 'Reading, opening, acting and JavaScript' }]);
    expect(act.decline.label).toBe('Decline');
  });

  it('strips control characters a page or an agent put in a title', () => {
    const model = promptApproval(prompt('act', { tab: { id: 7, title: 'Shop\u0007\u001b[2J' } }), 'Claude\u0000 Code');
    expect(model.where?.text).toBe('"Shop[2J"');
    expect(model.ask.who).toBe('Claude Code');
  });

  it('gives a T3 approval without options T3\'s two answers', () => {
    const view = t3ThreadView({
      thread: { id: 't', title: 'Thread' },
      runs: [],
      runtimeRequests: [{ id: 'r9', kind: 'approval', status: 'pending' }],
      visibleTurnItems: [{ item: { id: 'item-9', type: 'approval_request', status: 'waiting', requestId: 'r9', requestKind: 'file-read', prompt: '/etc/hosts' } }],
    } as never);
    expect(view.approval).toMatchObject({ requestId: 'r9', entryId: 'item-9' });
    const model = t3Approval(view.approval!);
    expect(answers(model)).toEqual(['decline', 'accept']);
    expect(model.ask).toEqual({ verb: 'Read', subject: '/etc/hosts', mono: true });
  });
});

describe('the keys that answer a card', () => {
  const field = { closest: (selector: string) => (selector.includes('textarea') ? {} : null) };
  const button = { closest: (selector: string) => (selector.startsWith('button') ? {} : null) };
  const body = { closest: () => null };
  const key = (name: string, extra: Record<string, unknown> = {}) => ({ key: name, repeat: false, defaultPrevented: false, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, target: body, ...extra });

  it('answers Enter with the primary answer and Escape with Decline', () => {
    expect(approvalKey(key('Enter'))).toBe('primary');
    expect(approvalKey(key('Escape'))).toBe('decline');
    expect(approvalKey(key('a'))).toBeUndefined();
  });

  it('leaves keys typed in a field, held down, with a modifier or already handled', () => {
    expect(approvalKey(key('Enter', { target: field }))).toBeUndefined();
    expect(approvalKey(key('Escape', { target: field }))).toBeUndefined();
    expect(approvalKey(key('Enter', { repeat: true }))).toBeUndefined();
    for (const modifier of ['metaKey', 'ctrlKey', 'altKey', 'shiftKey']) expect(approvalKey(key('Enter', { [modifier]: true }))).toBeUndefined();
    expect(approvalKey(key('Escape', { defaultPrevented: true }))).toBeUndefined();
  });

  it('leaves Enter on a button to that button, but still declines on Escape', () => {
    expect(approvalKey(key('Enter', { target: button }))).toBeUndefined();
    expect(approvalKey(key('Escape', { target: button }))).toBe('decline');
  });
});
