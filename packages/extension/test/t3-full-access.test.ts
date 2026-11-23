import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FULL_ACCESS_CONFIRMED_MS, t3FullAccess } from '../src/t3-full-access';

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

  it('needs every thread of the session to be full access', async () => {
    const both = build({ s: ['t1', 't2'] }, { t1: 'full-access', t2: 'full-access' });
    expect(await both.check('s')).toBe(true);
    const one = build({ s: ['t1', 't2'] }, { t1: 'full-access', t2: 'approval-required' });
    expect(await one.check('s')).toBe(false);
  });
});
