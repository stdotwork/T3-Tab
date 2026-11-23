/**
 * The panel's own T3 client session, like the one T3's phone app holds. The helper mints a pairing credential and spends
 * it on a connection it checked is T3's; the panel only signs the DPoP proofs. The private key is created non-extractable
 * and stays in this extension's IndexedDB, so the stored token is useless without it. T3 renews such a session for up to
 * 30 days. The WebSocket is the one connection the helper cannot check, because the browser opens it.
 */
import type { T3Pairing, T3SessionReply } from '@t3-tab/protocol';

import { panel, readStored, removeStored, writeStored } from './api';

const SESSION_KEY = 't3.session';
const RENEW_BEFORE_MS = 10 * 60_000;

export interface T3Session {
  origin: string;
  accessToken: string;
  expiresAt: number;
}

const base64url = (bytes: ArrayBuffer | Uint8Array): string => {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = '';
  for (const byte of view) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
};
const encode = (text: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(text);

function keyDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open('t3-tab-session', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('keys');
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error ?? new Error('Could not open the key store'));
  });
}

async function withKeys<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const database = await keyDatabase();
  try {
    return await new Promise<T>((resolve, reject) => {
      const request = action(database.transaction('keys', mode).objectStore('keys'));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('The key store failed'));
    });
  } finally {
    database.close();
  }
}

async function proofKeys(create: boolean): Promise<CryptoKeyPair | undefined> {
  const stored = await withKeys<CryptoKeyPair | undefined>('readonly', (store) => store.get('dpop') as IDBRequest<CryptoKeyPair | undefined>);
  if (stored !== undefined || !create) return stored;
  const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  await withKeys('readwrite', (store) => store.put(keys, 'dpop'));
  return keys;
}

async function proof(keys: CryptoKeyPair, method: string, url: string, boundToken?: string): Promise<string> {
  const { crv, kty, x, y } = await crypto.subtle.exportKey('jwk', keys.publicKey);
  const target = new URL(url);
  const payload: Record<string, unknown> = {
    htm: method,
    htu: `${target.protocol}//${target.host}${target.pathname}`,
    jti: crypto.randomUUID(),
    iat: Math.floor(Date.now() / 1000),
  };
  if (boundToken !== undefined) payload.ath = base64url(await crypto.subtle.digest('SHA-256', encode(boundToken)));
  const signingInput = `${base64url(encode(JSON.stringify({ typ: 'dpop+jwt', alg: 'ES256', jwk: { crv, kty, x, y } })))}.${base64url(encode(JSON.stringify(payload)))}`;
  const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.privateKey, encode(signingInput));
  return `${signingInput}.${base64url(signature)}`;
}

async function keep(session: T3Session): Promise<T3Session> {
  await writeStored(SESSION_KEY, session);
  return session;
}

export class SessionRefused extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export async function storedSession(): Promise<T3Session | undefined> {
  return await readStored<T3Session>(SESSION_KEY);
}

/** One click: the helper pairs with T3 and this panel becomes a T3 client. */
export async function pairWithT3(): Promise<T3Session> {
  const { t3 } = await panel<{ t3: { origin?: string } }>({ type: 'panel.setup', refresh: true });
  if (t3.origin === undefined) throw new Error('T3 Code is not running.');
  const keys = await proofKeys(true);
  if (keys === undefined) throw new Error('Could not create the session key');
  const dpop = await proof(keys, 'POST', `${t3.origin}/oauth/token`);
  const paired = await panel<T3Pairing>({ type: 'panel.t3Pair', origin: t3.origin, dpop });
  return await keep({ origin: paired.origin, accessToken: paired.accessToken, expiresAt: Date.now() + paired.expiresIn * 1000 });
}

export async function forgetSession(): Promise<void> {
  await removeStored(SESSION_KEY);
  await withKeys('readwrite', (store) => store.delete('dpop')).catch(() => undefined);
}

function refusal(reply: Extract<T3SessionReply, { outcome: 'refused' | 'moved' }>): SessionRefused {
  if (reply.outcome === 'moved') return new SessionRefused('T3 Code moved to another address. Connect again.', 401);
  return new SessionRefused(reply.status === 401 ? 'T3 ended this session. Connect again.' : `T3 refused the connection (HTTP ${reply.status}).`, reply.status);
}

async function fresh(session: T3Session, keys: CryptoKeyPair): Promise<T3Session> {
  if (session.expiresAt - Date.now() > RENEW_BEFORE_MS) return session;
  const reply = await panel<T3SessionReply>({
    type: 'panel.t3Session',
    kind: 'renew',
    origin: session.origin,
    accessToken: session.accessToken,
    dpop: await proof(keys, 'POST', `${session.origin}/oauth/token`),
  });
  if (reply.outcome === 'refused' || reply.outcome === 'moved') throw refusal(reply);
  if (reply.outcome !== 'token') throw new Error('T3 sent no new session.');
  return await keep({ origin: session.origin, accessToken: reply.accessToken, expiresAt: Date.now() + reply.expiresIn * 1000 });
}

/** A one-use WebSocket address for T3's RPC endpoint, renewing the session first when it is close to expiry. */
export async function socketUrl(current: T3Session): Promise<{ url: string; session: T3Session }> {
  const keys = await proofKeys(false);
  if (keys === undefined) throw new SessionRefused('The session key is gone. Connect again.', 401);
  const session = await fresh(current, keys);
  const reply = await panel<T3SessionReply>({
    type: 'panel.t3Session',
    kind: 'ticket',
    origin: session.origin,
    accessToken: session.accessToken,
    dpop: await proof(keys, 'POST', `${session.origin}/api/auth/websocket-ticket/rpc`, session.accessToken),
  });
  if (reply.outcome === 'refused' || reply.outcome === 'moved') throw refusal(reply);
  if (reply.outcome !== 'ticket') throw new Error('T3 sent no connection ticket.');
  const socket = new URL(`${session.origin.replace(/^http/, 'ws')}/ws`);
  socket.searchParams.set('wsTicket', reply.ticket);
  socket.searchParams.set('orchestrationProtocol', '2');
  socket.searchParams.set('clientSurface', 'web');
  socket.searchParams.set('dpop', await proof(keys, 'GET', `${session.origin}/ws`, reply.ticket));
  return { url: socket.href, session };
}
