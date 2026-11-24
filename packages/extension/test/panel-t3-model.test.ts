import { claimNote } from '@t3-tab/protocol';
import { describe, expect, it } from 'vitest';

import { applyShellItem, type Project, type ThreadShell } from '../entrypoints/sidepanel/lib/t3-client';
import { browserStepLabel, directThreadView, hideClaimCodes, t3ThreadView, type T3Projection } from '../entrypoints/sidepanel/lib/thread-model';

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

describe('what a thread shows', () => {
  const base = (extra: Partial<T3Projection>): T3Projection => ({ thread: { id: 't', title: 'T' }, runs: [], runtimeRequests: [], visibleTurnItems: [], ...extra });

  it("shows why a turn failed, from T3's failure", () => {
    const view = t3ThreadView(
      base({
        runs: [{ id: 'r', status: 'failed', ordinal: 1 }],
        visibleTurnItems: [
          { item: { id: 'u', type: 'user_message', text: 'hi', runId: 'r' } },
          { item: { id: 'e', type: 'error', status: 'failed', runId: 'r', title: 'Provider error', failure: { class: 'provider_error', message: 'Model overloaded' } } },
        ],
      }),
    );
    expect(view.rows.filter((row) => row.kind === 'notice').map((row) => (row as { text: string }).text)).toEqual(['Model overloaded']);
  });

  it('says a turn failed when T3 gave no reason, and only for the latest turn', () => {
    const failed = t3ThreadView(base({ runs: [{ id: 'r', status: 'failed', ordinal: 1 }], visibleTurnItems: [{ item: { id: 'u', type: 'user_message', text: 'hi', runId: 'r' } }] }));
    expect(failed.rows.at(-1)).toMatchObject({ kind: 'notice', tone: 'error' });
    const recovered = t3ThreadView(base({ runs: [{ id: 'r', status: 'failed', ordinal: 1 }, { id: 's', status: 'completed', ordinal: 2 }] }));
    expect(recovered.rows).toEqual([]);
  });

  it('lists queued follow-ups in order, out of the timeline', () => {
    const view = t3ThreadView(
      base({
        runs: [
          { id: 'a', status: 'running', ordinal: 1 },
          { id: 'c', status: 'queued', ordinal: 3, queuePosition: 2, userMessageId: 'm3' },
          { id: 'b', status: 'queued', ordinal: 2, queuePosition: 1, userMessageId: 'm2', queueHeld: true },
        ],
        messages: [{ id: 'm2', text: 'second' }, { id: 'm3', text: 'third' }],
        visibleTurnItems: [{ item: { id: 'q', type: 'user_message', text: 'second', runId: 'b' } }],
      }),
    );
    expect(view.queued).toEqual([{ runId: 'b', text: 'second', held: true }, { runId: 'c', text: 'third', held: false }]);
    expect(view.rows.some((row) => row.kind === 'user')).toBe(false);
  });

  it('names the site and the action of a browser step, and never what was typed', () => {
    expect(browserStepLabel('read', {}, 'tab 5: Bakery — https://bakery.example/menu\nbutton')).toBe('Read bakery.example');
    expect(browserStepLabel('read', { find: 'price' }, 'tab 5: Bakery — https://bakery.example/')).toBe('Searched bakery.example for "price"');
    expect(browserStepLabel('tabs', { action: 'open', url: 'https://a.example/x' })).toBe('Opened a.example');
    expect(browserStepLabel('tabs', { claim: 'secret-code' })).toBe('Took the shared tabs');
    const act = browserStepLabel('act', { steps: [{ action: 'fill', ref: 'e1', text: 'hunter2' }, { action: 'press', key: 'Enter' }] }, 'tab 5: Login — https://site.example/');
    expect(act).toBe('Filled a field, pressed Enter on site.example');
    expect(act).not.toContain('hunter2');
  });

  it('shows a direct run that failed without an error item, and message times', () => {
    const view = directThreadView({
      id: 'c',
      via: 'claude',
      title: 'T',
      status: 'failed',
      error: 'The agent exited.',
      messages: [],
      items: [{ id: 'u', kind: 'user', text: 'hi', at: 1_000 }],
      updatedAt: 2_000,
    });
    expect(view.rows[0]).toMatchObject({ kind: 'user', at: 1_000 });
    expect(view.rows.at(-1)).toMatchObject({ kind: 'notice', tone: 'error', text: 'The agent exited.' });
    expect(view.queued).toEqual([]);
  });
});
