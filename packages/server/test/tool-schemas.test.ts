import { describe, expect, it } from 'vitest';

import { actParams, actShape, actStepSchema, convertStep, type FlatStep } from '../src/tool-schemas.js';

function problem(step: unknown): string | undefined {
  const result = actStepSchema.safeParse(step);
  return result.success ? undefined : result.error.issues[0]?.message;
}

describe('act steps', () => {
  it('accepts each action shape and converts it to the step the browser takes', () => {
    const cases: Array<[FlatStep, unknown]> = [
      [{ action: 'click', ref: 'e1' }, { click: { ref: 'e1' } }],
      [{ action: 'type', ref: 'e2', text: 'hello' }, { type: { ref: 'e2', text: 'hello' } }],
      [{ action: 'type', text: 'hello' }, { type: { text: 'hello' } }],
      [{ action: 'fill', ref: 'e2', text: 'hello' }, { fill: { ref: 'e2', value: 'hello' } }],
      [{ action: 'fill', ref: 'e2', text: '' }, { fill: { ref: 'e2', value: '' } }],
      [{ action: 'press', key: 'Control+A' }, { press: { key: 'Control+A' } }],
      [{ action: 'select', ref: 'e3', text: 'Brazil' }, { select: { ref: 'e3', value: 'Brazil' } }],
      [{ action: 'scroll', ref: 'e4' }, { scroll: { ref: 'e4' } }],
      [{ action: 'scroll', dx: 0, dy: 400 }, { scroll: { dx: 0, dy: 400 } }],
      [{ action: 'hover', ref: 'e5' }, { hover: { ref: 'e5' } }],
      [{ action: 'wait', ms: 200 }, { wait: { ms: 200 } }],
      [{ action: 'wait', ms: 0 }, { wait: { ms: 0 } }],
      [{ action: 'wait', text: 'Ready' }, { wait: { for: 'Ready' } }],
    ];
    for (const [step, expected] of cases) {
      expect(actStepSchema.safeParse(step).success, JSON.stringify(step)).toBe(true);
      expect(convertStep(step), JSON.stringify(step)).toMatchObject(expected as Record<string, unknown>);
    }
  });

  it('rejects empty batches, more than 50 steps and an unknown action', () => {
    expect(actParams.safeParse({ steps: [] }).success).toBe(false);
    expect(actParams.safeParse({ steps: Array.from({ length: 51 }, () => ({ action: 'press', key: 'a' })) }).success).toBe(false);
    expect(actParams.safeParse({ steps: Array.from({ length: 50 }, () => ({ action: 'press', key: 'a' })) }).success).toBe(true);
    expect(actStepSchema.safeParse({ action: 'drag', ref: 'e1' }).success).toBe(false);
    expect(actStepSchema.safeParse({ ref: 'e1' }).success).toBe(false);
  });

  it('refuses an incomplete step and says what is missing', () => {
    expect(problem({ action: 'click' })).toBe('click needs ref');
    expect(problem({ action: 'hover' })).toBe('hover needs ref');
    expect(problem({ action: 'fill', ref: 'e1' })).toBe('fill needs text');
    expect(problem({ action: 'fill', text: 'x' })).toBe('fill needs ref');
    expect(problem({ action: 'select', ref: 'e1' })).toBe('select needs text');
    expect(problem({ action: 'type' })).toBe('type needs text');
    expect(problem({ action: 'press' })).toBe('press needs key');
    expect(problem({ action: 'press', key: '' })).toBe('press key is empty');
    expect(problem({ action: 'click', ref: '' })).toBe('click ref is empty');
  });

  it('requires one wait target and one scroll target', () => {
    expect(problem({ action: 'wait' })).toBe('wait needs either ms or text');
    expect(problem({ action: 'wait', ms: 50, text: 'Ready' })).toBe('wait needs either ms or text');
    expect(problem({ action: 'wait', text: '' })).toBe('wait text is empty');
    expect(problem({ action: 'wait', ms: 10_001 })).toMatch(/^wait ms must be a whole number from 0 to 10000/);
    expect(problem({ action: 'wait', ms: -1 })).toMatch(/^wait ms must be/);
    expect(problem({ action: 'wait', ms: 1.5 })).toMatch(/^wait ms must be/);
    expect(problem({ action: 'scroll' })).toBe('scroll needs either ref or dx/dy');
    expect(problem({ action: 'scroll', ref: 'e1', dx: 10 })).toBe('scroll needs either ref or dx/dy');
  });

  it('rejects a field the action does not take and fields the shape does not have', () => {
    expect(problem({ action: 'click', ref: 'e1', text: 'x' })).toBe('click does not take text');
    expect(problem({ action: 'press', key: 'a', ref: 'e1' })).toBe('press does not take ref');
    expect(problem({ action: 'wait', ms: 50, dx: 1 })).toBe('wait does not take dx');
    expect(problem({ action: 'type', text: 'x', key: 'a' })).toBe('type does not take key');
    expect(actStepSchema.safeParse({ action: 'click', ref: 'e1', coordinate: 10 }).success).toBe(false);
    expect(actStepSchema.safeParse({ action: 'wait', ms: 50, extra: true }).success).toBe(false);
  });

  it('refuses a step in the old nested form', () => {
    expect(actStepSchema.safeParse({ click: { ref: 'e1' } }).success).toBe(false);
  });

  it('advertises one flat step object, not one branch per action', () => {
    const items = JSON.stringify(actShape.steps.toJSONSchema());
    expect(items).not.toContain('anyOf');
    expect(items).not.toContain('oneOf');
    expect(items.length).toBeLessThan(1200);
  });
});
