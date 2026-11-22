import {
  PROTOCOL_VERSION,
  type BrowserMessage,
  type ClaimFileProblem,
  type ControlResponse,
  type ToolSession,
} from '@t3-tab/protocol';
import type { RawData, WebSocket } from 'ws';

import { CLAIM_FILE_PROBLEMS } from './agents/claim-file.js';

const MAX_CLAIM_FILE_PATH = 4_096;

export function parseClaimFileProblem(value: unknown): { file: string; problem: ClaimFileProblem } | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const { file, problem } = value as Record<string, unknown>;
  if (typeof file !== 'string' || file === '' || file.length > MAX_CLAIM_FILE_PATH) return undefined;
  if (typeof problem !== 'string' || !CLAIM_FILE_PROBLEMS.has(problem)) return undefined;
  return { file, problem: problem as ClaimFileProblem };
}

export function isBrowserMessage(value: unknown): value is BrowserMessage {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.protocolVersion === PROTOCOL_VERSION &&
    (candidate.type === 'browser.hello' ||
      candidate.type === 'browser.ping' ||
      candidate.type === 'browser.pong' ||
      candidate.type === 'browser.tabCount' ||
      candidate.type === 'browser.tabClosed' ||
      (candidate.type === 'browser.daemonRequest' && typeof candidate.requestId === 'string' && typeof candidate.method === 'string') ||
      (candidate.type === 'browser.response' && typeof candidate.requestId === 'string' && typeof candidate.ok === 'boolean'))
  );
}

export function isOtherProtocolVersion(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const version = (value as Record<string, unknown>).protocolVersion;
  return typeof version === 'number' && version !== PROTOCOL_VERSION;
}

export function isControlRequest(value: unknown): value is {
  type: 'control.request';
  protocolVersion: typeof PROTOCOL_VERSION;
  requestId: string;
  method: string;
  clientName?: unknown;
  claim?: unknown;
  claimFileProblem?: unknown;
  session?: unknown;
  params?: unknown;
} {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.type === 'control.request' &&
    candidate.protocolVersion === PROTOCOL_VERSION &&
    typeof candidate.requestId === 'string' &&
    typeof candidate.method === 'string'
  );
}

export function makeSessionName(clientName: string, id: string): string {
  const visible = [...clientName]
    .map((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 32 || code === 127 ? ' ' : character;
    })
    .join('');
  const base = visible.replace(/\s+/g, ' ').trim().slice(0, 80) || 'MCP client';
  return `${base} · ${id.replace(/[^a-z0-9]/gi, '').slice(0, 8) || 'session'}`;
}

export function validSession(value: unknown): ToolSession | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.id !== 'string' || candidate.id === '' || candidate.id.length > 128) return undefined;
  if (typeof candidate.name !== 'string' || candidate.name === '' || candidate.name.length > 160) return undefined;
  return { id: candidate.id, name: candidate.name };
}

export function sendControlError(webSocket: WebSocket, requestId: string | null, error: string): void {
  const response: ControlResponse = {
    type: 'control.response',
    protocolVersion: PROTOCOL_VERSION,
    requestId,
    ok: false,
    error,
  };
  webSocket.send(JSON.stringify(response));
}

export function parseJson(data: RawData): unknown {
  try {
    return JSON.parse(data.toString());
  } catch {
    return null;
  }
}
