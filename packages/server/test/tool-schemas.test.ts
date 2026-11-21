import { describe, expect, it } from 'vitest';

import { actParams, actStepSchema } from '../src/tool-schemas.js';

describe('act steps', () => {
  it('accepts each action shape', () => {
    const steps = [
      { click: { ref: 'e1' } },
      { type: { ref: 'e2', text: 'hello' } },
      { type: { text: 'hello' } },
      { fill: { ref: 'e2', value: 'hello' } },
      { press: { key: 'Control+A' } },
      { select: { ref: 'e3', value: 'Brazil' } },
      { scroll: { ref: 'e4' } },
      { scroll: { dx: 0, dy: 400 } },
      { hover: { ref: 'e5' } },
      { wait: { ms: 200 } },
      { wait: { for: 'Ready' } },
    ];
    for (const step of steps) expect(actStepSchema.safeParse(step).success, JSON.stringify(step)).toBe(true);
  });

  it('rejects empty batches and incomplete actions', () => {
    expect(actParams.safeParse({ steps: [] }).success).toBe(false);
    expect(actStepSchema.safeParse({ click: {} }).success).toBe(false);
    expect(actStepSchema.safeParse({ fill: { ref: 'e1' } }).success).toBe(false);
    expect(actStepSchema.safeParse({ press: { key: '' } }).success).toBe(false);
  });

  it('requires one wait target and one scroll target', () => {
    expect(actStepSchema.safeParse({ wait: {} }).success).toBe(false);
    expect(actStepSchema.safeParse({ wait: { ms: 50, for: 'Ready' } }).success).toBe(false);
    expect(actStepSchema.safeParse({ scroll: {} }).success).toBe(false);
    expect(actStepSchema.safeParse({ scroll: { ref: 'e1', dx: 10 } }).success).toBe(false);
  });

  it('rejects unknown fields instead of silently ignoring typos', () => {
    expect(actStepSchema.safeParse({ click: { ref: 'e1', coordinate: 10 } }).success).toBe(false);
    expect(actStepSchema.safeParse({ wait: { ms: 50, extra: true } }).success).toBe(false);
  });
});
