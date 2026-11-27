/**
 * An `act` batch in words, for the owner: the side panel's work log ("Clicked “Add to cart”") and the permission prompt
 * that asks for it ("click “Add to cart”"). Built only from each step's action, the element it targets as a read printed it
 * (role and name), and a key name; what a step types or chooses is never part of it, because it can be a password.
 */
import type { ActAction } from './index.js';

/** The element a step acts on, as a read printed it: `e12 button "Add to cart"` is `{ role: 'button', name: 'Add to cart' }`. */
export interface ActTarget {
  role: string;
  name: string;
}

export interface ActStepSummary {
  action: ActAction;
  /** Absent when the step names no element, or the element is not known. */
  target?: ActTarget;
  /** The key a `press` step sends, only when it names a key rather than a character (see `namedKey`). */
  key?: string;
}

/** Most characters of an element's name in a description. */
const NAME_MAX = 40;
/** Most phrases a description lists before "and N more". */
const PHRASES_MAX = 3;

/** Characters that can hide or reorder text on screen: controls, and the bidirectional and zero-width formatting marks. */
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

/** A page's own words, safe to show: one line, no hidden characters, at most `NAME_MAX` characters. */
function plainName(name: string): string {
  const text = name.replace(INVISIBLE, ' ').replace(/\s+/g, ' ').trim();
  return text.length <= NAME_MAX ? text : `${text.slice(0, NAME_MAX - 1).trimEnd()}…`;
}

const NAMED_KEYS = new Set([
  'Enter',
  'Escape',
  'Esc',
  'Tab',
  'Backspace',
  'Delete',
  'Space',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Up',
  'Down',
  'Left',
  'Right',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'Insert',
]);
const MODIFIERS = new Set(['Control', 'Ctrl', 'Shift', 'Alt', 'Option', 'Meta', 'Cmd', 'Command']);

/**
 * The key a `press` step sends, when it is safe to show: a named key (Enter, Escape, an arrow, F5) or a shortcut with
 * Control, Alt or Meta (Control+A). A bare character, or one with Shift alone, is typing, so it is never shown.
 */
export function namedKey(key: string): string | undefined {
  const parts = key.trim().split('+');
  const last = parts.at(-1) ?? '';
  const modifiers = parts.slice(0, -1);
  if (modifiers.some((part) => !MODIFIERS.has(part))) return undefined;
  if (NAMED_KEYS.has(last) || /^F\d{1,2}$/.test(last)) return parts.join('+');
  const chord = modifiers.some((part) => part !== 'Shift');
  return chord && /^[A-Za-z0-9]$/.test(last) ? parts.join('+') : undefined;
}

type Mood = 'done' | 'ask';

const VERBS: Record<ActAction, { done: string; ask: string }> = {
  click: { done: 'clicked', ask: 'click' },
  fill: { done: 'filled', ask: 'fill' },
  type: { done: 'typed in', ask: 'type in' },
  select: { done: 'chose an option in', ask: 'choose an option in' },
  hover: { done: 'hovered over', ask: 'hover over' },
  scroll: { done: 'scrolled', ask: 'scroll' },
  press: { done: 'pressed', ask: 'press' },
  wait: { done: 'waited', ask: 'wait' },
};

/** What a step does without its element: `clicked an element`, `scrolled the page`, `typed`, `pressed a key`. */
const WITHOUT_TARGET: Record<ActAction, { done: string; ask: string }> = {
  click: { done: 'clicked an element', ask: 'click an element' },
  fill: { done: 'filled a field', ask: 'fill a field' },
  type: { done: 'typed', ask: 'type' },
  select: { done: 'chose an option', ask: 'choose an option' },
  hover: { done: 'hovered over an element', ask: 'hover over an element' },
  scroll: { done: 'scrolled the page', ask: 'scroll the page' },
  press: { done: 'pressed a key', ask: 'press a key' },
  wait: { done: 'waited', ask: 'wait' },
};

const ARTICLE = /^[aeiou]/i;

/** An element in words: its name in quotes, or its role when it has none (`a button`). */
function targetWords(target: ActTarget): string {
  const name = plainName(target.name);
  if (name !== '') return `“${name}”`;
  const role = plainName(target.role) || 'element';
  return `${ARTICLE.test(role) ? 'an' : 'a'} ${role}`;
}

const joinAnd = (items: readonly string[]): string => (items.length < 2 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);

/**
 * The steps in words. `done` is for the work log, capitalised (`Filled “Name” and “Email”, clicked “Create account”`);
 * `ask` is for a prompt, after "wants to" (`fill “Name” and “Email”, click “Create account”`). Steps in a row with the same
 * verb share it; past three phrases the rest are "and more".
 */
export function actStepsText(steps: readonly ActStepSummary[], mood: Mood): string {
  const phrases: string[] = [];
  // Targets are told apart by their whole role and name, so two fields whose shortened names match are both listed.
  let last: { action: ActAction; targets: string[]; seen: Set<string> } | undefined;
  const flush = (): void => {
    if (last === undefined) return;
    phrases.push(`${VERBS[last.action][mood]} ${joinAnd(last.targets)}`);
    last = undefined;
  };
  for (const step of steps) {
    const key = step.action === 'press' && step.key !== undefined ? namedKey(step.key) : undefined;
    if (step.action === 'press' && key !== undefined) {
      if (last?.action === 'press') last.targets.push(key);
      else {
        flush();
        last = { action: 'press', targets: [key], seen: new Set() };
      }
      continue;
    }
    if (step.target === undefined || step.action === 'press' || step.action === 'wait') {
      flush();
      const words = WITHOUT_TARGET[step.action][mood];
      if (phrases.at(-1) !== words) phrases.push(words);
      continue;
    }
    const words = targetWords(step.target);
    const id = `${step.target.role}\n${step.target.name}`;
    if (last?.action === step.action) {
      if (!last.seen.has(id)) {
        last.seen.add(id);
        last.targets.push(words);
      }
    } else {
      flush();
      last = { action: step.action, targets: [words], seen: new Set([id]) };
    }
  }
  flush();
  if (phrases.length === 0) return mood === 'done' ? 'Acted' : 'act';
  const text = phrases.length > PHRASES_MAX ? `${phrases.slice(0, PHRASES_MAX - 1).join(', ')} and more` : phrases.join(', ');
  return mood === 'done' ? `${text[0]?.toUpperCase() ?? ''}${text.slice(1)}` : text;
}
