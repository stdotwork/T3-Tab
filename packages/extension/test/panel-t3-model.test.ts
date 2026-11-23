import { claimNote } from '@t3-tab/protocol';
import { describe, expect, it } from 'vitest';

import { applyShellItem, type Project, type ThreadShell } from '../entrypoints/sidepanel/lib/t3-client';
import { hideClaimCodes, t3ThreadView, type T3Projection } from '../entrypoints/sidepanel/lib/thread-model';

const CODE = 'NUhUfhsGPq9V7alu2aaVkRno';
const project = (id: string, title = id): Project => ({ id, title, workspaceRoot: `/${id}` });
const thread = (id: string): ThreadShell => ({ id, projectId: 'p', title: id });

describe('T3 shell stream', () => {
  it('keeps the thread list when T3 refreshes projects with an empty-thread snapshot', () => {
    const state = { threads: [thread('a'), thread('b')], projects: [project('p'), project('q')] };
    const next = applyShellItem(state, {
      kind: 'snapshot',
      snapshot: { threads: [], projects: [project('p', 'renamed')] },
      resolvedRepositoryIdentityRoots: ['/p'],
    });
    expect(next.threads.map((entry) => entry.id)).toEqual(['a', 'b']);
    expect(next.projects.map((entry) => entry.title)).toEqual(['renamed', 'q']);
  });

  it('replaces both lists on a full snapshot', () => {
    const next = applyShellItem({ threads: [thread('a')], projects: [project('p')] }, { kind: 'snapshot', snapshot: { threads: [thread('c')], projects: [] } });
    expect(next.threads.map((entry) => entry.id)).toEqual(['c']);
    expect(next.projects).toEqual([]);
  });
});

describe('claim codes in a thread', () => {
  const view = (items: T3Projection['visibleTurnItems']) =>
    t3ThreadView({ thread: { id: 't', title: 'Thread' }, runs: [], runtimeRequests: [], visibleTurnItems: items });

  it('hides a code in tool arguments', () => {
    expect(hideClaimCodes(`mcp__t3-tab__tabs: {"claim":"${CODE}"}`)).not.toContain(CODE);
  });

  it('hides the note and a bare repeat of its code everywhere', () => {
    const shown = view([
      { item: { id: '1', type: 'user_message', text: `Read it${claimNote(CODE)}` } },
      { item: { id: '2', type: 'reasoning', text: `I will claim with ${CODE} first` } },
      { item: { id: '3', type: 'dynamic_tool', toolName: 'mcp__t3-tab__tabs', output: `used ${CODE}` } },
      { item: { id: '4', type: 'assistant_message', text: `Done with ${CODE}` } },
    ]);
    expect(JSON.stringify(shown)).not.toContain(CODE);
    expect(shown.rows[0]).toMatchObject({ kind: 'user', text: 'Read it' });
  });
});

describe('approval requests in a thread', () => {
  const view = (items: T3Projection['visibleTurnItems']) =>
    t3ThreadView({ thread: { id: 't', title: 'Thread' }, runs: [], runtimeRequests: [], visibleTurnItems: items });
  const approval = (id: string, status: string) => ({ item: { id, type: 'approval_request', status, requestId: id, prompt: 'Allow the tool?' } });
  const rowEntries = (shown: ReturnType<typeof view>) => shown.rows.flatMap((row) => (row.kind === 'work' ? row.entries : []));

  it('adds no row for an answered approval', () => {
    const shown = view([approval('a1', 'completed')]);
    expect(shown.rows).toEqual([]);
  });

  it('adds a row for one that is still waiting', () => {
    const shown = view([approval('a2', 'waiting')]);
    expect(rowEntries(shown)).toMatchObject([{ id: 'a2', icon: 'approval', status: 'waiting' }]);
  });

  it('keeps the waiting one and drops the answered one when both are in the thread', () => {
    const shown = view([approval('old', 'completed'), approval('new', 'waiting')]);
    expect(rowEntries(shown).map((entry) => entry.id)).toEqual(['new']);
  });
});
