/** How long T3's answer stands, so a burst of browser steps does not start one `t3` command each. */
export const FULL_ACCESS_CONFIRMED_MS = 2_000;
const ASK_TIMEOUT_MS = 5_000;

/**
 * T3's Full access counts as yes for a session's browser requests only while T3 itself says so. Each request asks T3 for
 * the thread's mode through the background program, so it holds with the side panel closed and ends as soon as the
 * thread leaves Full access. No answer, an unbound claim or a stopped T3 all mean a normal prompt.
 */
export function t3FullAccess(
  threadsOf: (sessionId: string) => Promise<string[] | undefined>,
  askMode: (threadId: string) => Promise<string>,
  now: () => number = Date.now,
): (sessionId: string) => Promise<boolean> {
  const confirmedUntil = new Map<string, number>();
  const confirmed = async (threadId: string): Promise<boolean> => {
    if ((confirmedUntil.get(threadId) ?? 0) > now()) return true;
    confirmedUntil.delete(threadId);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const mode = await Promise.race([
        askMode(threadId),
        new Promise<undefined>((resolve) => {
          timer = setTimeout(() => resolve(undefined), ASK_TIMEOUT_MS);
        }),
      ]);
      if (mode !== 'full-access') return false;
      confirmedUntil.set(threadId, now() + FULL_ACCESS_CONFIRMED_MS);
      return true;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  };
  return async (sessionId) => {
    const threads = await threadsOf(sessionId);
    if (threads === undefined || threads.length === 0) return false;
    const answers = await Promise.all(threads.map(confirmed));
    return answers.every(Boolean);
  };
}
