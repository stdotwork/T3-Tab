import { claimNote } from '@t3-tab/protocol';
import { describe, expect, it } from 'vitest';

import { applyShellItem, type Project, type ThreadShell } from '../entrypoints/sidepanel/lib/t3-client';
import { browserStepLabel, directThreadView, hideClaimCodes, omittedBrowserReplies, RefNames, t3ThreadView, toolOutputText, type T3Projection } from '../entrypoints/sidepanel/lib/thread-model';

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
    expect(browserStepLabel('tabs', { claim: 'secret-code' })).toBe('Got access to the shared tabs');
    const act = browserStepLabel('act', { steps: [{ action: 'fill', ref: 'e1', text: 'hunter2' }, { action: 'press', key: 'Enter' }] }, 'tab 5: Login — https://site.example/');
    expect(act).toBe('Filled a field, pressed Enter on site.example');
    expect(act).not.toContain('hunter2');
  });

  it('names the element a step acted on from what an earlier reply printed, and never what was typed', () => {
    const refs = new RefNames();
    refs.learn(
      [
        'tab 5: Login — https://site.example/',
        'e1 form "Login"',
        '  e2 textbox "Email" value="ada@example.com"',
        '  e3 textbox "Password" value=<redacted>',
        '  e4 button "Sign in"',
        '"Forgot it? [Reset your password](e5) here"',
      ].join('\n'),
    );
    const fill = { steps: [{ action: 'fill', ref: 'e2', text: 'ada@example.com' }, { action: 'fill', ref: 'e3', text: 'hunter2' }, { action: 'click', ref: 'e4' }] };
    // Still running: no reply yet, so the tab is the one last replied about.
    const running = browserStepLabel('act', fill, undefined, refs);
    expect(running).toBe('Filled “Email” and “Password”, clicked “Sign in”');
    expect(running).not.toMatch(/hunter2|ada@/);
    expect(browserStepLabel('act', { steps: [{ action: 'click', ref: 'e5' }] }, 'tab 5\nNo changes since the last read.', refs)).toBe('Clicked “Reset your password”');
    // Another tab's e4 is another element; a key that is a character is typing, so it is not named.
    expect(browserStepLabel('act', { tab: 6, steps: [{ action: 'click', ref: 'e4' }] }, undefined, refs)).toBe('Clicked an element on the page');
    expect(browserStepLabel('act', { steps: [{ action: 'press', key: 'p' }, { action: 'press', key: 'Control+A' }] }, 'tab 5', refs)).toBe('Pressed a key, pressed Control+A on the page');
    // A diff's added line names an element; a removed one is gone.
    refs.learn('tab 5\nChanged since the last read:\n@@\n-  e4 button "Sign in"\n+  e4 button "Signing in…" [disabled]\n+  e9 alert "Welcome"\n-  e11 button "Gone"');
    expect(browserStepLabel('act', { steps: [{ action: 'click', ref: 'e11' }] }, undefined, refs)).toBe('Clicked an element on the page');
    expect(browserStepLabel('act', { steps: [{ action: 'hover', ref: 'e4' }, { action: 'scroll', ref: 'e9' }, { action: 'wait', ms: 500 }, { action: 'click', ref: 'e2' }] }, undefined, refs)).toBe(
      'Hovered over “Signing in…”, scrolled “Welcome” and more',
    );
  });

  it('learns each tab part of a reply under its own tab, and nothing from a failed step\'s error', () => {
    const refs = new RefNames();
    const reply = [
      'Step 2 (click) failed: e7 is no longer on the page; read again (document epoch 7 -> 8)',
      'tab 5: Account — https://site.example/account',
      'e14 button "Save"',
      'Opened tab 9: Help — https://help.example/',
      'e14 link "Contact us"',
      '1 more tab opened that this session does not hold.',
    ].join('\n');
    const act = { steps: [{ action: 'click', ref: 'e3' }, { action: 'click', ref: 'e7' }] };
    // The error comes first, yet the step is on tab 5's site.
    expect(browserStepLabel('act', act, reply, refs)).toBe('Clicked an element on site.example');
    refs.learn(reply, act);
    expect(refs.find('e14', '5')).toEqual({ role: 'button', name: 'Save' });
    expect(refs.find('e14', '9')).toEqual({ role: 'link', name: 'Contact us' });
    expect(refs.find('e7', '5')).toBeUndefined();
    expect(refs.currentTab).toBe('5');
    // A load's reply (`Loaded tab`, `Back in tab`, …) is a part about that tab too.
    refs.learn('Back in tab 9 [current]: FAQ — https://help.example/faq\ne2 link "Returns"');
    expect(refs.find('e2', '9')).toEqual({ role: 'link', name: 'Returns' });
  });

  it('forgets a tab\'s names when its page changes or is read whole, and keeps them for a part or a change list', () => {
    const refs = new RefNames();
    refs.learn('tab 5: Settings — https://site.example/settings\ne2 button "Save"\ne14 button "Delete account"');
    const clickE14 = { steps: [{ action: 'click', ref: 'e14' }] };
    expect(browserStepLabel('act', clickE14, undefined, refs)).toBe('Clicked “Delete account”');
    // A part of the page, a search and a change list add to what the tab's page showed.
    refs.learn('tab 5\ne30 button "Inner"', { ref: 'e29' });
    refs.learn('tab 5\ne31 link "Help"', { find: 'help' });
    refs.learn('tab 5\nChanged since the last read:\n@@\n+  e32 alert "Saved"');
    expect([refs.find('e14', '5')?.name, refs.find('e30', '5')?.name, refs.find('e31', '5')?.name, refs.find('e32', '5')?.name]).toEqual(['Delete account', 'Inner', 'Help', 'Saved']);
    // The click on e2 took the tab to a new page: its act reply shows it whole, with a head naming it, and e14 is not that
    // button any more.
    refs.learn('tab 5: Signed out — https://site.example/bye\ne1 link "Home"', { steps: [{ action: 'click', ref: 'e2' }] });
    expect(browserStepLabel('act', clickE14, undefined, refs)).toBe('Clicked an element on the page');
    // A whole read replaces too, even with a head of the tab id alone; so does a load.
    refs.learn('tab 5: Settings — https://site.example/settings\ne14 button "Delete account"');
    refs.learn('tab 5\ne3 button "Next"');
    expect(refs.find('e14', '5')).toBeUndefined();
    refs.learn('tab 5\ne14 button "Delete account"', { find: 'Delete' });
    refs.learn('Loaded tab 5: Home — https://site.example/\ne1 link "Settings"');
    expect(refs.find('e14', '5')).toBeUndefined();
  });

  it('takes a step\'s reply in again when the reply under its key changed', () => {
    const refs = new RefNames();
    refs.learn('tab 5: A — https://a.example/\ne1 button "First"', {}, 'thread:item');
    refs.learn('tab 5: A — https://a.example/\ne1 button "Second"', {}, 'thread:item');
    expect(refs.find('e1', '5')?.name).toBe('Second');
  });

  it('marks each kind of browser step with its own icon and names targets in a T3 thread', () => {
    const view = t3ThreadView({
      thread: { id: 't', title: 'T' },
      runs: [{ id: 'r', status: 'running', ordinal: 1 }],
      runtimeRequests: [],
      visibleTurnItems: [
        { item: { id: '1', type: 'user_message', text: 'Buy it', runId: 'r' } },
        { item: { id: '2', type: 'dynamic_tool', runId: 'r', toolName: 'mcp__t3-tab__read', input: {}, output: 'tab 3: Shop — https://shop.example/\ne7 button "Add to cart"' } },
        { item: { id: '3', type: 'dynamic_tool', runId: 'r', status: 'running', toolName: 'mcp__t3-tab__act', input: { steps: [{ action: 'click', ref: 'e7' }] } } },
      ],
    });
    const work = view.rows.find((row) => row.kind === 'work');
    expect(work?.kind === 'work' ? work.entries.map((entry) => [entry.icon, entry.label, entry.status]) : []).toEqual([
      ['page-read', 'Read shop.example', 'done'],
      ['page-act', 'Clicked “Add to cart”', 'running'],
    ]);
  });

  it('fetches the browser replies T3 left out once, and names sites and elements from them', () => {
    const projection: T3Projection = {
      thread: { id: 't', title: 'T' },
      runs: [{ id: 'r', status: 'running', ordinal: 1 }],
      runtimeRequests: [],
      visibleTurnItems: [
        { item: { id: '1', type: 'user_message', text: 'Buy it', runId: 'r' } },
        { item: { id: '2', type: 'dynamic_tool', runId: 'r', status: 'completed', toolName: 'mcp__t3-tab__read', input: {}, outputOmitted: true } },
        { item: { id: '3', type: 'dynamic_tool', runId: 'r', status: 'completed', toolName: 'mcp__other__thing', input: {}, outputOmitted: true } },
        { item: { id: '4', type: 'dynamic_tool', runId: 'r', status: 'running', toolName: 'mcp__t3-tab__act', input: { steps: [{ action: 'click', ref: 'e7' }] } } },
      ],
    };
    expect(omittedBrowserReplies(projection, new Map())).toEqual(['2']);
    expect(omittedBrowserReplies(projection, new Map([['2', null]]))).toEqual([]);
    const labels = (replies: Map<string, string | null>): string[] => {
      const work = t3ThreadView(projection, replies).rows.find((row) => row.kind === 'work');
      return work?.kind === 'work' ? work.entries.map((entry) => entry.label) : [];
    };
    expect(labels(new Map())).toEqual(['Read the page', 'mcp__other__thing', 'Clicked an element on the page']);
    const reply = toolOutputText({ content: [{ type: 'text', text: 'tab 3: Shop — https://shop.example/\ne7 button "Add to cart"' }] });
    expect(labels(new Map([['2', reply ?? null]]))).toEqual(['Read shop.example', 'mcp__other__thing', 'Clicked “Add to cart”']);
    expect(toolOutputText([{ type: 'image', data: 'x' }])).toBeUndefined();
  });

  it('keeps the whole steps of a direct run whose arguments were cut off', () => {
    const view = directThreadView({
      id: 'c',
      via: 'claude',
      title: 'T',
      status: 'running',
      messages: [],
      updatedAt: 0,
      items: [
        { id: 'u', kind: 'user', text: 'Sign in' },
        { id: 'r', kind: 'tool', name: 'read', status: 'done', output: 'tab 4: Login — https://site.example/\ne2 textbox "Email"\ne4 button "Sign in"' },
        { id: 'a', kind: 'tool', name: 'act', status: 'running', summary: `{"steps":[{"action":"click","ref":"e4"},{"action":"fill","ref":"e2","text":"${'x'.repeat(200)}…` },
      ],
    });
    const work = view.rows.find((row) => row.kind === 'work');
    expect(work?.kind === 'work' ? work.entries.map((entry) => entry.label) : []).toEqual(['Read site.example', 'Clicked “Sign in”']);
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
