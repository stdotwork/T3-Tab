import { afterEach, describe, expect, it, vi } from 'vitest';

import { fetchTurnReplies, REPLY_CONCURRENCY, REPLY_TIMEOUT_MS, TurnReplies } from '../entrypoints/sidepanel/lib/turn-replies';

afterEach(() => {
  vi.useRealTimers();
});

describe('the browser replies a T3 thread left out', () => {
  it('gives up on a step after ten seconds, counts it as no reply, and still takes the others', async () => {
    vi.useFakeTimers();
    const into = new Map<string, string | null>();
    const fetched = fetchTurnReplies(['slow', 'fast', 'broken'], (step) => (step === 'slow' ? new Promise<string>(() => undefined) : step === 'broken' ? Promise.reject(new Error('gone')) : Promise.resolve(`reply ${step}`)), into);
    await vi.advanceTimersByTimeAsync(REPLY_TIMEOUT_MS - 1);
    expect(into.has('slow')).toBe(false);
    expect(into.get('fast')).toBe('reply fast');
    expect(into.get('broken')).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    await fetched;
    expect(into.get('slow')).toBeNull();
  });

  it('asks for at most four at a time, as T3 Code does', async () => {
    let running = 0;
    let most = 0;
    const into = new Map<string, string | null>();
    await fetchTurnReplies(
      Array.from({ length: 10 }, (_, index) => `s${index}`),
      async (step) => {
        running += 1;
        most = Math.max(most, running);
        await new Promise((resolve) => setTimeout(resolve, 5));
        running -= 1;
        return step;
      },
      into,
    );
    expect(REPLY_CONCURRENCY).toBe(4);
    expect(most).toBe(4);
    expect(into.size).toBe(10);
  });

  it('starts no fetch once the thread is no longer wanted', async () => {
    const asked: string[] = [];
    let wanted = true;
    await fetchTurnReplies(
      ['a', 'b', 'c'],
      async (step) => {
        asked.push(step);
        wanted = false;
        return step;
      },
      new Map(),
      { concurrency: 1, stillWanted: () => wanted },
    );
    expect(asked).toEqual(['a']);
  });

  it('keeps a thread\'s replies for when it is opened again', () => {
    const replies = new TurnReplies();
    const first = replies.for('thread-1');
    first.set('item', 'tab 5\ne1 button "OK"');
    replies.for('thread-2');
    expect(replies.for('thread-1')).toBe(first);
    expect(replies.for('thread-1').get('item')).toBe('tab 5\ne1 button "OK"');
  });

  it('keeps the 50 threads shown last', () => {
    const replies = new TurnReplies();
    replies.for('oldest').set('item', 'kept?');
    for (let index = 0; index < 50; index += 1) replies.for(`thread-${index}`);
    expect(replies.for('oldest').has('item')).toBe(false);
  });
});
