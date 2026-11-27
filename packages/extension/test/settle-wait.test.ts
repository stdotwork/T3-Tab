import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The page as the settle probe sees it: its mutation count moves at the times listed in `changesAt` (fake clock, ms), and
 * a dialog can open at `dialogAt`.
 */
const page = vi.hoisted(() => ({ changesAt: [] as number[], dialogAt: undefined as number | undefined }));
vi.mock('../src/cdp', () => ({
  documentEpoch: () => 1,
  networkRevision: () => 0,
  forgetPrivateWorld: () => undefined,
  privateWorld: async () => 7,
  openDialog: () => (page.dialogAt !== undefined && Date.now() >= page.dialogAt ? { type: 'alert' } : undefined),
  sendCommand: async () => ({
    result: {
      value: {
        ready: true,
        revision: page.changesAt.filter((at) => at <= Date.now()).length,
        width: 800,
        height: 600,
        scrollWidth: 800,
        scrollHeight: 600,
        url: 'http://a.test/',
      },
    },
  }),
}));

import { settlePage } from '../src/settle';

/** When the settle ended, on the fake clock. */
async function endOf(minMs: number): Promise<{ at: number; settled: boolean }> {
  let ended: { at: number; settled: boolean } | undefined;
  void settlePage(5, minMs).then((result) => (ended = { at: Date.now(), settled: result.settled }));
  for (let step = 0; step < 1_000 && ended === undefined; step += 1) await vi.advanceTimersByTimeAsync(10);
  if (ended === undefined) throw new Error('the settle did not end');
  return ended;
}

beforeEach(() => {
  vi.useFakeTimers({ now: 0 });
  page.changesAt = [];
  page.dialogAt = undefined;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('a settle that waits for a time', () => {
  it('lasts the whole wait on a quiet page, the quiet during the wait counting', async () => {
    const { at, settled } = await endOf(1_000);
    expect(at).toBeGreaterThanOrEqual(1_000);
    expect(at).toBeLessThan(1_050);
    expect(settled).toBe(true);
  });

  it('goes on until 150 ms of quiet after a change late in the wait', async () => {
    page.changesAt = [950];
    const { at } = await endOf(1_000);
    expect(at).toBeGreaterThanOrEqual(1_100);
    expect(at).toBeLessThan(1_200);
  });

  it('lasts 150 ms of quiet at the least when the wait is shorter', async () => {
    const { at } = await endOf(40);
    expect(at).toBeGreaterThanOrEqual(150);
    expect(at).toBeLessThan(200);
  });

  it('still lasts the whole wait when a dialog pauses the page during it', async () => {
    page.dialogAt = 300;
    const { at } = await endOf(1_000);
    expect(at).toBe(1_000);
  });

  it('gives up 4 seconds past the wait on a page that never stops changing', async () => {
    page.changesAt = Array.from({ length: 200 }, (_, index) => index * 30);
    const { at, settled } = await endOf(1_000);
    expect(at).toBeGreaterThanOrEqual(5_000);
    expect(at).toBeLessThan(5_100);
    expect(settled).toBe(false);
  });

  it('without a wait, ends after 150 ms of quiet as before', async () => {
    const { at } = await endOf(0);
    expect(at).toBeGreaterThanOrEqual(150);
    expect(at).toBeLessThan(200);
  });
});
