import { randomUUID } from 'node:crypto';

import {
  PROTOCOL_VERSION,
  type ControlResponse,
  type ToolMethod,
  type ToolSession,
} from '@t3-tab/protocol';
import { WebSocket, type RawData } from 'ws';

import { CLAIM_CODE } from './agents/claim-file.js';
import type { Agents } from './agents/conversations.js';
import type { BrowserConnection } from './browser-link.js';
import {
  isControlRequest,
  makeSessionName,
  parseClaimFileProblem,
  parseJson,
  sendControlError,
  validSession,
} from './daemon-messages.js';
import { answerPrompt, type TrackedPrompt } from './daemon-prompts.js';
import { runTool } from './tools.js';

const TOOL_METHODS: ReadonlySet<string> = new Set<ToolMethod>(['tabs', 'read', 'screenshot', 'act', 'run_js']);
// The browser's answer for a code it will never honour, as opposed to a moment it could not answer.
const CLAIM_REFUSED = /^Unknown claim code/;

/** What the daemon holds for one control connection: its session, and a claim code it registered with. */
export interface ControlState {
  sessions: Map<WebSocket, ToolSession>;
  claims: Map<WebSocket, string>;
  /** The redemption running for a connection, so simultaneous first tool calls share it. */
  redeeming: Map<WebSocket, Promise<void>>;
  /** Permission prompts told to a session, by prompt id, so only that session can answer them. */
  prompts: Map<string, TrackedPrompt>;
}

export function handleControlMessage(
  webSocket: WebSocket,
  browsers: Map<WebSocket, BrowserConnection>,
  control: ControlState,
  agents: Agents,
  data: RawData,
): void {
  const { sessions } = control;
  const value = parseJson(data);
  if (!isControlRequest(value)) {
    sendControlError(webSocket, null, 'Invalid control request');
    return;
  }

  const request = value;
  if (request.method === 'session.register') {
    if (sessions.has(webSocket)) {
      sendControlError(webSocket, request.requestId, 'Control connection is already registered');
      return;
    }
    if (typeof request.clientName !== 'string' || request.clientName.length > 160) {
      sendControlError(webSocket, request.requestId, 'Invalid client name');
      return;
    }
    if (request.claim !== undefined && (typeof request.claim !== 'string' || !CLAIM_CODE.test(request.claim))) {
      sendControlError(webSocket, request.requestId, 'Invalid claim code');
      return;
    }
    const claimFileProblem = parseClaimFileProblem(request.claimFileProblem);
    if (request.claimFileProblem !== undefined && claimFileProblem === undefined) {
      sendControlError(webSocket, request.requestId, 'Invalid claim file report');
      return;
    }
    const id = randomUUID();
    const session: ToolSession = { id, name: makeSessionName(request.clientName, id) };
    sessions.set(webSocket, session);
    if (claimFileProblem !== undefined) agents.claimFileFailed(claimFileProblem.file, claimFileProblem.problem);
    // Applied with the session's first tool call, once a browser is sure to have registered it.
    if (typeof request.claim === 'string') control.claims.set(webSocket, request.claim);
    const connection = [...browsers.values()].at(-1);
    if (connection !== undefined) void connection.request(session, 'session.register', {}).catch(() => undefined);
    webSocket.send(
      JSON.stringify({
        type: 'control.response',
        protocolVersion: PROTOCOL_VERSION,
        requestId: request.requestId,
        ok: true,
        result: { session },
      } satisfies ControlResponse),
    );
    return;
  }
  if (request.method === 'status') {
    const response: ControlResponse = {
      type: 'control.response',
      protocolVersion: PROTOCOL_VERSION,
      requestId: request.requestId,
      ok: true,
      result: { browsers: [...browsers.values()].map((connection) => connection.status) },
    };
    webSocket.send(JSON.stringify(response));
    return;
  }
  if (request.method === 'prompt.answer') {
    void answerPrompt(webSocket, browsers, control, request);
    return;
  }
  if (!TOOL_METHODS.has(request.method)) {
    sendControlError(webSocket, request.requestId, `Unknown method: ${String(request.method)}`);
    return;
  }
  void answerTool(webSocket, browsers, control, agents, request);
}

async function answerTool(
  webSocket: WebSocket,
  browsers: Map<WebSocket, BrowserConnection>,
  control: ControlState,
  agents: Agents,
  request: { requestId: string; method: string; session?: unknown; params?: unknown },
): Promise<void> {
  try {
    const registered = control.sessions.get(webSocket);
    if (registered === undefined) throw new Error('Session is not registered on this control connection');
    const claimed = validSession(request.session);
    if (claimed === undefined || claimed.id !== registered.id) {
      throw new Error('Session does not match this control connection');
    }
    if (typeof request.params !== 'object' || request.params === null || Array.isArray(request.params)) {
      throw new Error('Invalid params');
    }
    // The browser that connected last is the live one: an older socket may not have been cleaned up yet.
    const connection = [...browsers.values()].at(-1);
    if (connection === undefined) throw new Error('No browser is connected. Open the browser with the T3-Tab extension.');
    // Register only the session making this request. A new extension connection never learns other sessions.
    await connection.request(registered, 'session.register', {});
    await redeemClaim(webSocket, connection, registered, control, agents);
    const content = await runTool(connection, registered, request.method as ToolMethod, request.params as Record<string, unknown>);
    if (webSocket.readyState !== WebSocket.OPEN) return;
    const response: ControlResponse = {
      type: 'control.response',
      protocolVersion: PROTOCOL_VERSION,
      requestId: request.requestId,
      ok: true,
      result: { content },
    };
    webSocket.send(JSON.stringify(response));
  } catch (error) {
    if (webSocket.readyState === WebSocket.OPEN) {
      sendControlError(webSocket, request.requestId, error instanceof Error ? error.message : String(error));
    }
  }
}

/**
 * Redeems the code a direct run's MCP server carries. The tool still runs when the claim fails: the owner sees why
 * in the conversation, and a failure the browser may recover from is tried on the next call. Calls that arrive
 * during a redemption wait for it, so one session never redeems its code twice.
 */
async function redeemClaim(
  webSocket: WebSocket,
  connection: BrowserConnection,
  session: ToolSession,
  control: ControlState,
  agents: Agents,
): Promise<void> {
  const running = control.redeeming.get(webSocket);
  if (running !== undefined) {
    await running;
    return;
  }
  const claim = control.claims.get(webSocket);
  if (claim === undefined) return;
  const redemption = (async () => {
    try {
      await connection.request(session, 'session.claim', { code: claim, route: 'launch' });
      control.claims.delete(webSocket);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (CLAIM_REFUSED.test(reason)) control.claims.delete(webSocket);
      agents.claimFailed(claim, reason);
    } finally {
      control.redeeming.delete(webSocket);
    }
  })();
  control.redeeming.set(webSocket, redemption);
  await redemption;
}
