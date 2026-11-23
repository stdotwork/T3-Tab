/**
 * How long a T3 answer counts, measured from when its read started, so a burst of browser steps does not start one
 * `t3` command each. It is also the longest a request can still pass after the thread leaves Full access.
 */
export const FULL_ACCESS_CONFIRMED_MS = 2_000;
const ASK_TIMEOUT_MS = 5_000;

interface ThreadCheck {
  /** Reads started before this time said Full access. Cleared by any read that did not. */
  confirmedUntil: number;
  /** The one read in flight for this thread. Reads never overlap, so an older answer cannot land after a newer one. */
  running?: Promise<boolean>;
}

/**
 * T3's Full access counts as yes for a session's browser requests only while T3 itself says so. Each request asks T3 for
 * the thread's mode through the background program, so it holds with the side panel closed and ends when the thread
 * leaves Full access. No answer, an unbound claim or a stopped T3 all mean a normal prompt.
 */
export function t3FullAccess(
  threadsOf: (sessionId: string) => Promise<string[] | undefined>,
  askMode: (threadId: string) => Promise<string>,
  now: () => number = Date.now,
): (sessionId: string) => Promise<boolean> {
  const checks = new Map<string, ThreadCheck>();

  const read = (threadId: string, check: ThreadCheck): Promise<boolean> => {
    if (check.running !== undefined) return check.running;
    const startedAt = now();
    const running = Promise.resolve()
      .then(async () => await askMode(threadId))
      .then(
        (mode) => {
          const yes = mode === 'full-access';
          check.confirmedUntil = yes ? startedAt + FULL_ACCESS_CONFIRMED_MS : 0;
          return yes;
        },
        () => {
          check.confirmedUntil = 0;
          return false;
        },
      )
      .finally(() => {
        delete check.running;
      });
    check.running = running;
    return running;
  };

  const confirmed = async (threadId: string): Promise<boolean> => {
    let check = checks.get(threadId);
    if (check === undefined) {
      check = { confirmedUntil: 0 };
      checks.set(threadId, check);
    }
    const deadline = now() + ASK_TIMEOUT_MS;
    for (;;) {
      if (check.confirmedUntil > now()) return true;
      const remaining = deadline - now();
      if (remaining <= 0) return false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const answer = await Promise.race([
        read(threadId, check),
        new Promise<false>((resolve) => {
          timer = setTimeout(() => resolve(false), remaining);
        }),
      ]);
      clearTimeout(timer);
      // A yes that took too long to arrive has already lapsed, so the loop asks again.
      if (!answer) return false;
    }
  };

  return async (sessionId) => {
    const threads = await threadsOf(sessionId);
    if (threads === undefined || threads.length === 0) return false;
    const answers = await Promise.all(threads.map(confirmed));
    return answers.every(Boolean);
  };
}
