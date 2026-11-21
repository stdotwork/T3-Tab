import { describe, expect, it } from 'vitest';

import { budgetFrom, checkBudget, estimateImageTokens, estimateTokens, markdown, metricsOf } from './report.mjs';

const results = () => ({
  definitions: {
    total: { chars: 1000, tokens: 250 },
    tools: { act: { chars: 600, tokens: 150 }, read: { chars: 400, tokens: 100 } },
  },
  steps: [
    { task: 'form', step: 'read-first', tool: 'read', callTokens: 1, chars: 700, tokens: 200 },
    { task: 'form', step: 'screenshot', tool: 'screenshot', callTokens: 1, chars: 40, tokens: 19, image: { width: 1280, height: 686, bytes: 30_000, tokens: 1171 } },
  ],
  environment: { browser: 'Chromium test', node: 'v0' },
});

describe('benchmark budget', () => {
  it('passes a run that is within its own budget', () => {
    expect(checkBudget(results(), budgetFrom(results()))).toEqual([]);
  });

  it('names each number that is over its limit', () => {
    const budget = budgetFrom(results());
    const worse = results();
    worse.definitions.tools.act.chars = 5000;
    worse.steps[0].tokens = 900;
    const problems = checkBudget(worse, budget);
    expect(problems).toHaveLength(2);
    expect(problems.join('\n')).toMatch(/definitions\.act: chars 5000 is over the budget of \d+/);
    expect(problems.join('\n')).toMatch(/form\.read-first: tokens 900 is over the budget of \d+/);
  });

  it('fails a measured number that has no limit and a limit that nothing measured', () => {
    const budget = budgetFrom(results());
    delete budget.limits['form.read-first'];
    budget.limits['gone.step'] = { chars: 1, tokens: 1 };
    const problems = checkBudget(results(), budget);
    expect(problems).toContain('form.read-first: no budget entry (run with --update-budget and commit the change)');
    expect(problems).toContain('gone.step: in the budget but not measured');
  });

  it('budgets image bytes and image tokens of a screenshot', () => {
    const metrics = metricsOf(results());
    expect(metrics['form.screenshot']).toEqual({ chars: 40, tokens: 19, imageBytes: 30_000, imageTokens: 1171 });
  });
});

describe('estimates', () => {
  it('counts text tokens with a real tokenizer, not characters over four', () => {
    expect(estimateTokens('hello world')).toBe(2);
    expect(estimateTokens('')).toBe(0);
  });

  it('estimates an image by its pixels', () => {
    expect(estimateImageTokens(1280, 686)).toBe(1171);
  });
});

describe('markdown report', () => {
  it('shows the change from an earlier run and says how tokens are estimated', () => {
    const before = results();
    before.definitions.total.chars = 1500;
    const text = markdown(results(), before);
    expect(text).toContain('| **all** | **1000** (-500) |');
    expect(text).toContain('o200k_base');
    expect(text).toContain('estimate');
  });
});
