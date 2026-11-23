import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FULL_ACCESS_CONFIRMED_MS, FULL_ACCESS_WAIT_MS, t3FullAccess } from '../src/t3-full-access';

let clock: number;
const now = (): number => clock;

beforeEach(() => {
  clock = 1_000_000;
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

function build(threads: Record<string, string[] | undefined>, modes: Record<string, string | Error | 'never'>) {
  const asked: string[] = [];
  const check = t3FullAccess(
    async (sessionId) => threads[sessionId],
    async (threadId) => {
      asked.push(threadId);
      const mode = modes[threadId];
      if (mode === 'never') return await new Promise<string>(() => undefined);
      if (mode instanceof Error) throw mode;
      return mode ?? 'approval-required';
    },
    now,
  );
  return { check, asked, modes };
}

describe('Full access, as T3 confirms it', () => {
  it('is yes when T3 says the bound thread runs with full access', async () => {
    const { check, asked } = build({ s: ['t1'] }, { t1: 'full-access' });
    expect(await check('s')).toBe(true);
    expect(asked).toEqual(['t1']);
  });

  it('is no for approval-required, a thrown error, an unknown mode, and a session with no bound thread', async () => {
    const { check } = build({ a: ['t1'], b: ['t2'], c: ['t3'], none: undefined, empty: [] }, { t1: 'approval-required', t2: new Error('T3 stopped'), t3: 'something-new' });
    expect(await check('a')).toBe(false);
    expect(await check('b')).toBe(false);
    expect(await check('c')).toBe(false);
    expect(await check('none')).toBe(false);
    expect(await check('empty')).toBe(false);
  });

  it('is no when T3 never answers, after the five second limit', async () => {
    const { check } = build({ s: ['t1'] }, { t1: 'never' });
    const answer = check('s');
    let settled = false;
    void answer.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(4_900);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(200);
    expect(await answer).toBe(false);
  });

  it('lets a yes stand for the confirmed time and asks T3 again after it', async () => {
    const { check, asked } = build({ s: ['t1'] }, { t1: 'full-access' });
    expect(await check('s')).toBe(true);
    clock += FULL_ACCESS_CONFIRMED_MS - 1;
    expect(await check('s')).toBe(true);
    expect(asked).toEqual(['t1']);
    clock += 1;
    expect(await check('s')).toBe(true);
    expect(asked).toEqual(['t1', 't1']);
  });

  it('follows T3 once the confirmed time has passed: a thread that left Full access gets no yes', async () => {
    const { check, modes } = build({ s: ['t1'] }, { t1: 'full-access' });
    expect(await check('s')).toBe(true);
    modes.t1 = 'approval-required';
    clock += FULL_ACCESS_CONFIRMED_MS;
    expect(await check('s')).toBe(false);
  });

  it('never keeps a negative answer', async () => {
    const { check, asked, modes } = build({ s: ['t1'] }, { t1: 'approval-required' });
    expect(await check('s')).toBe(false);
    modes.t1 = 'full-access';
    expect(await check('s')).toBe(true);
    expect(asked).toEqual(['t1', 't1']);
    // A failure is not kept either.
    const failing = build({ s: ['t1'] }, { t1: new Error('down') });
    expect(await failing.check('s')).toBe(false);
    failing.modes.t1 = 'full-access';
    expect(await failing.check('s')).toBe(true);
  });

  it('keeps one read per thread, and an older slow yes cannot re-arm it after the switch', async () => {
    const answers: Array<(mode: string) => void> = [];
    let asks = 0;
    const check = t3FullAccess(
      async () => ['t1'],
      async () => {
        asks += 1;
        return await new Promise<string>((resolve) => answers.push(resolve));
      },
      now,
    );
    // A starts while the thread is in Full access, and B arrives while A is still out.
    const first = check('a');
    await vi.advanceTimersByTimeAsync(0);
    clock += 1_000;
    const second = check('b');
    await vi.advanceTimersByTimeAsync(0);
    expect(asks).toBe(1);

    // A's yes lands after it has lapsed, so both ask again and T3 now says the thread left Full access.
    clock += FULL_ACCESS_CONFIRMED_MS;
    answers[0]?.('full-access');
    await vi.advanceTimersByTimeAsync(0);
    expect(asks).toBe(2);
    answers[1]?.('approval-required');
    await expect(first).resolves.toBe(false);
    await expect(second).resolves.toBe(false);

    // Nothing was cached, so the next request asks T3 again.
    const third = check('c');
    await vi.advanceTimersByTimeAsync(0);
    expect(asks).toBe(3);
    answers[2]?.('approval-required');
    await expect(third).resolves.toBe(false);
  });

  it('counts a yes from when its read started, not from when it arrived', async () => {
    const answers: Array<(mode: string) => void> = [];
    let asks = 0;
    const check = t3FullAccess(
      async () => ['t1'],
      async () => {
        asks += 1;
        return await new Promise<string>((resolve) => answers.push(resolve));
      },
      now,
    );
    const first = check('a');
    await vi.advanceTimersByTimeAsync(0);
    clock += FULL_ACCESS_CONFIRMED_MS - 1;
    answers[0]?.('full-access');
    await expect(first).resolves.toBe(true);
    clock += 1;
    const second = check('b');
    await vi.advanceTimersByTimeAsync(0);
    expect(asks).toBe(2);
    answers[1]?.('approval-required');
    await expect(second).resolves.toBe(false);
  });

  describe('with answers T3 gives on a schedule', () => {
    const tick = async (ms: number): Promise<void> => {
      clock += ms;
      await vi.advanceTimersByTimeAsync(ms);
    };
    /** Each ask waits for the test to answer it. */
    function scripted(threads: string[]) {
      const asks: Array<{ threadId: string; answer: (mode: string) => void }> = [];
      const check = t3FullAccess(
        async () => threads,
        async (threadId) => await new Promise<string>((resolve) => asks.push({ threadId, answer: resolve })),
        now,
      );
      const pendingFor = (threadId: string) => asks.filter((ask) => ask.threadId === threadId).at(-1);
      const asked = (threadId: string): number => asks.filter((ask) => ask.threadId === threadId).length;
      return { check, pendingFor, asked };
    }

    it('does not let a live yes ride out a slow sibling: the reviewer\'s timing is asked again and prompts', async () => {
      const threads = { a: ['a'], both: ['a', 'b'] } as const;
      const asks: Array<{ threadId: string; answer: (mode: string) => void }> = [];
      const check = t3FullAccess(
        async (sessionId) => [...threads[sessionId as keyof typeof threads]],
        async (threadId) => await new Promise<string>((resolve) => asks.push({ threadId, answer: resolve })),
        now,
      );
      const pendingFor = (threadId: string) => asks.filter((ask) => ask.threadId === threadId).at(-1);
      // A answers yes at t=0, so its cache runs to 2000. T3 records A leaving Full access just after.
      const seeded = check('a');
      await tick(0);
      pendingFor('a')?.answer('full-access');
      await expect(seeded).resolves.toBe(true);

      // A request starts at 1999 with A still live, and B's read takes until 3998.
      await tick(1_999);
      const request = check('both');
      await tick(0);
      expect(asks.filter((ask) => ask.threadId === 'a')).toHaveLength(1);
      await tick(1_999);
      pendingFor('b')?.answer('full-access');
      await tick(0);
      // B's yes is in, but A's has lapsed, so A is read again rather than accepted.
      expect(asks.filter((ask) => ask.threadId === 'a')).toHaveLength(2);
      pendingFor('a')?.answer('approval-required');
      await expect(request).resolves.toBe(false);
    });

    it('allows only when every yes is live at the same moment, re-reading until they are', async () => {
      const { check, pendingFor, asked } = scripted(['a', 'b']);
      const request = check('s');
      await tick(0);
      // A answers at once; B takes 2.5 s, so A lapses and B's own yes arrives already lapsed too.
      pendingFor('a')?.answer('full-access');
      await tick(2_500);
      pendingFor('b')?.answer('full-access');
      await tick(0);
      expect(asked('a')).toBe(2);
      expect(asked('b')).toBe(2);
      pendingFor('a')?.answer('full-access');
      pendingFor('b')?.answer('full-access');
      await expect(request).resolves.toBe(true);
    });

    it('prompts when the threads cannot all be live together within the wait limit', async () => {
      const { check, pendingFor } = scripted(['a', 'b']);
      const request = check('s');
      let settled: boolean | undefined;
      void request.then((value) => (settled = value));
      await tick(0);
      for (let step = 0; step < 3 && settled === undefined; step += 1) {
        pendingFor('a')?.answer('full-access');
        await tick(FULL_ACCESS_CONFIRMED_MS + 100);
        pendingFor('b')?.answer('full-access');
        await tick(0);
      }
      await tick(FULL_ACCESS_WAIT_MS);
      await expect(request).resolves.toBe(false);
    });

    it('lets the next request start a fresh read once a stuck one has used the wait limit', async () => {
      const { check, pendingFor, asked } = scripted(['a']);
      const stuck = check('s');
      await tick(0);
      const stuckAsk = pendingFor('a');
      await tick(FULL_ACCESS_WAIT_MS);
      await expect(stuck).resolves.toBe(false);

      const next = check('s');
      await tick(0);
      expect(asked('a')).toBe(2);
      pendingFor('a')?.answer('approval-required');
      await expect(next).resolves.toBe(false);

      // The stuck read finally says yes. It is older than the newest answer, so it changes nothing.
      stuckAsk?.answer('full-access');
      await tick(0);
      const after = check('s');
      await tick(0);
      expect(asked('a')).toBe(3);
      pendingFor('a')?.answer('approval-required');
      await expect(after).resolves.toBe(false);
    });

    it('moves a request that joined a stuck read onto a fresh one when that read hits the limit', async () => {
      const { check, pendingFor, asked } = scripted(['a']);
      const first = check('s');
      await tick(0);
      await tick(4_000);
      const joined = check('s');
      await tick(0);
      expect(asked('a')).toBe(1);
      await tick(1_000);
      await expect(first).resolves.toBe(false);
      expect(asked('a')).toBe(2);
      pendingFor('a')?.answer('full-access');
      await expect(joined).resolves.toBe(true);
    });

    it('does not let a late yes allow the request waiting on it', async () => {
      const { check, pendingFor, asked } = scripted(['a']);
      const request = check('s');
      await tick(0);
      await tick(FULL_ACCESS_CONFIRMED_MS);
      pendingFor('a')?.answer('full-access');
      await tick(0);
      expect(asked('a')).toBe(2);
      pendingFor('a')?.answer('approval-required');
      await expect(request).resolves.toBe(false);
    });
  });

  it('needs every thread of the session to be full access', async () => {
    const both = build({ s: ['t1', 't2'] }, { t1: 'full-access', t2: 'full-access' });
    expect(await both.check('s')).toBe(true);
    const one = build({ s: ['t1', 't2'] }, { t1: 'full-access', t2: 'approval-required' });
    expect(await one.check('s')).toBe(false);
  });
});
