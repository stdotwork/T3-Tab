/**
 * The panel's own T3 client session, like the one T3's phone app holds: a pairing credential the helper minted is
 * exchanged for a DPoP-bound access token. The private key is created non-extractable and stays in this extension's
 * IndexedDB, so the stored token is useless without it. T3 renews such a session for up to 30 days.
 */
import { panel, readStored, removeStored, writeStored } from './api';

const SESSION_KEY = 't3.session';
const TOKEN_EXCHANGE = 'urn:ietf:params:oauth:grant-type:token-exchange';
const ACCESS_TOKEN = 'urn:ietf:params:oauth:token-type:access_token';
const BOOTSTRAP_TOKEN = 'urn:t3:params:oauth:token-type:environment-bootstrap';
const RENEW_BEFORE_MS = 10 * 60_000;

export const CLIENT_LABEL = 'T3-Tab panel';

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

async function exchange(origin: string, form: Record<string, string>, keys: CryptoKeyPair): Promise<T3Session> {
  const url = `${origin}/oauth/token`;
  const response = await fetch(url, {
    method: 'POST',
    credentials: 'omit',
    redirect: 'error',
    headers: { 'content-type': 'application/x-www-form-urlencoded', dpop: await proof(keys, 'POST', url) },
    body: new URLSearchParams(form),
  });
  if (!response.ok) throw new SessionRefused(`T3 refused the sign-in (HTTP ${response.status}).`, response.status);
  const body = (await response.json()) as { access_token: string; expires_in: number };
  const session = { origin, accessToken: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
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

/** One click: the helper mints a pairing credential and this panel becomes a T3 client. */
export async function pairWithT3(): Promise<T3Session> {
  const { origin, credential } = await panel<{ origin: string; credential: string }>({ type: 'panel.t3Pair' });
  const keys = await proofKeys(true);
  if (keys === undefined) throw new Error('Could not create the session key');
  return await exchange(
    origin,
    {
      grant_type: TOKEN_EXCHANGE,
      subject_token: credential,
      subject_token_type: BOOTSTRAP_TOKEN,
      requested_token_type: ACCESS_TOKEN,
      client_label: CLIENT_LABEL,
      client_device_type: 'desktop',
    },
    keys,
  );
}

export async function forgetSession(): Promise<void> {
  await removeStored(SESSION_KEY);
  await withKeys('readwrite', (store) => store.delete('dpop')).catch(() => undefined);
}

async function fresh(session: T3Session, keys: CryptoKeyPair): Promise<T3Session> {
  if (session.expiresAt - Date.now() > RENEW_BEFORE_MS) return session;
  return await exchange(
    session.origin,
    {
      grant_type: TOKEN_EXCHANGE,
      subject_token: session.accessToken,
      subject_token_type: ACCESS_TOKEN,
      requested_token_type: ACCESS_TOKEN,
    },
    keys,
  );
}

/** A one-use WebSocket address for T3's RPC endpoint, renewing the session first when it is close to expiry. */
export async function socketUrl(current: T3Session): Promise<{ url: string; session: T3Session }> {
  const keys = await proofKeys(false);
  if (keys === undefined) throw new SessionRefused('The session key is gone.', 401);
  const session = await fresh(current, keys);
  const ticketUrl = `${session.origin}/api/auth/websocket-ticket/rpc`;
  const response = await fetch(ticketUrl, {
    method: 'POST',
    credentials: 'omit',
    redirect: 'error',
    headers: { authorization: `DPoP ${session.accessToken}`, dpop: await proof(keys, 'POST', ticketUrl, session.accessToken) },
  });
  if (!response.ok) throw new SessionRefused(`T3 refused the connection (HTTP ${response.status}).`, response.status);
  const { ticket } = (await response.json()) as { ticket: string };
  const socket = new URL(`${session.origin.replace(/^http/, 'ws')}/ws`);
  socket.searchParams.set('wsTicket', ticket);
  socket.searchParams.set('orchestrationProtocol', '2');
  socket.searchParams.set('clientSurface', 'web');
  socket.searchParams.set('dpop', await proof(keys, 'GET', `${session.origin}/ws`, ticket));
  return { url: socket.href, session };
}
