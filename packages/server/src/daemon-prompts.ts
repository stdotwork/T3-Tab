import {
  PROTOCOL_VERSION,
  type BrowserPromptClosedMessage,
  type BrowserPromptOpenedMessage,
  type ControlEvent,
  type ControlResponse,
  type ElicitedDecision,
  type PromptNotice,
} from '@t3-tab/protocol';
import { WebSocket } from 'ws';

import type { BrowserConnection } from './browser-link.js';
import type { ControlState } from './daemon-control.js';
import { sendControlError, validSession } from './daemon-messages.js';

const PROMPT_TOOLS: ReadonlySet<string> = new Set(['read', 'act', 'run_js', 'open']);
const MAX_TITLE_CHARS = 300;
const MAX_ORIGIN_CHARS = 2_048;

/** A permission prompt the daemon told a session about, and the browser connection that holds it. */
export interface TrackedPrompt {
  sessionId: string;
  browser: WebSocket;
}

export function isPromptOpenedMessage(value: unknown): value is BrowserPromptOpenedMessage {
  return typeof value === 'object' && value !== null && (value as { type?: unknown }).type === 'browser.promptOpened';
}

export function isPromptClosedMessage(value: unknown): value is BrowserPromptClosedMessage {
  return typeof value === 'object' && value !== null && (value as { type?: unknown }).type === 'browser.promptClosed';
}

/** Checks a prompt notice the browser sent. A page controls its own title, so the title is cut to a fixed length. */
export function parsePromptNotice(value: unknown): PromptNotice | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const { id, tool, origin, tab } = value as Record<string, unknown>;
  if (typeof id !== 'string' || id === '' || id.length > 128) return undefined;
  if (typeof tool !== 'string' || !PROMPT_TOOLS.has(tool)) return undefined;
  if (typeof origin !== 'string' || origin === '' || origin.length > MAX_ORIGIN_CHARS) return undefined;
  if (typeof tab !== 'object' || tab === null) return undefined;
  const { id: tabId, title } = tab as Record<string, unknown>;
  if (!Number.isInteger(tabId) || typeof title !== 'string') return undefined;
  return { id, tool: tool as PromptNotice['tool'], origin, tab: { id: tabId as number, title: title.slice(0, MAX_TITLE_CHARS) } };
}

function sendEvent(webSocket: WebSocket, event: ControlEvent): void {
  if (webSocket.readyState === WebSocket.OPEN) webSocket.send(JSON.stringify(event));
}

/** Tells the session a prompt belongs to, and only that session's connection, that the prompt is waiting. */
export function promptOpened(control: ControlState, browser: WebSocket, message: BrowserPromptOpenedMessage): void {
  const session = validSession(message.session);
  const prompt = parsePromptNotice(message.prompt);
  if (session === undefined || prompt === undefined) return;
  for (const [webSocket, registered] of control.sessions) {
    if (registered.id !== session.id) continue;
    control.prompts.set(prompt.id, { sessionId: session.id, browser });
    sendEvent(webSocket, { type: 'control.event', protocolVersion: PROTOCOL_VERSION, event: 'prompt.opened', prompt });
    return;
  }
}

/** The prompt is over, however it ended. */
export function promptClosed(control: ControlState, promptId: unknown): void {
  if (typeof promptId !== 'string') return;
  const tracked = control.prompts.get(promptId);
  if (tracked === undefined) return;
  control.prompts.delete(promptId);
  for (const [webSocket, registered] of control.sessions) {
    if (registered.id === tracked.sessionId) {
      sendEvent(webSocket, { type: 'control.event', protocolVersion: PROTOCOL_VERSION, event: 'prompt.closed', promptId });
    }
  }
}

/** A browser connection went away, and with it the prompts it held. */
export function browserPromptsGone(control: ControlState, browser: WebSocket): void {
  for (const [id, tracked] of control.prompts) {
    if (tracked.browser === browser) promptClosed(control, id);
  }
}

/**
 * A session's own answer to one of its prompts. It is passed on only when the prompt belongs to the session bound to
 * this connection; the browser checks that again before it decides.
 */
export async function answerPrompt(
  webSocket: WebSocket,
  browsers: Map<WebSocket, BrowserConnection>,
  control: ControlState,
  request: { requestId: string; promptId?: unknown; decision?: unknown },
): Promise<void> {
  try {
    const registered = control.sessions.get(webSocket);
    if (registered === undefined) throw new Error('Session is not registered on this control connection');
    if (typeof request.promptId !== 'string') throw new Error('Invalid permission request');
    if (request.decision !== 'allow-once' && request.decision !== 'decline') throw new Error('Invalid answer');
    const tracked = control.prompts.get(request.promptId);
    if (tracked === undefined || tracked.sessionId !== registered.id) throw new Error('No such permission request for this session');
    const connection = browsers.get(tracked.browser);
    if (connection === undefined) throw new Error('The browser is not connected');
    await connection.request(registered, 'prompt.decide', { promptId: request.promptId, decision: request.decision as ElicitedDecision });
    if (webSocket.readyState !== WebSocket.OPEN) return;
    webSocket.send(
      JSON.stringify({
        type: 'control.response',
        protocolVersion: PROTOCOL_VERSION,
        requestId: request.requestId,
        ok: true,
        result: { answered: true },
      } satisfies ControlResponse),
    );
  } catch (error) {
    if (webSocket.readyState === WebSocket.OPEN) sendControlError(webSocket, request.requestId, error instanceof Error ? error.message : String(error));
  }
}
