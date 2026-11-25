import { describe, expect, it } from 'vitest';

import type { ThreadShell } from '../entrypoints/sidepanel/lib/t3-client';
import { needsOwner, nextWake, threadSections, wakeLabel, type DirectRun, type ThreadSections } from '../entrypoints/sidepanel/lib/thread-sections';

// The cases are worked from T3 Code's sidebar rules (nightly 0.1.12): which section a shell thread lands in and the
// order inside each section, with T3's default settings.
const NOW = Date.parse('2026-11-25T12:00:00.000Z');
const at = (minutes: number): string => new Date(NOW + minutes * 60_000).toISOString();

/** A thread whose last run finished, as T3's shell sends it: `status` is the latest run's status. */
function shell(id: string, extra: Partial<ThreadShell> = {}): ThreadShell {
  return {
    id,
    projectId: 'p1',
    title: id,
    status: 'completed',
    interactionMode: 'default',
    createdAt: at(-600),
    updatedAt: at(-60),
    latestRunId: `run-${id}`,
    latestRunRequestedAt: at(-90),
    latestRunStartedAt: at(-89),
    latestRunCompletedAt: at(-60),
    activeRunId: null,
    activityRunStatus: null,
    pendingRuntimeRequest: null,
    lineage: { relationshipToParent: null, parentThreadId: null },
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    ...extra,
  };
}

const running = (id: string, extra: Partial<ThreadShell> = {}): ThreadShell =>
  shell(id, { status: 'running', activityRunStatus: 'running', activeRunId: `run-${id}`, latestRunCompletedAt: null, ...extra });

const ids = (sections: ThreadSections): Record<keyof ThreadSections, string[]> => ({
  pinned: sections.pinned.map((row) => row.id),
  active: sections.active.map((row) => row.id),
  working: sections.working.map((row) => row.id),
  snoozed: sections.snoozed.map((row) => row.id),
  settled: sections.settled.map((row) => row.id),
});

describe('thread sections', () => {
  it('puts each thread where T3 does: snoozed over settled over pinned, then working or active', () => {
    const sections = threadSections(
      [
        shell('plain'),
        running('busy'),
        shell('pinned', { pinnedAt: at(-500) }),
        // Pinned and running: T3 keeps it pinned, not on the Working shelf.
        running('pinned-busy', { pinnedAt: at(-400) }),
        shell('settled', { settledOverride: 'settled', settledAt: at(-30) }),
        // Settled and pinned at once: settled wins.
        shell('settled-pinned', { settledOverride: 'settled', settledAt: at(-20), pinnedAt: at(-300) }),
        // `active` is the owner taking a thread back out of Settled.
        shell('unsettled', { settledOverride: 'active', unsettledAt: at(-10) }),
        shell('snoozed', { snoozedAt: at(-5), snoozedUntil: at(30) }),
        // Snoozed beats settled while the snooze lasts.
        shell('snoozed-settled', { settledOverride: 'settled', settledAt: at(-100), snoozedAt: at(-5), snoozedUntil: at(60) }),
      ],
      [],
      NOW,
    );
    expect(ids(sections)).toEqual({
      pinned: ['pinned', 'pinned-busy'],
      active: ['unsettled', 'plain'],
      working: ['busy'],
      snoozed: ['snoozed', 'snoozed-settled'],
      settled: ['settled-pinned', 'settled'],
    });
  });

  it('wakes a snooze once snoozedUntil passes, back to where the thread would be without it', () => {
    const threads = [shell('a', { snoozedAt: at(-60), snoozedUntil: at(10) }), shell('b', { settledOverride: 'settled', settledAt: at(-200), snoozedAt: at(-60), snoozedUntil: at(10) })];
    expect(ids(threadSections(threads, [], NOW)).snoozed).toEqual(['a', 'b']);
    const later = NOW + 10 * 60_000;
    // At the exact wake time T3 counts it awake (`snoozedUntil <= now`).
    const woke = ids(threadSections(threads, [], later));
    expect(woke.snoozed).toEqual([]);
    expect(woke.active).toEqual(['a']);
    expect(woke.settled).toEqual(['b']);
    expect(nextWake(threads, NOW)).toBe(later);
    expect(nextWake(threads, later)).toBeUndefined();
  });

  it('wakes a snooze early for an approval, a guest message, or a question or failure that came after the snooze', () => {
    const snooze = { snoozedAt: at(-30), snoozedUntil: at(120) };
    const sections = threadSections(
      [
        shell('approval', { ...snooze, status: 'waiting', activityRunStatus: 'waiting', pendingRuntimeRequest: { id: 'r1', kind: 'command_approval', createdAt: at(-40) } }),
        shell('question-after', { ...snooze, status: 'waiting', activityRunStatus: 'waiting', pendingRuntimeRequest: { id: 'r2', kind: 'user_input', createdAt: at(-10) } }),
        // A question already waiting when the owner snoozed stays snoozed.
        shell('question-before', { ...snooze, status: 'waiting', activityRunStatus: 'waiting', pendingRuntimeRequest: { id: 'r3', kind: 'user_input', createdAt: at(-45) } }),
        shell('guest', { ...snooze, pendingGuestMessageCount: 1 }),
        shell('failed-after', { ...snooze, status: 'failed', latestRunCompletedAt: at(-5) }),
        shell('failed-before', { ...snooze, status: 'failed', latestRunCompletedAt: at(-50) }),
      ],
      [],
      NOW,
    );
    expect(ids(sections).snoozed).toEqual(['question-before', 'failed-before']);
    expect(sections.active.map((row) => [row.id, row.status]).sort()).toEqual([
      ['approval', 'approval'],
      ['failed-after', 'failed'],
      ['guest', 'guest'],
      ['question-after', 'input'],
    ]);
  });

  it('orders each section by T3 keys', () => {
    const sections = threadSections(
      [
        // Pinned: pin order key first (string order), then unkeyed newest-created first.
        shell('pin-b', { pinnedAt: at(-1), pinOrderKey: 'b' }),
        shell('pin-a', { pinnedAt: at(-1), pinOrderKey: 'a' }),
        shell('pin-old', { pinnedAt: at(-1), createdAt: at(-900) }),
        shell('pin-new', { pinnedAt: at(-1), createdAt: at(-100) }),
        // Active: the latest of created, unsettled, and the last run's request and end; not the last message.
        shell('ran-late', { latestRunRequestedAt: at(-50), latestRunCompletedAt: at(-3), latestUserMessageAt: at(-500) }),
        shell('created-late', { createdAt: at(-2), status: 'idle', latestRunId: null, latestRunRequestedAt: null, latestRunStartedAt: null, latestRunCompletedAt: null }),
        shell('unsettled-late', { settledOverride: 'active', unsettledAt: at(-1) }),
        // Working: the owner's own latest message, else creation.
        running('work-old', { latestUserAuthoredMessageAt: at(-40) }),
        running('work-new', { latestUserAuthoredMessageAt: at(-4) }),
        // Snoozed: soonest to wake first.
        shell('snooze-later', { snoozedAt: at(-1), snoozedUntil: at(300) }),
        shell('snooze-soon', { snoozedAt: at(-1), snoozedUntil: at(5) }),
        // Settled: newest settle first.
        shell('settled-old', { settledOverride: 'settled', settledAt: at(-300) }),
        shell('settled-new', { settledOverride: 'settled', settledAt: at(-3) }),
      ],
      [],
      NOW,
    );
    expect(ids(sections)).toEqual({
      pinned: ['pin-a', 'pin-b', 'pin-new', 'pin-old'],
      active: ['unsettled-late', 'created-late', 'ran-late'],
      working: ['work-new', 'work-old'],
      snoozed: ['snooze-soon', 'snooze-later'],
      settled: ['settled-new', 'settled-old'],
    });
  });

  it('keeps a thread waiting on the owner, or with a plan to read, off the Working shelf', () => {
    const sections = threadSections(
      [
        running('asks', { status: 'waiting', activityRunStatus: 'waiting', pendingRuntimeRequest: { id: 'q', kind: 'user_input', createdAt: at(-1) } }),
        running('approves', { status: 'waiting', activityRunStatus: 'waiting', pendingRuntimeRequest: { id: 'a', kind: 'file_change_approval', createdAt: at(-1) } }),
        shell('plan', { interactionMode: 'plan', hasActionableProposedPlan: true }),
        // Background work the run is waiting on keeps it on the Working shelf, shown as Waiting.
        shell('background', { pendingBackgroundTasks: [{ taskId: 't1', kind: 'subagent' }] }),
        // A finished run is not working.
        shell('finished'),
        running('connecting', { status: 'starting', activityRunStatus: 'starting' }),
      ],
      [],
      NOW,
    );
    expect(ids(sections).working.sort()).toEqual(['background', 'connecting']);
    expect(Object.fromEntries([...sections.active, ...sections.working].map((row) => [row.id, row.status]))).toEqual({
      asks: 'input',
      approves: 'approval',
      plan: 'plan',
      background: 'waiting',
      finished: undefined,
      connecting: 'connecting',
    });
  });

  it('leaves out archived threads, subagents, side chats, workflow steps and threads delegated under a listed parent', () => {
    const sections = threadSections(
      [
        shell('parent'),
        shell('archived', { archivedAt: at(-1) }),
        shell('subagent', { lineage: { relationshipToParent: 'subagent', parentThreadId: 'parent' } }),
        shell('side', { lineage: { relationshipToParent: null, parentThreadId: 'parent', sideChat: true } }),
        shell('step', { lineage: { relationshipToParent: null, parentThreadId: null, workflowStep: true } }),
        shell('delegated', { delegatedFrom: { threadId: 'parent' } }),
        shell('orphan-delegated', { delegatedFrom: { threadId: 'gone' } }),
      ],
      [],
      NOW,
    );
    const all = Object.values(ids(sections)).flat().sort();
    expect(all).toEqual(['orphan-delegated', 'parent']);
  });

  it('shows a subagent approval on its parent', () => {
    const sections = threadSections(
      [
        running('parent'),
        running('child', {
          creationSource: 'agent',
          lineage: { relationshipToParent: 'subagent', parentThreadId: 'parent' },
          pendingRuntimeRequest: { id: 'r', kind: 'command_approval', createdAt: at(-1) },
        }),
      ],
      [],
      NOW,
    );
    expect(sections.active.map((row) => [row.id, row.status])).toEqual([['parent', 'approval']]);
    expect(needsOwner(sections)).toBe(true);
  });

  it('places direct runs as working while a turn runs and with the active threads otherwise', () => {
    const runs: DirectRun[] = [
      { id: 'd-run', title: 'Running', status: 'running', startedAt: NOW - 1000, updatedAt: NOW },
      { id: 'd-done', title: 'Done', status: 'idle', startedAt: NOW - 10 * 60_000, finishedAt: NOW - 30_000, updatedAt: NOW - 30_000 },
      { id: 'd-failed', title: 'Failed', status: 'failed', startedAt: NOW - 20 * 60_000, finishedAt: NOW - 19 * 60_000, updatedAt: NOW - 19 * 60_000 },
    ];
    const sections = threadSections([shell('t3')], runs, NOW);
    expect(ids(sections).working).toEqual(['d-run']);
    // The T3 thread's last run ended an hour ago, so both finished direct runs are newer except the failed one.
    expect(ids(sections).active).toEqual(['d-done', 'd-failed', 't3']);
    expect(sections.active.find((row) => row.id === 'd-failed')?.status).toBe('failed');
    expect(needsOwner(sections)).toBe(false);
  });

  it('raises the needs-you signal for an approval or a question, but not for work or a question asleep in a snooze', () => {
    expect(needsOwner(threadSections([running('a')], [], NOW))).toBe(false);
    expect(needsOwner(threadSections([running('a', { pendingRuntimeRequest: { id: 'q', kind: 'user_input', createdAt: at(-1) } })], [], NOW))).toBe(true);
    const asleep = shell('s', { snoozedAt: at(-1), snoozedUntil: at(60), status: 'waiting', activityRunStatus: 'waiting', pendingRuntimeRequest: { id: 'q', kind: 'user_input', createdAt: at(-5) } });
    expect(needsOwner(threadSections([asleep], [], NOW))).toBe(false);
    expect(needsOwner(threadSections([asleep], [], NOW + 61 * 60_000))).toBe(true);
  });

  it('labels a snooze the way T3 does', () => {
    expect(wakeLabel(at(0), NOW)).toBe('now');
    expect(wakeLabel(at(-5), NOW)).toBe('now');
    expect(wakeLabel(at(5), NOW)).toBe('5m');
    expect(wakeLabel(at(59), NOW)).toBe('59m');
    expect(wakeLabel(at(61), NOW)).toBe('2h');
    expect(wakeLabel(at(24 * 60), NOW)).toBe('1d');
    expect(wakeLabel(at(25 * 60), NOW)).toBe('2d');
  });
});
