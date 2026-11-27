/**
 * The browser replies T3 leaves out of a thread's stream (`outputOmitted`), fetched as T3's own client fetches a step's
 * detail (`reconcilePendingWork` in its client runtime): `orchestration.getTurnItem` per step, at most four at a time,
 * each given up after ten seconds, and a step whose fetch failed or timed out counts as having no reply.
 */

/** How long one step's fetch may take, and how many run at once: T3's own client's numbers. */
export const REPLY_TIMEOUT_MS = 10_000;
export const REPLY_CONCURRENCY = 4;
/** Threads whose replies the panel keeps while it is open, most recently shown first out last. */
const THREADS_KEPT = 50;

/**
 * The replies fetched so far, by thread and step, kept on the panel's T3 client for as long as the panel is open, so a
 * thread opened again draws its steps' words at once and fetches only what is new. A step's entry is `null` when T3 gave
 * no reply or the fetch failed.
 */
export class TurnReplies {
  private readonly threads = new Map<string, Map<string, string | null>>();

  /** The replies of one thread; the same map every time, so a watch and the cache share it. */
  for(thread: string): Map<string, string | null> {
    let replies = this.threads.get(thread);
    if (replies === undefined) replies = new Map();
    else this.threads.delete(thread);
    this.threads.set(thread, replies);
    if (this.threads.size > THREADS_KEPT) this.threads.delete(this.threads.keys().next().value ?? '');
    return replies;
  }
}

/** `value`, or `null` once `ms` has passed without it, or when it fails. */
async function within<T>(value: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  try {
    return await Promise.race([value.catch(() => null), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetches the replies of `steps` into `into`, `concurrency` at a time. Every step gets an entry, `null` when its fetch
 * failed or took longer than `timeoutMs`. `stillWanted` is asked before each fetch starts; once it says no, no more start.
 */
export async function fetchTurnReplies(
  steps: readonly string[],
  fetchOne: (step: string) => Promise<string | null>,
  into: Map<string, string | null>,
  options: { timeoutMs?: number; concurrency?: number; stillWanted?: () => boolean } = {},
): Promise<void> {
  const { timeoutMs = REPLY_TIMEOUT_MS, concurrency = REPLY_CONCURRENCY, stillWanted } = options;
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < steps.length) {
      if (stillWanted?.() === false) return;
      const step = steps[next];
      next += 1;
      if (step === undefined) return;
      into.set(step, await within(fetchOne(step), timeoutMs));
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, steps.length) }, worker));
}
