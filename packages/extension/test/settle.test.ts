import { describe, expect, it } from 'vitest';

import { SettleTracker, type SettleSnapshot } from '../src/settle';

const still: SettleSnapshot = {
  ready: true,
  revision: 2,
  layout: '1|1600|900|1600|900|http://localhost/',
  networkRevision: 4,
};

describe('action settling', () => {
  it('waits for a quiet window after the page stops changing', () => {
    const tracker = new SettleTracker(0, 150);
    expect(tracker.observe(still, 0)).toBe('changed');
    expect(tracker.observe(still, 100)).toBe('waiting');
    expect(tracker.observe(still, 149)).toBe('waiting');
    expect(tracker.observe(still, 150)).toBe('settled');
  });

  it('restarts the quiet window when layout or network activity changes', () => {
    const tracker = new SettleTracker(0, 150);
    tracker.observe(still, 0);
    tracker.observe(still, 100);
    expect(tracker.observe({ ...still, layout: '1|1600|900|1600|1200|http://localhost/' }, 120)).toBe('changed');
    expect(tracker.observe({ ...still, networkRevision: 5 }, 200)).toBe('changed');
    expect(tracker.observe({ ...still, networkRevision: 5 }, 349)).toBe('waiting');
    expect(tracker.observe({ ...still, networkRevision: 5 }, 350)).toBe('settled');
  });

  it('caps the wait when the page never becomes ready', () => {
    const tracker = new SettleTracker(0, 150, 500);
    expect(tracker.observe({ ...still, ready: false }, 0)).toBe('changed');
    expect(tracker.observe({ ...still, ready: false }, 250)).toBe('changed');
    expect(tracker.observe({ ...still, ready: false }, 500)).toBe('settled');
    expect(tracker.timedOut(500)).toBe(true);
  });
});
