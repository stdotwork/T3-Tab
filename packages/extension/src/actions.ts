import { actStepRef, type ActAction, type ActFailure, type ActStep, type PageActionResult } from '@t3-tab/protocol';

import {
  answerDialog,
  DialogOpenError,
  dialogNotice,
  documentEpoch,
  ensureAttached,
  holdInputFocus,
  navigationsSince,
  networkRevision,
  openDialog,
  sendCommand,
  setRecoveryOrigin,
} from './cdp';
import { readPage, rememberPageSecrets } from './page';
import { originOf } from './permissions';
import { scrollWithWheel } from './scroll';
import { scrubReported } from './secret-text';
import type { StoredSession } from './sessions';
import { resolveSessionTab } from './tabs';
import { settlePage, sleep } from './settle';

const MAX_WAIT_MS = 10_000;
const MAX_FOR_TEXT_MS = 10_000;
const TEXT_POLL_MS = 100;

interface BoxModel {
  model?: { border?: number[] };
}

interface ResolvedNode {
  object?: { objectId?: string };
}

interface EvaluateResult {
  result?: { value?: unknown; description?: string };
  exceptionDetails?: { text?: string; exception?: { description?: string } };
}

interface PixelPoint {
  x: number;
  y: number;
}

interface KeyStroke {
  key: string;
  code: string;
  keyCode: number;
  text?: string;
}

/** Runs one ordered batch through CDP, settles after each step that can start work and at the end, and returns the resulting page read. */
export async function actOnPage(
  session: StoredSession,
  tabId: number,
  steps: ActStep[],
  backendIds: Array<number | null>,
  expectedEpoch: number,
  expectedOrigin: string,
  reloadSession: () => Promise<StoredSession>,
): Promise<PageActionResult> {
  setRecoveryOrigin(tabId, expectedOrigin);
  await ensureAttached(tabId);
  let releaseFocus: (() => Promise<void>) | undefined;
  try {
    return await runSteps();
  } finally {
    await releaseFocus?.();
  }

  async function runSteps(): Promise<PageActionResult> {
  let epoch = documentEpoch(tabId);
  let failure: ActFailure | undefined;
  let activeSession = session;
  /** Field steps run since the last settle, each with the document epoch it started on. */
  let unsettled: Array<{ step: number; action: ActAction; epoch: number }> = [];
  /** Which field step replaced the page, when one did, so a later step's stale ref can say so. */
  let replacedNote: string | undefined;

  const assertAccessAfter = async (stepNumber: number, action: ActAction): Promise<void> => {
    try {
      activeSession = await reloadSession();
      await assertActAccess(activeSession, tabId, expectedOrigin);
    } catch (error) {
      throw new Error(
        `Step ${stepNumber} (${action}) left the page outside the approved session origin: ${messageOf(error)}`,
      );
    }
  };

  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index];
    if (step === undefined) continue;
    const action = actionOf(step);

    // Field changes since the last settle may have started work the page answers a moment later: a debounced check
    // that enables Submit, a navigation on a timer. Settle once before a step that acts on the page's answer, not
    // after each field.
    const pending = unsettled;
    if (pending.length > 0 && startsWork(action)) {
      const first = pending[0];
      const last = pending[pending.length - 1];
      if (first !== undefined && last !== undefined) {
        await settlePage(tabId);
        try {
          assertSameOriginSince(tabId, epoch, expectedOrigin, last.action);
        } catch (error) {
          failure = { step: last.step, action: last.action, error: messageOf(error) };
        }
        if (documentEpoch(tabId) !== first.epoch) {
          replacedNote =
            pending.length === 1
              ? `step ${first.step} (${first.action}) replaced the page`
              : `the page was replaced after the field changes in steps ${first.step} to ${last.step}`;
        }
        epoch = documentEpoch(tabId);
        unsettled = [];
        await assertAccessAfter(last.step, last.action);
        if (failure !== undefined) break;
      }
    }

    const networkBefore = networkRevision(tabId);
    const epochBefore = documentEpoch(tabId);
    try {
      activeSession = await reloadSession();
      await assertActAccess(activeSession, tabId, expectedOrigin);
      const ref = actStepRef(step);
      const dialog = openDialog(tabId);
      // A click or a key press can send a form, and a form that sends a field's value in the address puts it in the title and
      // address this reply shows: note the page's secret values first, as of this moment.
      if (dialog === undefined && (action === 'click' || action === 'press')) await rememberPageSecrets(tabId);
      if (dialog !== undefined) {
        await answerDialogStep(tabId, step, expectedOrigin);
      } else if (ref !== undefined) {
        releaseFocus ??= await holdInputFocus(tabId);
        // Live, not the value kept after the last settle: a step that skipped its settle may have replaced the document.
        const current = documentEpoch(tabId);
        if (current !== expectedEpoch) {
          throw staleRef(ref, `document epoch ${expectedEpoch} -> ${current}${replacedNote === undefined ? '' : `; ${replacedNote}`}`);
        }
        const backendId = backendIds[index];
        if (backendId === undefined || backendId === null) throw staleRef(ref, 'the ref has no DOM node id');
        await runElementStep(tabId, step, backendId, ref);
      } else {
        if (action !== 'wait') releaseFocus ??= await holdInputFocus(tabId);
        await runPageStep(tabId, step);
      }
      // CDP input goes to whatever document is current, with or without a ref. A new document on the
      // approved origin is fine (a key press that submits a form replaces it); one from another origin
      // may have taken the input, so the batch stops.
      if (action !== 'wait') assertSameOriginSince(tabId, epoch, expectedOrigin, action);
    } catch (error) {
      // The step ran and the page opened a dialog; the next step can answer it.
      if (!(error instanceof DialogOpenError)) {
        failure = {
          step: index + 1,
          action,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }

    const readFollows = index === steps.length - 1 || failure !== undefined;
    if (!readFollows && !startsWork(action)) {
      // The debugger reports a request or a navigation the step began a moment after its own reply, so ask for
      // one more answer from the page first; what it began is in by then.
      await sendCommand(tabId, 'Page.getLayoutMetrics').catch(() => undefined);
    }
    const moved = documentEpoch(tabId) !== epochBefore || networkRevision(tabId) !== networkBefore;
    const settles = readFollows || startsWork(action) || moved;
    if (settles) {
      await settlePage(tabId);
      unsettled = [];
    } else {
      unsettled.push({ step: index + 1, action, epoch: epochBefore });
    }
    if (!startsWork(action) && documentEpoch(tabId) !== epochBefore) replacedNote = `step ${index + 1} (${action}) replaced the page`;
    // Again after settling: a document from another origin that came and went (its navigation reported
    // after the input returned) ends on the approved origin, which the check below would not see. A step
    // that skipped its settle runs the check anyway; `epoch` stays where it was, so the next settle checks
    // everything since the last one.
    if (failure === undefined && action !== 'wait') {
      try {
        assertSameOriginSince(tabId, epoch, expectedOrigin, action);
      } catch (error) {
        failure = { step: index + 1, action, error: messageOf(error) };
      }
    }
    if (settles) epoch = documentEpoch(tabId);
    await assertAccessAfter(index + 1, action);
    if (failure !== undefined) break;
  }

  activeSession = await reloadSession();
  const waiting = openDialog(tabId);
  if (waiting !== undefined) {
    const tab = await resolveSessionTab(activeSession, tabId);
    return {
      tab: tabId,
      title: scrubReported(tabId, tab.title ?? '', false),
      url: scrubReported(tabId, tab.url ?? tab.pendingUrl ?? '', true),
      epoch: documentEpoch(tabId),
      nodes: [],
      dialog: dialogNotice(tabId, waiting),
      ...(failure === undefined ? {} : { failure }),
    };
  }
  const page = await readPage(activeSession, tabId, expectedOrigin, reloadSession);
  return failure === undefined ? page : { ...page, failure };
  }
}

/**
 * Whether a step acts on the page's answer or starts work of its own: a click, a key press, a scroll, a hover or a
 * wait. The others (fill, type, select) only change a field. They settle at the end of the batch, before the next step
 * of the kind above, and at once when the page showed that the step started something: a document replaced or a
 * network request begun while it ran.
 */
function startsWork(action: ActAction): boolean {
  return action !== 'fill' && action !== 'type' && action !== 'select';
}

/** While a dialog is open: Enter accepts it, Escape dismisses it, and `type` holds a prompt's text. */
async function answerDialogStep(tabId: number, step: ActStep, expectedOrigin: string): Promise<void> {
  const dialog = openDialog(tabId);
  if (dialog === undefined) return;
  const sameSite = originOf(dialog.url) === expectedOrigin && !dialogNotice(tabId, dialog).includes('another site');
  if ('wait' in step && 'ms' in step.wait) {
    await sleep(clamp(step.wait.ms, 0, MAX_WAIT_MS));
    return;
  }
  if ('type' in step && step.type.ref === undefined && dialog.type === 'prompt' && sameSite) {
    dialog.input = step.type.text;
    return;
  }
  const answer = 'press' in step ? plainKeyName(step.press.key) : undefined;
  if (answer === 'Escape') {
    await answerDialog(tabId, false, undefined, dialog);
    return;
  }
  if (answer === 'Enter' && sameSite) {
    await answerDialog(tabId, true, dialog.type === 'prompt' ? (dialog.input ?? dialog.defaultPrompt) : undefined, dialog);
    return;
  }
  throw new Error(dialogNotice(tabId, dialog));
}

function assertSameOriginSince(tabId: number, since: number, expectedOrigin: string, action: ActAction): void {
  const urls = navigationsSince(tabId, since);
  const foreign = urls === undefined ? 'an unknown page' : urls.find((url) => originOf(url) !== expectedOrigin);
  if (foreign === undefined) return;
  const where = urls === undefined ? foreign : (originOf(foreign) ?? foreign);
  throw new Error(
    `The page changed to ${where} during the ${action} step, so the input may not have reached the approved page. Read the page again.`,
  );
}

async function assertActAccess(session: StoredSession, tabId: number, expectedOrigin: string): Promise<void> {
  const tab = await resolveSessionTab(session, tabId);
  const actual = originOf(tab.url ?? tab.pendingUrl ?? '');
  if (actual !== expectedOrigin) {
    throw new Error(
      `The page moved from ${expectedOrigin} to ${actual ?? 'an unknown origin'}. Read the new page and approve it before acting there.`,
    );
  }
}

async function runElementStep(tabId: number, step: ActStep, backendId: number, ref: string): Promise<void> {
  switch (actionOf(step)) {
    case 'click': {
      const point = await elementPoint(tabId, backendId, ref);
      await clickAt(tabId, point);
      return;
    }
    case 'hover': {
      const point = await elementPoint(tabId, backendId, ref);
      await sendCommand(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
      return;
    }
    case 'fill':
      if (!('fill' in step)) return;
      await scrollElementIntoView(tabId, backendId, ref);
      await focusElement(tabId, backendId, ref);
      await selectContents(tabId, backendId, ref);
      if (step.fill.value === '') await pressKey(tabId, 'Backspace');
      else await sendCommand(tabId, 'Input.insertText', { text: step.fill.value });
      return;
    case 'type':
      if (!('type' in step)) return;
      if (step.type.ref !== undefined) {
        await scrollElementIntoView(tabId, backendId, ref);
        await focusElement(tabId, backendId, ref);
      }
      await sendCommand(tabId, 'Input.insertText', { text: step.type.text });
      return;
    case 'select':
      if (!('select' in step)) return;
      await scrollElementIntoView(tabId, backendId, ref);
      await selectOption(tabId, backendId, ref, step.select.value);
      return;
    case 'scroll':
      await scrollElementIntoView(tabId, backendId, ref);
      return;
    default:
      throw new Error(`The ${actionOf(step)} step does not take an element`);
  }
}

async function runPageStep(tabId: number, step: ActStep): Promise<void> {
  switch (actionOf(step)) {
    case 'type':
      if (!('type' in step)) return;
      await sendCommand(tabId, 'Input.insertText', { text: step.type.text });
      return;
    case 'press':
      if (!('press' in step)) return;
      await pressKey(tabId, step.press.key);
      return;
    case 'scroll':
      if (!('scroll' in step)) return;
      await scrollPage(tabId, step.scroll.dx ?? 0, step.scroll.dy ?? 0);
      return;
    case 'wait':
      if (!('wait' in step)) return;
      if ('ms' in step.wait) {
        await sleep(clamp(step.wait.ms, 0, MAX_WAIT_MS));
      } else {
        await waitForText(tabId, step.wait.for);
      }
      return;
    default:
      throw new Error(`The ${actionOf(step)} step needs a ref`);
  }
}

async function elementPoint(tabId: number, backendId: number, ref: string): Promise<PixelPoint> {
  await scrollElementIntoView(tabId, backendId, ref);
  let box: BoxModel;
  try {
    box = await sendCommand<BoxModel>(tabId, 'DOM.getBoxModel', { backendNodeId: backendId });
  } catch (error) {
    throw staleRef(ref, messageOf(error));
  }
  const quad = box.model?.border;
  if (quad === undefined || quad.length < 8) throw staleRef(ref, 'the element has no box');
  const [x1 = 0, y1 = 0, x2 = 0, y2 = 0, x3 = 0, y3 = 0, x4 = 0, y4 = 0] = quad;
  return { x: (x1 + x2 + x3 + x4) / 4, y: (y1 + y2 + y3 + y4) / 4 };
}

async function scrollElementIntoView(tabId: number, backendId: number, ref: string): Promise<void> {
  try {
    await sendCommand(tabId, 'DOM.scrollIntoViewIfNeeded', { backendNodeId: backendId });
  } catch (error) {
    throw staleRef(ref, messageOf(error));
  }
}

async function clickAt(tabId: number, point: PixelPoint): Promise<void> {
  const common = { x: point.x, y: point.y, button: 'left', clickCount: 1 };
  await sendCommand(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
  await sendCommand(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', ...common });
  await sendCommand(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', ...common });
}

async function focusElement(tabId: number, backendId: number, ref: string): Promise<void> {
  try {
    await sendCommand(tabId, 'DOM.focus', { backendNodeId: backendId });
  } catch (error) {
    throw staleRef(ref, messageOf(error));
  }
}

async function selectContents(tabId: number, backendId: number, ref: string): Promise<void> {
  let resolved: ResolvedNode;
  try {
    resolved = await sendCommand<ResolvedNode>(tabId, 'DOM.resolveNode', { backendNodeId: backendId });
  } catch (error) {
    throw staleRef(ref, messageOf(error));
  }
  const objectId = resolved.object?.objectId;
  if (objectId === undefined) throw staleRef(ref, 'the element has no JavaScript object');
  await sendCommand(tabId, 'Runtime.callFunctionOn', {
    objectId,
    functionDeclaration: `function () {
      if (typeof this.focus === 'function') this.focus();
      if (typeof this.select === 'function') {
        this.select();
        return;
      }
      const selection = getSelection();
      if (selection === null) return;
      const range = document.createRange();
      range.selectNodeContents(this);
      selection.removeAllRanges();
      selection.addRange(range);
    }`,
  });
}

async function selectOption(tabId: number, backendId: number, ref: string, value: string): Promise<void> {
  let resolved: ResolvedNode;
  try {
    resolved = await sendCommand<ResolvedNode>(tabId, 'DOM.resolveNode', { backendNodeId: backendId });
  } catch (error) {
    throw staleRef(ref, messageOf(error));
  }
  const objectId = resolved.object?.objectId;
  if (objectId === undefined) throw staleRef(ref, 'the element has no JavaScript object');
  const selected = await sendCommand<{ result?: { value?: unknown } }>(tabId, 'Runtime.callFunctionOn', {
    objectId,
    functionDeclaration: `function (wanted) {
      if (!(this instanceof HTMLSelectElement)) throw new Error('The selected element is not a select');
      const option = Array.from(this.options).find((item) =>
        item.value === wanted || item.label === wanted || item.text === wanted
      );
      if (!option) throw new Error('No option matches ' + JSON.stringify(wanted));
      this.value = option.value;
      this.dispatchEvent(new Event('input', { bubbles: true }));
      this.dispatchEvent(new Event('change', { bubbles: true }));
      return option.value;
    }`,
    arguments: [{ value }],
    returnByValue: true,
  });
  if (selected.result?.value === undefined) throw new Error(`Could not select ${JSON.stringify(value)}`);
}

async function scrollPage(tabId: number, dx: number, dy: number): Promise<void> {
  await scrollWithWheel(tabId, dx, dy);
}

async function pressKey(tabId: number, value: string): Promise<void> {
  const stroke = parseKey(value);
  const modifiers = modifierMask(value);
  const params: Record<string, unknown> = {
    key: stroke.key,
    code: stroke.code,
    windowsVirtualKeyCode: stroke.keyCode,
    nativeVirtualKeyCode: stroke.keyCode,
    modifiers,
  };
  if (stroke.text !== undefined) {
    params.text = stroke.text;
    params.unmodifiedText = stroke.text;
  }
  await sendCommand(tabId, 'Input.dispatchKeyEvent', {
    type: stroke.text === undefined ? 'rawKeyDown' : 'keyDown',
    ...params,
  });
  await sendCommand(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', ...params, text: undefined, unmodifiedText: undefined });
}

const KEYS: Record<string, KeyStroke> = {
  enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  insert: { key: 'Insert', code: 'Insert', keyCode: 45 },
  arrowup: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  arrowdown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  arrowright: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  home: { key: 'Home', code: 'Home', keyCode: 36 },
  end: { key: 'End', code: 'End', keyCode: 35 },
  pageup: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  pagedown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
  space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  shift: { key: 'Shift', code: 'ShiftLeft', keyCode: 16 },
  control: { key: 'Control', code: 'ControlLeft', keyCode: 17 },
  alt: { key: 'Alt', code: 'AltLeft', keyCode: 18 },
  meta: { key: 'Meta', code: 'MetaLeft', keyCode: 91 },
};
for (let number = 1; number <= 12; number += 1) {
  KEYS[`f${number}`] = { key: `F${number}`, code: `F${number}`, keyCode: 111 + number };
}
const KEY_ALIASES: Record<string, string> = {
  return: 'enter',
  esc: 'escape',
  del: 'delete',
  ins: 'insert',
  up: 'arrowup',
  down: 'arrowdown',
  left: 'arrowleft',
  right: 'arrowright',
  pgup: 'pageup',
  pgdn: 'pagedown',
  spacebar: 'space',
  ctrl: 'control',
  option: 'alt',
  cmd: 'meta',
  command: 'meta',
  super: 'meta',
  win: 'meta',
};

function keyPieces(value: string): string[] {
  // The space character itself, which trimming would lose.
  if (value !== '' && value.trim() === '') return [' '];
  const pieces = value.split('+').map((piece) => piece.trim()).filter((piece) => piece !== '');
  // "+" itself, alone or as the last key of a chord.
  if (value.trim().endsWith('+')) pieces.push('+');
  return pieces;
}

function namedKey(name: string): KeyStroke | undefined {
  const lower = name.toLowerCase();
  return KEYS[KEY_ALIASES[lower] ?? lower];
}

export function parseKey(value: string): KeyStroke {
  const name = keyPieces(value).at(-1);
  if (name === undefined) throw new Error('press needs a key such as Enter or Control+A');
  // One character is that character, in its case; only longer names are spellings of a named key.
  if (name.length === 1 && name !== ' ') {
    const upper = name.toUpperCase();
    return { key: name, code: /^[A-Z]$/.test(upper) ? `Key${upper}` : '', keyCode: upper.charCodeAt(0), text: name };
  }
  const named = name === ' ' ? KEYS.space : namedKey(name);
  if (named === undefined) throw new Error(`Unknown key: ${name}. Use a character or a name such as Enter, Escape, Tab, ArrowDown or F5.`);
  return named;
}

/** The key's standard name when `value` is one key with no modifiers, as a dialog's answer must be. */
function plainKeyName(value: string): string | undefined {
  const pieces = keyPieces(value);
  if (pieces[0] === ' ' && pieces.length === 1) return KEYS.space?.key;
  return pieces.length === 1 && pieces[0] !== undefined ? namedKey(pieces[0])?.key : undefined;
}

function modifierMask(value: string): number {
  const pieces = keyPieces(value).map((piece) => KEY_ALIASES[piece.toLowerCase()] ?? piece.toLowerCase());
  let mask = 0;
  if (pieces.includes('alt')) mask |= 1;
  if (pieces.includes('control')) mask |= 2;
  if (pieces.includes('meta')) mask |= 4;
  if (pieces.includes('shift')) mask |= 8;
  return mask;
}

async function waitForText(tabId: number, wanted: string): Promise<void> {
  const deadline = Date.now() + MAX_FOR_TEXT_MS;
  while (Date.now() < deadline) {
    const evaluated = await evaluate(tabId, `document.body?.innerText.includes(${JSON.stringify(wanted)}) === true`);
    if (evaluated.result === true) return;
    await sleep(TEXT_POLL_MS);
  }
  throw new Error(`Text ${JSON.stringify(wanted)} did not appear within ${MAX_FOR_TEXT_MS / 1_000} seconds`);
}

async function evaluate(tabId: number, expression: string): Promise<{ result?: unknown; exception?: string }> {
  const evaluated = await sendCommand<EvaluateResult>(tabId, 'Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (evaluated.exceptionDetails !== undefined) {
    throw new Error(evaluated.exceptionDetails.exception?.description ?? evaluated.exceptionDetails.text ?? 'JavaScript failed');
  }
  return evaluated.result?.value === undefined ? {} : { result: evaluated.result.value };
}

function actionOf(step: ActStep): ActAction {
  if ('click' in step) return 'click';
  if ('type' in step) return 'type';
  if ('fill' in step) return 'fill';
  if ('press' in step) return 'press';
  if ('select' in step) return 'select';
  if ('scroll' in step) return 'scroll';
  if ('hover' in step) return 'hover';
  return 'wait';
}

function staleRef(ref: string, detail?: string): Error {
  return new Error(`${ref} is no longer on the page; read again${detail === undefined ? '' : ` (${detail})`}`);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
