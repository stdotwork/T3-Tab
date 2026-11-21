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
  find: z.string().optional().describe('Case-insensitive regex; returns only matching lines.'),
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
