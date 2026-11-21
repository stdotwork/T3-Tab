import type { ActAction, ActFailure, ActStep, PageActionResult } from '@t3-tab/protocol';

import { documentEpoch, ensureAttached, sendCommand } from './cdp';
import { readPage } from './page';
import { originOf } from './permissions';
import type { StoredSession } from './sessions';
import { resolveSessionTab } from './tabs';
import { settlePage } from './settle';

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

/** Runs one ordered batch through CDP, settles after every step, and returns the resulting page read. */
export async function actOnPage(
  session: StoredSession,
  tabId: number,
  steps: ActStep[],
  backendIds: Array<number | null>,
  expectedEpoch: number,
  expectedOrigin: string,
  reloadSession: () => Promise<StoredSession>,
): Promise<PageActionResult> {
  await ensureAttached(tabId);
  await sendCommand(tabId, 'DOM.enable');
  let epoch = documentEpoch(tabId);
  let failure: ActFailure | undefined;
  let activeSession = session;

  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index];
    if (step === undefined) continue;
    const action = actionOf(step);
    try {
      activeSession = await reloadSession();
      await assertActAccess(activeSession, tabId, expectedOrigin);
      const ref = refOf(step);
      if (ref !== undefined) {
        if (epoch !== expectedEpoch) throw staleRef(ref, `document epoch ${expectedEpoch} -> ${epoch}`);
        const backendId = backendIds[index];
        if (backendId === undefined || backendId === null) throw staleRef(ref, 'the ref has no DOM node id');
        await runElementStep(tabId, step, backendId, ref);
      } else {
        await runPageStep(tabId, step);
        // Input without a ref goes to whatever document is current, so a replaced document is an error.
        if (action !== 'wait' && documentEpoch(tabId) !== epoch) {
          throw new Error(
            `The page was replaced while the ${action} step ran, so the input may not have reached the approved page. Read the page again.`,
          );
        }
      }
    } catch (error) {
      failure = {
        step: index + 1,
        action,
        error: error instanceof Error ? error.message : String(error),
      };
    }

    await settlePage(tabId);
    epoch = documentEpoch(tabId);
    try {
      activeSession = await reloadSession();
      await assertActAccess(activeSession, tabId, expectedOrigin);
    } catch (error) {
      throw new Error(
        `Step ${index + 1} (${action}) left the page outside the approved session origin: ${messageOf(error)}`,
      );
    }
    if (failure !== undefined) break;
  }

  activeSession = await reloadSession();
  const page = await readPage(activeSession, tabId, expectedOrigin, reloadSession);
  return failure === undefined ? page : { ...page, failure };
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
  const metrics = await sendCommand<{ cssLayoutViewport?: { clientWidth?: number; clientHeight?: number } }>(
    tabId,
    'Page.getLayoutMetrics',
  );
  const x = (metrics.cssLayoutViewport?.clientWidth ?? 800) / 2;
  const y = (metrics.cssLayoutViewport?.clientHeight ?? 600) / 2;
  await sendCommand(tabId, 'Input.dispatchMouseEvent', {
    type: 'mouseWheel',
    x,
    y,
    deltaX: dx,
    deltaY: dy,
  });
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

export function parseKey(value: string): KeyStroke {
  const pieces = value.split('+').map((piece) => piece.trim()).filter((piece) => piece !== '');
  const name = pieces.at(-1);
  if (name === undefined) throw new Error('press needs a key such as Enter or Control+A');
  const aliases: Record<string, KeyStroke> = {
    Enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
    Tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
    Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
    Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
    Delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
    ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
    ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
    ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
    ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
    Home: { key: 'Home', code: 'Home', keyCode: 36 },
    End: { key: 'End', code: 'End', keyCode: 35 },
    PageUp: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
    PageDown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
    Space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  };
  const named = aliases[name];
  if (named !== undefined) return named;
  if (name.length !== 1) throw new Error(`Unknown key: ${name}`);
  const upper = name.toUpperCase();
  return { key: name, code: /^[A-Z]$/.test(upper) ? `Key${upper}` : '', keyCode: upper.charCodeAt(0), text: name };
}

function modifierMask(value: string): number {
  const pieces = value.split('+').map((piece) => piece.trim().toLowerCase());
  let mask = 0;
  if (pieces.includes('alt')) mask |= 1;
  if (pieces.includes('control') || pieces.includes('ctrl')) mask |= 2;
  if (pieces.includes('meta') || pieces.includes('command') || pieces.includes('cmd')) mask |= 4;
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

function refOf(step: ActStep): string | undefined {
  if ('click' in step) return step.click.ref;
  if ('type' in step) return step.type.ref;
  if ('fill' in step) return step.fill.ref;
  if ('select' in step) return step.select.ref;
  if ('scroll' in step) return step.scroll.ref;
  if ('hover' in step) return step.hover.ref;
  return undefined;
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

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
