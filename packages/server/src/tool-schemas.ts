import { DEFAULT_SCREENSHOT_MAX_EDGE, type ActStep } from '@t3-tab/protocol';
import { z } from 'zod';

// These shapes check every call, in the MCP server and again in the daemon; a value they let through but
// the browser cannot use comes back as the browser's error. The agent reads them on every request as the
// tools' input schemas, so `listedSchema` leaves out of what it reads the keywords these checks enforce
// anyway and the parameters no agent was seen to use, and the shapes carry as few words as they can.

// What `tab` defaults to is said once, in `read`'s description.
const tab = z.number().optional();
/** Longest `find` text. */
export const MAX_FIND = 200;
const find = z.string().max(MAX_FIND).optional();

export const tabsShape = {
  action: z.enum(['list', 'open', 'goto', 'back', 'forward', 'reload', 'switch', 'close']).optional().describe('Default list.'),
  url: z.string().optional(),
  tab,
  find: find.describe('Only matching lines.'),
  // No description: only a thread started from the side panel uses it, and its message says what to pass.
  claim: z.string().optional(),
};

export const readShape = {
  tab,
  url: z.string().optional().describe('Reuses its tab, else opens one.'),
  all: z.boolean().optional().describe('All text, no budget; images too.'),
  find: find.describe('Case-insensitive literal text; returns only matching lines.'),
  regex: z.boolean().optional().describe('find is a regular expression.'),
  ref: z.string().optional().describe("Read only this element's subtree."),
  depth: z.number().min(0).optional().describe('Deepest nesting to show; … marks more inside.'),
  full: z.boolean().optional().describe('Whole page, not only what changed.'),
};

export const screenshotShape = {
  tab,
  maxEdge: z
    .number()
    .min(64)
    .max(4096)
    .optional()
    .describe(`Long edge in pixels; default ${DEFAULT_SCREENSHOT_MAX_EDGE}.`),
};

/** Accepted by `read` but left out of its listed schema: no agent was seen to pass them, and no reply points to them. */
export const READ_UNLISTED = ['regex', 'depth'] as const;

export const tabsParams = z.object(tabsShape);
export const readParams = z.object(readShape);
export const screenshotParams = z.object(screenshotShape);

const MAX_WAIT_MS = 10_000;
const ACTIONS = ['click', 'type', 'fill', 'press', 'select', 'scroll', 'hover', 'wait'] as const;

/**
 * One step as the agent writes it: a flat object with an `action` and the few fields that action uses. A
 * step that was one JSON-schema branch per action cost about half of all tool-definition tokens; this
 * shape is one branch, and `stepProblem` is what still refuses a step the schema alone would let through.
 */
export const actStepSchema = z
  .object({
    action: z.enum(ACTIONS),
    ref: z.string().optional(),
    text: z.string().optional(),
    key: z.string().optional(),
    dx: z.number().optional(),
    dy: z.number().optional(),
    ms: z.number().optional(),
  })
  .strict()
  .superRefine((step, context) => {
    const converted = convertStep(step);
    if (typeof converted === 'string') context.addIssue({ code: 'custom', message: converted });
  });

export type FlatStep = z.infer<typeof actStepSchema>;

type StepField = Exclude<keyof FlatStep, 'action'>;

/** Which fields each action takes: the first group is required, the second may be given. */
const STEP_FIELDS: Record<FlatStep['action'], [required: StepField[], optional: StepField[]]> = {
  click: [['ref'], []],
  hover: [['ref'], []],
  type: [['text'], ['ref']],
  fill: [['ref', 'text'], []],
  select: [['ref', 'text'], []],
  press: [['key'], []],
  scroll: [[], ['ref', 'dx', 'dy']],
  wait: [[], ['ms', 'text']],
};

/** Fields that may not be an empty string; `text` may be (an empty `fill` clears a field). */
const NON_EMPTY: StepField[] = ['ref', 'key'];

/** The step in the form the browser extension takes, or what is wrong with it. */
export function convertStep(step: FlatStep): ActStep | string {
  const { action } = step;
  const [required, optional] = STEP_FIELDS[action];
  for (const field of required) {
    if (step[field] === undefined) return `${action} needs ${field}`;
  }
  for (const field of Object.keys(step) as Array<keyof FlatStep>) {
    if (field !== 'action' && step[field] !== undefined && !required.includes(field) && !optional.includes(field)) {
      return `${action} does not take ${field}`;
    }
  }
  for (const field of NON_EMPTY) {
    if (step[field] === '') return `${action} ${field} is empty`;
  }
  const { ref, text, key, dx, dy, ms } = step;
  switch (action) {
    case 'click':
      return { click: { ref: ref ?? '' } };
    case 'hover':
      return { hover: { ref: ref ?? '' } };
    case 'type':
      return { type: { ref, text: text ?? '' } };
    case 'fill':
      return { fill: { ref: ref ?? '', value: text ?? '' } };
    case 'select':
      return { select: { ref: ref ?? '', value: text ?? '' } };
    case 'press':
      return { press: { key: key ?? '' } };
    case 'scroll':
      if ((ref === undefined) === (dx === undefined && dy === undefined)) return 'scroll needs either ref or dx/dy';
      return { scroll: { ref, dx, dy } };
    case 'wait':
      if ((ms === undefined) === (text === undefined)) return 'wait needs either ms or text';
      if (ms !== undefined) {
        if (!Number.isInteger(ms) || ms < 0 || ms > MAX_WAIT_MS) return `wait ms must be a whole number from 0 to ${MAX_WAIT_MS}`;
        return { wait: { ms } };
      }
      if (text === '') return 'wait text is empty';
      return { wait: { for: text ?? '' } };
  }
}

export const actShape = {
  tab,
  steps: z
    .array(actStepSchema)
    .min(1)
    .max(50)
    .describe(
      'Run in order; stops at the first failure. Fields by action: click, hover: ref. type: text, optional ref. ' +
        'fill, select: ref, text. press: key (Enter, Escape, Control+A). scroll: ref, or dx and dy. ' +
        `wait: ms (0-${MAX_WAIT_MS}) or text to wait for. A field check slower than 150 ms needs a wait step.`,
    ),
  // Its length is checked when the call runs: the schema stays smaller.
  find: z.string().optional().describe('Only matching lines.'),
};

export const runJsShape = {
  tab,
  expression: z.string().min(1).describe('Expression or async function body; JSON result.'),
};

export const actParams = z.object(actShape);
export const runJsParams = z.object(runJsShape);

/**
 * Keywords the shapes above check on every call, so the agent does not need to read them: the JSON Schema
 * dialect, lengths, ranges, item counts and the refusal of unknown step fields.
 */
const CHECKED_KEYWORDS = new Set(['$schema', 'minItems', 'maxItems', 'minLength', 'maxLength', 'minimum', 'maximum', 'additionalProperties']);

type JsonSchema = { [key: string]: unknown };

/**
 * The input schema a tool lists, made the way the MCP SDK makes it from the same shape, without the keywords the
 * call is checked against anyway and without the parameters named in `unlisted` (which the call still accepts).
 */
export function listedSchema(shape: z.ZodRawShape, unlisted: readonly string[] = []): JsonSchema {
  const schema = withoutChecked(z.toJSONSchema(z.object(shape), { target: 'draft-7', io: 'input' }) as JsonSchema);
  const properties = schema.properties as Record<string, unknown> | undefined;
  for (const name of unlisted) delete properties?.[name];
  if (Array.isArray(schema.required)) {
    schema.required = schema.required.filter((name: unknown) => !unlisted.includes(String(name)));
    if ((schema.required as unknown[]).length === 0) delete schema.required;
  }
  return schema;
}

function withoutChecked(schema: JsonSchema): JsonSchema {
  const out: JsonSchema = {};
  for (const [key, value] of Object.entries(schema)) {
    if (CHECKED_KEYWORDS.has(key)) continue;
    if (key === 'properties' && typeof value === 'object' && value !== null) {
      // Property names are the tool's own words, never keywords: only their schemas are cleaned.
      out[key] = Object.fromEntries(Object.entries(value as JsonSchema).map(([name, property]) => [name, withoutChecked(property as JsonSchema)]));
    } else if (key === 'items' && typeof value === 'object' && value !== null && !Array.isArray(value)) {
      out[key] = withoutChecked(value as JsonSchema);
    } else {
      out[key] = value;
    }
  }
  return out;
}
