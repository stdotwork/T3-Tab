// Token estimate, budget check and markdown report for the benchmark. No browser in here, so a test can
// run it and `bench.mjs --check` can judge a saved results file.
import { countTokens } from 'gpt-tokenizer/encoding/o200k_base';

export const TOKEN_ESTIMATE =
  'Tokens are an estimate: the o200k_base encoding (OpenAI, open source) from the gpt-tokenizer package ' +
  'counts the text. Claude and other models use their own tokenizers, so the counts differ by a few ' +
  'percent but move the same way. An image is estimated at width x height / 750 tokens, the rule ' +
  "Anthropic's vision documentation gives; its base64 text is not counted.";

export const estimateTokens = (value) => countTokens(value);

/** Image tokens for a picture of this size, by the width x height / 750 rule. */
export const estimateImageTokens = (width, height) => Math.ceil((width * height) / 750);

/**
 * Compares a results object with a budget. Returns one message per problem: a number over its limit, a
 * measured number with no limit, or a limit nothing measured.
 */
export function checkBudget(results, budget) {
  const problems = [];
  const measured = metricsOf(results);
  const limits = budget.limits ?? {};
  for (const [key, values] of Object.entries(measured)) {
    const limit = limits[key];
    if (limit === undefined) {
      problems.push(`${key}: no budget entry (run with --update-budget and commit the change)`);
      continue;
    }
    for (const [field, value] of Object.entries(values)) {
      if (limit[field] === undefined) problems.push(`${key}: no budget for ${field}`);
      else if (value > limit[field]) problems.push(`${key}: ${field} ${value} is over the budget of ${limit[field]}`);
    }
  }
  for (const key of Object.keys(limits)) {
    if (measured[key] === undefined) problems.push(`${key}: in the budget but not measured`);
  }
  return problems;
}

/** The budgeted numbers of a run, by key: tool definitions and each reply. */
export function metricsOf(results) {
  const metrics = {};
  metrics['definitions.total'] = { chars: results.definitions.total.chars, tokens: results.definitions.total.tokens };
  for (const [tool, size] of Object.entries(results.definitions.tools)) {
    metrics[`definitions.${tool}`] = { chars: size.chars, tokens: size.tokens };
  }
  for (const step of results.steps) {
    const entry = { chars: step.chars, tokens: step.tokens };
    if (step.image !== undefined) {
      entry.imageBytes = step.image.bytes;
      entry.imageTokens = step.image.tokens;
    }
    metrics[`${step.task}.${step.step}`] = entry;
  }
  return metrics;
}

const HEADROOM = { chars: 1.05, tokens: 1.05, imageBytes: 1.4, imageTokens: 1.05 };

/** A budget with every measured number allowed a little room, because ports and tab ids change a few characters. */
export function budgetFrom(results) {
  const limits = {};
  for (const [key, values] of Object.entries(metricsOf(results))) {
    limits[key] = Object.fromEntries(
      Object.entries(values).map(([field, value]) => [field, Math.ceil(value * (HEADROOM[field] ?? 1.05)) + 2]),
    );
  }
  return {
    comment:
      'Limits for `pnpm bench`: each is the measured number plus 5% (40% for JPEG bytes, which vary with fonts). ' +
      'Raise one only on purpose, with the reason in the PR.',
    limits,
  };
}

/** A markdown report of one run. `before` is an earlier results object to show differences against. */
export function markdown(results, before) {
  const out = [];
  const delta = (now, then) => {
    if (then === undefined) return '';
    const change = now - then;
    return change === 0 ? ' (±0)' : ` (${change > 0 ? '+' : ''}${change})`;
  };
  const earlier = (select) => {
    if (before === undefined) return undefined;
    try {
      return select(before);
    } catch {
      return undefined;
    }
  };

  out.push('### Tool definitions (`tools/list`)', '');
  out.push('| Tool | Characters | Tokens |', '| --- | ---: | ---: |');
  for (const [tool, size] of Object.entries(results.definitions.tools)) {
    const then = earlier((b) => b.definitions.tools[tool]);
    out.push(`| ${tool} | ${size.chars}${delta(size.chars, then?.chars)} | ${size.tokens}${delta(size.tokens, then?.tokens)} |`);
  }
  const total = results.definitions.total;
  const thenTotal = earlier((b) => b.definitions.total);
  out.push(`| **all** | **${total.chars}**${delta(total.chars, thenTotal?.chars)} | **${total.tokens}**${delta(total.tokens, thenTotal?.tokens)} |`, '');

  out.push('### Replies', '');
  out.push('| Task | Step | Tool | Call tokens | Reply characters | Reply tokens |', '| --- | --- | --- | ---: | ---: | ---: |');
  for (const step of results.steps) {
    const then = earlier((b) => b.steps.find((s) => s.task === step.task && s.step === step.step));
    out.push(
      `| ${step.task} | ${step.step} | ${step.tool} | ${step.callTokens}${delta(step.callTokens, then?.callTokens)} | ${step.chars}${delta(step.chars, then?.chars)} | ${step.tokens}${delta(step.tokens, then?.tokens)} |`,
    );
  }
  out.push('');

  const shots = results.steps.filter((step) => step.image !== undefined);
  if (shots.length > 0) {
    out.push('### Screenshots (the text part is in Replies)', '');
    out.push('| Task | Size | JPEG bytes | Estimated image tokens |', '| --- | --- | ---: | ---: |');
    for (const step of shots) {
      const then = earlier((b) => b.steps.find((s) => s.task === step.task && s.step === step.step)?.image);
      out.push(
        `| ${step.task} | ${step.image.width}x${step.image.height} | ${step.image.bytes}${delta(step.image.bytes, then?.bytes)} | ${step.image.tokens}${delta(step.image.tokens, then?.tokens)} |`,
      );
    }
    out.push('');
  }

  out.push(`Measured on ${results.environment.browser}, ${results.environment.node}; call tokens count the JSON arguments the agent sends. ${TOKEN_ESTIMATE}`, '');
  return out.join('\n');
}
