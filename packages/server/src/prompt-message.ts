import { actStepsText, cleanActSummary, type PromptNotice } from '@t3-tab/protocol';

const MAX_TITLE_CHARS = 80;

/** Characters that can hide or reorder text on screen: controls, and the bidirectional and zero-width formatting marks. */
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

/** A page's own words, made safe to show in a thread: one line, no hidden characters, no quote marks, a fixed length. */
function plainText(value: string): string {
  const text = value.replace(INVISIBLE, ' ').replaceAll('"', "'").replace(/\s+/g, ' ').trim();
  return text.length <= MAX_TITLE_CHARS ? text : `${text.slice(0, MAX_TITLE_CHARS - 1)}…`;
}

const ACTIONS: Record<PromptNotice['tool'], string> = {
  read: 'read',
  open: 'open',
  act: 'act on',
  run_js: 'run JavaScript on',
};

/**
 * What the agent asked to do, in the words of the side panel's prompt: it names the tab by title, because the tab
 * need not be the one the owner is looking at.
 */
export function elicitationMessage(prompt: PromptNotice): string {
  const target = plainText(prompt.url ?? prompt.origin);
  const where = prompt.tab === undefined ? '' : ` in tab "${plainText(prompt.tab.title) || '(untitled)'}"`;
  // An act names what it does (`click “Add to cart” on`), from the steps the server described, never the agent's text.
  const steps = prompt.tool === 'act' ? cleanActSummary(prompt.steps) : undefined;
  const action = steps === undefined || steps.length === 0 ? ACTIONS[prompt.tool] : `${actStepsText(steps, 'ask')} on`;
  return `Allow T3-Tab to ${action} ${target}${where}? Allow covers this one request only.`;
}

/**
 * Whether the client can show a form. A client that declares `elicitation` with no modes means forms only; one that
 * declares only `url` cannot.
 */
export function supportsFormElicitation(capability: { form?: unknown; url?: unknown } | undefined): boolean {
  return capability !== undefined && (capability.form !== undefined || capability.url === undefined);
}
