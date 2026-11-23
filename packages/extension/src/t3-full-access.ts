/**
 * How long a T3 answer counts, measured from when its read started, so a burst of browser steps does not start one
 * `t3` command each. It is also the longest a request can still pass after a thread leaves Full access.
 */
export const FULL_ACCESS_CONFIRMED_MS = 2_000;
/** How long one request may wait for T3, and how long a read may hold its thread's slot. */
export const FULL_ACCESS_WAIT_MS = 5_000;

interface ModeRead {
  startedAt: number;
  /** Settles when T3 answers. A yes here is not a decision: only `confirmedUntil` is. */
  answer: Promise<boolean>;
}

interface ThreadCheck {
  /** The newest answered read said Full access, and it started less than the confirmed time before this. */
  confirmedUntil: number;
  /** The read new requests join. A read older than the wait limit gives up the slot. */
  running?: ModeRead;
  started: number;
  /** The newest read whose answer was applied, so an abandoned read that answers late cannot overwrite it. */
  applied: number;
}

const TIMED_OUT = Symbol('timed out');

/**
 * T3's Full access counts as yes for a session's browser requests only while T3 itself says so. Each request asks T3 for
 * the thread's mode through the background program, so it holds with the side panel closed and ends when a thread leaves
 * Full access. The answer is decided in one step: every thread the session holds must have a yes from a read that started
 * under two seconds ago at that moment. No answer, an unbound claim or a stopped T3 all mean a normal prompt.
 */
export function t3FullAccess(
  threadsOf: (sessionId: string) => Promise<string[] | undefined>,
  askMode: (threadId: string) => Promise<string>,
  now: () => number = Date.now,
): (sessionId: string) => Promise<boolean> {
  const checks = new Map<string, ThreadCheck>();

  const checkFor = (threadId: string): ThreadCheck => {
    let check = checks.get(threadId);
    if (check === undefined) {
      check = { confirmedUntil: 0, started: 0, applied: 0 };
      checks.set(threadId, check);
    }
    return check;
  };

  const startRead = (threadId: string, check: ThreadCheck): ModeRead => {
    check.started += 1;
    const sequence = check.started;
    const startedAt = now();
    const read: ModeRead = {
      startedAt,
      answer: Promise.resolve()
        .then(async () => await askMode(threadId))
        .then(
          (mode) => mode === 'full-access',
          () => false,
        )
        .then((yes) => {
          if (sequence > check.applied) {
            check.applied = sequence;
            check.confirmedUntil = yes ? startedAt + FULL_ACCESS_CONFIRMED_MS : 0;
          }
          if (check.running === read) delete check.running;
          return yes;
        }),
    };
    check.running = read;
    return read;
  };

  /** Waits for a current read of this thread. False for a no, or when the request's own wait runs out. */
  const awaitRead = async (threadId: string, check: ThreadCheck, deadline: number): Promise<boolean> => {
    for (;;) {
      const current = check.running;
      const read = current !== undefined && now() - current.startedAt < FULL_ACCESS_WAIT_MS ? current : startRead(threadId, check);
      const wakeAt = Math.min(deadline, read.startedAt + FULL_ACCESS_WAIT_MS);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const answer = await Promise.race([
        read.answer,
        new Promise<typeof TIMED_OUT>((resolve) => {
          timer = setTimeout(() => resolve(TIMED_OUT), Math.max(0, wakeAt - now()));
        }),
      ]);
      clearTimeout(timer);
      if (answer !== TIMED_OUT) return answer;
      // A read that never came back gives up the slot, so the next wait starts a fresh one.
      if (check.running === read) delete check.running;
      if (wakeAt >= deadline) return false;
    }
  };

  return async (sessionId) => {
    const threads = await threadsOf(sessionId);
    if (threads === undefined || threads.length === 0) return false;
    const held = threads.map((threadId) => ({ threadId, check: checkFor(threadId) }));
    const deadline = now() + FULL_ACCESS_WAIT_MS;
    for (;;) {
      // The decision: with no await between this check and the return, every yes is live at the same moment.
      const at = now();
      const lapsed = held.filter(({ check }) => check.confirmedUntil <= at);
      if (lapsed.length === 0) return true;
      if (at >= deadline) return false;
      const answers = await Promise.all(lapsed.map(async ({ threadId, check }) => await awaitRead(threadId, check, deadline)));
      if (!answers.every(Boolean)) return false;
    }
  };
}
