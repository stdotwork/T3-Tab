import { DEFAULT_SCREENSHOT_MAX_EDGE } from '@t3-tab/protocol';
import { z } from 'zod';

// These shapes are the tools' input schemas: the agent reads them on every turn, so they carry as
// few constraints and as few words as they can. The daemon checks incoming calls against the same
// shapes; a value the shapes let through but the browser cannot use comes back as the browser's error.

const tab = z.number().optional();

export const tabsShape = {
  action: z.enum(['list', 'open', 'switch', 'close']).optional().describe('Default list.'),
  url: z.string().optional().describe('URL to open.'),
  tab: tab.describe('Tab id, for switch and close.'),
};

export const readShape = {
  tab: tab.describe('Tab id; default the front tab.'),
  all: z.boolean().optional().describe('Include all text, not only interactive elements.'),
  find: z.string().max(200).optional().describe('Case-insensitive literal text; returns only matching lines.'),
  regex: z.boolean().optional().describe('Treat find as a regular expression; bounded by a timeout.'),
  ref: z.string().optional().describe("Read only this element's subtree."),
  depth: z.number().min(0).optional().describe('Deepest nesting to show.'),
  full: z.boolean().optional().describe('Whole page, not only what changed.'),
};

export const screenshotShape = {
  tab: tab.describe('Tab id; default the front tab.'),
  maxEdge: z
    .number()
    .min(64)
    .max(4096)
    .optional()
    .describe(`Long edge in pixels; default ${DEFAULT_SCREENSHOT_MAX_EDGE}.`),
};

export const tabsParams = z.object(tabsShape);
export const readParams = z.object(readShape);
export const screenshotParams = z.object(screenshotShape);

const ref = z.string().min(1);
const object = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict();

export const clickStep = object({ click: object({ ref }) });
export const typeStep = object({ type: object({ ref: ref.optional(), text: z.string() }) });
export const fillStep = object({ fill: object({ ref, value: z.string() }) });
export const pressStep = object({ press: object({ key: z.string().min(1) }) });
export const selectStep = object({ select: object({ ref, value: z.string() }) });
export const scrollStep = object({
  scroll: object({ ref: ref.optional(), dx: z.number().optional(), dy: z.number().optional() }).refine(
    (value) => (value.ref === undefined) !== (value.dx === undefined && value.dy === undefined),
    { message: 'use either ref or dx/dy' },
  ),
});
export const hoverStep = object({ hover: object({ ref }) });
export const waitStep = z.union([
  object({ wait: object({ ms: z.number().int().min(0).max(10_000) }) }),
  object({ wait: object({ for: z.string().min(1) }) }),
]);

export const actStepSchema = z.union([
  clickStep,
  typeStep,
  fillStep,
  pressStep,
  selectStep,
  scrollStep,
  hoverStep,
  waitStep,
]);

export const actShape = {
  tab: tab.describe('Tab id; default the front tab.'),
  steps: z.array(actStepSchema).min(1).max(50).describe('Ordered steps; stops at the first failure.'),
};

export const runJsShape = {
  tab: tab.describe('Tab id; default the front tab.'),
  expression: z.string().min(1).describe('Expression or async function body; JSON result.'),
};

export const actParams = z.object(actShape);
export const runJsParams = z.object(runJsShape);
