import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import type { T3Access as T3AccessView, T3Catalog } from '@t3-tab/protocol';

import { fetchCatalog, T3CatalogError } from './t3-catalog.js';
import { T3ConnectionError } from './t3-connection.js';
import { deleteCredential, readCredential, removeTemporaryCredentials, writeCredential, type T3Credential } from './t3-credential.js';
import { findT3Environment, type T3Environment } from './t3-environment.js';

/** The one scope T3 grants a client approved for "Read only" (`mcpClientScopes('read-only')` in T3 Code). */
export const T3_READ_SCOPE = 'orchestration:read';
const CLIENT_NAME = 'T3-Tab';
const SIGN_IN_TIMEOUT_MS = 10 * 60_000;
const HTTP_TIMEOUT_MS = 15_000;
const MAX_TOKEN_CHARS = 8_192;
// The panel asks every 2 seconds; after a failed fetch the lists are tried again at most once a minute unless asked.
const RETRY_MS = 60_000;

export interface T3AccessOptions {
  env: NodeJS.ProcessEnv;
  stateDir: string;
  /** Finds the T3 environment; tests pass their own. */
  findEnvironment?: (env: NodeJS.ProcessEnv) => Promise<T3Environment | { problem: string }>;
}

interface Metadata {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint: string;
}

interface PendingSignIn {
  environment: T3Environment;
  metadata: Metadata;
  clientId: string;
  redirectUri: string;
  state: string;
  verifier: string;
  server: Server;
  timer: ReturnType<typeof setTimeout>;
  /** An answer with the right state arrived; the code is being traded. */
  answered: boolean;
  finished: boolean;
}

/** An error whose message is safe to show: it names what failed, never a token, code or response body. */
class SignInError extends Error {}

/**
 * T3-Tab's own read-only sign-in to T3 Code, used only to list projects, providers and models for the side panel.
 *
 * T3's `/mcp` endpoint uses OAuth 2.1 for outside agents: discovery, dynamic client registration, and the
 * authorization code flow with PKCE (S256). The owner approves on T3's own page in a normal browser tab, choosing
 * the access level there; T3-Tab keeps the result only when T3 granted exactly `orchestration:read`. The answer comes
 * back to a one-use HTTP listener on 127.0.0.1 that checks `state` and closes after one answer. T3 issues no refresh
 * tokens: a sign-in lasts until T3 ends it (30 days), and then the owner signs in again.
 *
 * The verifier, the authorization code and the token stay in this process and the 0600 credential file. They are
 * never part of a view, an error message, a log line, a child's arguments or environment.
 */
export class T3Access {
  private pending: PendingSignIn | undefined;
  private catalog: { resource: string; value: T3Catalog } | undefined;
  private detail: string | undefined;
  private failed: { resource: string; at: number; detail: string } | undefined;
  private readonly findEnvironment: NonNullable<T3AccessOptions['findEnvironment']>;
  private closed = false;
  /** Writes and deletes of the credential file run one at a time, so a sign-out never races a sign-in's write. */
  private fileQueue: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: T3AccessOptions) {
    this.findEnvironment = options.findEnvironment ?? findT3Environment;
  }

  /** The sign-in state; the lists are fetched when asked, when none are held yet, or right after a sign-in. */
  async view(refresh = false): Promise<T3AccessView> {
    if (this.pending !== undefined && !this.pending.finished) {
      return this.withDetail({ state: 'signing-in', environment: this.pending.environment.origin });
    }
    const credential = await readCredential(this.options.stateDir);
    if (credential === undefined) {
      this.catalog = undefined;
      return this.withDetail({ state: 'signed-out' });
    }
    const view: T3AccessView = { state: 'signed-in', environment: credential.environment, expiresAt: credential.expiresAt };
    if (credential.expiresAt <= Date.now()) {
      await deleteCredential(this.options.stateDir);
      this.catalog = undefined;
      this.detail = 'The T3 Code sign-in expired. Sign in again to get the lists.';
      return this.withDetail({ state: 'signed-out' });
    }
    if (!refresh && this.catalog?.resource === credential.resource) return { ...view, catalog: this.catalog.value };
    if (!refresh && this.failed?.resource === credential.resource && Date.now() - this.failed.at < RETRY_MS) {
      return { ...view, detail: this.failed.detail };
    }
    const result = await this.fetchLists(credential, view);
    if (result.catalog === undefined && result.state === 'signed-in' && result.detail !== undefined) {
      this.failed = { resource: credential.resource, at: Date.now(), detail: result.detail };
    } else this.failed = undefined;
    return result;
  }

  private async fetchLists(credential: T3Credential, view: T3AccessView): Promise<T3AccessView> {
    const environment = await this.findEnvironment(this.options.env);
    if ('problem' in environment) return { ...view, detail: `${environment.problem} Type the project and model instead.` };
    if (environment.resource !== credential.resource) {
      return { ...view, detail: `T3 Code now runs at ${environment.origin}, not where T3-Tab signed in. Sign out, then sign in again.` };
    }
    try {
      const value = await fetchCatalog(credential.resource, credential.accessToken, environment.fetch);
      this.catalog = { resource: credential.resource, value };
      this.detail = undefined;
      return { ...view, catalog: value };
    } catch (error) {
      if (error instanceof T3CatalogError && error.unauthorized) {
        // T3 refused the token: it was revoked or ended. It is useless, so it is not kept.
        await deleteCredential(this.options.stateDir);
        this.catalog = undefined;
        this.detail = 'T3 Code no longer accepts T3-Tab\'s sign-in. Sign in again to get the lists.';
        return this.withDetail({ state: 'signed-out' });
      }
      const message = error instanceof T3CatalogError ? error.message : 'T3 Code\'s lists could not be fetched.';
      return this.catalog?.resource === credential.resource
        ? { ...view, catalog: this.catalog.value, detail: `${message} Showing the lists from before.` }
        : { ...view, detail: `${message} Type the project and model instead.` };
    }
  }

  /** Starts a sign-in and returns the T3 address the owner opens to approve it. A new sign-in replaces one in progress. */
  async signIn(): Promise<{ url: string }> {
    if (this.closed) throw new Error('T3-Tab is shutting down.');
    this.cancel();
    this.detail = undefined;
    const environment = await this.findEnvironment(this.options.env);
    if ('problem' in environment) throw new Error(`${environment.problem} Start T3 Code, then sign in.`);
    try {
      const metadata = await discover(environment);
      const server = createServer();
      await listenLoopback(server);
      const address = server.address();
      if (address === null || typeof address === 'string') {
        server.close();
        throw new SignInError('T3-Tab could not open its sign-in listener.');
      }
      const redirectUri = `http://127.0.0.1:${address.port}/callback`;
      let clientId: string;
      try {
        clientId = await register(environment, metadata, redirectUri);
      } catch (error) {
        server.close();
        throw error;
      }
      const verifier = randomBytes(32).toString('base64url');
      const state = randomBytes(32).toString('base64url');
      const pending: PendingSignIn = {
        environment,
        metadata,
        clientId,
        redirectUri,
        state,
        verifier,
        server,
        timer: setTimeout(() => this.finish(pending, 'The sign-in was not approved within 10 minutes. Sign in again.'), SIGN_IN_TIMEOUT_MS),
        answered: false,
        finished: false,
      };
      server.on('request', (request, response) => void this.answer(pending, address.port, request, response));
      this.pending = pending;
      const url = new URL(metadata.authorizationEndpoint);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('client_id', clientId);
      url.searchParams.set('redirect_uri', redirectUri);
      url.searchParams.set('code_challenge', createHash('sha256').update(verifier).digest('base64url'));
      url.searchParams.set('code_challenge_method', 'S256');
      url.searchParams.set('state', state);
      url.searchParams.set('resource', environment.resource);
      return { url: url.toString() };
    } catch (error) {
      throw new Error(isSafeError(error) ? error.message : `T3 Code at ${environment.origin} did not answer the sign-in.`);
    }
  }

  /**
   * Deletes the stored credential. T3 offers an outside client no way to revoke its own sign-in (revoking needs the
   * owner's access-management rights), so the owner can end it in T3 Code, or it ends on its own after 30 days.
   */
  async signOut(): Promise<T3AccessView> {
    this.cancel();
    const had = await this.onFile(async () => {
      const existed = (await readCredential(this.options.stateDir)) !== undefined;
      await deleteCredential(this.options.stateDir);
      await removeTemporaryCredentials(this.options.stateDir);
      return existed;
    });
    this.catalog = undefined;
    this.detail = had
      ? 'Signed out: T3-Tab deleted its T3 sign-in. To end it in T3 Code now, revoke T3-Tab in Settings → Sharing & access; otherwise it ends on its own within 30 days.'
      : undefined;
    return await this.view();
  }

  private onFile<T>(work: () => Promise<T>): Promise<T> {
    const run = this.fileQueue.then(work, work);
    this.fileQueue = run.catch(() => undefined);
    return run;
  }

  close(): void {
    this.closed = true;
    this.cancel();
  }

  private cancel(): void {
    if (this.pending !== undefined) this.finish(this.pending, undefined);
  }

  private withDetail(view: T3AccessView): T3AccessView {
    return this.detail === undefined ? view : { ...view, detail: this.detail };
  }

  private finish(pending: PendingSignIn, detail: string | undefined): void {
    if (pending.finished) return;
    pending.finished = true;
    clearTimeout(pending.timer);
    pending.server.close();
    // The answer page asks the browser to close its connection; anything else still open is idle.
    pending.server.closeIdleConnections();
    if (this.pending === pending) {
      this.pending = undefined;
      if (detail !== undefined) this.detail = detail;
    }
  }

  /** The browser's return from T3's approval page. Only the answer carrying this sign-in's `state` is used. */
  private async answer(pending: PendingSignIn, port: number, request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', `http://127.0.0.1:${port}`);
    if (request.headers.host !== `127.0.0.1:${port}` || request.method !== 'GET' || url.pathname !== '/callback') {
      page(response, 404, 'Not found.');
      return;
    }
    if (pending.finished || pending.answered || !sameSecret(url.searchParams.get('state'), pending.state)) {
      page(response, 400, 'This sign-in answer is not for the sign-in T3-Tab started. Start it again from the T3-Tab side panel.');
      return;
    }
    // Discovery required T3 to promise `iss` (RFC 9207), so an answer without it is refused like one from another server.
    if (url.searchParams.get('iss') !== pending.metadata.issuer) {
      page(response, 400, 'The sign-in answer did not come from this T3 Code. T3-Tab ignored it.');
      this.finish(pending, 'The sign-in answer did not come from this T3 Code, so T3-Tab ignored it. Sign in again.');
      return;
    }
    const code = url.searchParams.get('code');
    if (code === null || code === '') {
      const denied = url.searchParams.get('error') === 'access_denied';
      const detail = denied ? 'The sign-in was declined in T3 Code.' : 'T3 Code ended the sign-in without approving it.';
      page(response, 200, `${detail} You can close this tab.`);
      this.finish(pending, detail);
      return;
    }
    // Spent here: a second answer with the same state is refused above.
    pending.answered = true;
    let detail: string | undefined;
    try {
      const credential = await exchange(pending, code);
      // A sign-in replaced or cancelled meanwhile keeps nothing. Checked inside the file queue, so a sign-out that
      // started first has already cancelled it, and one that starts later deletes the file after this write.
      const kept = await this.onFile(async () => {
        if (pending.finished || this.pending !== pending || this.closed) return false;
        await writeCredential(this.options.stateDir, credential);
        return true;
      });
      if (kept) this.catalog = undefined;
      else detail = 'This sign-in was replaced or cancelled.';
    } catch (error) {
      detail = isSafeError(error) ? error.message : 'T3 Code did not complete the sign-in. Sign in again.';
    }
    page(response, detail === undefined ? 200 : 400, detail === undefined ? 'Signed in to T3 Code with read-only access. You can close this tab.' : detail);
    this.finish(pending, detail);
  }
}

/** Reads T3's OAuth metadata (RFC 9728, RFC 8414) and accepts only endpoints on the environment's own address. */
async function discover(environment: T3Environment): Promise<Metadata> {
  const resource = await getJson(environment, `${environment.origin}/.well-known/oauth-protected-resource/mcp`);
  const servers = Array.isArray(resource.authorization_servers) ? resource.authorization_servers : [];
  if (resource.resource !== environment.resource || servers[0] !== environment.origin) {
    throw new SignInError(`T3 Code at ${environment.origin} described a sign-in T3-Tab does not use.`);
  }
  const server = await getJson(environment, `${environment.origin}/.well-known/oauth-authorization-server`);
  const endpoints = [server.authorization_endpoint, server.token_endpoint, server.registration_endpoint];
  const methods = Array.isArray(server.code_challenge_methods_supported) ? server.code_challenge_methods_supported : [];
  const sameOrigin = (value: unknown): value is string => {
    if (typeof value !== 'string') return false;
    try {
      return new URL(value).origin === environment.origin;
    } catch {
      return false;
    }
  };
  if (
    server.issuer !== environment.origin ||
    !endpoints.every(sameOrigin) ||
    !methods.includes('S256') ||
    server.authorization_response_iss_parameter_supported !== true
  ) {
    throw new SignInError(`T3 Code at ${environment.origin} described a sign-in T3-Tab does not use.`);
  }
  return {
    issuer: environment.origin,
    authorizationEndpoint: server.authorization_endpoint as string,
    tokenEndpoint: server.token_endpoint as string,
    registrationEndpoint: server.registration_endpoint as string,
  };
}

/** Dynamic client registration (RFC 7591): T3 signs the client id; nothing secret comes back. */
async function register(environment: T3Environment, metadata: Metadata, redirectUri: string): Promise<string> {
  const response = await environment.fetch(metadata.registrationEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ client_name: CLIENT_NAME, redirect_uris: [redirectUri], token_endpoint_auth_method: 'none' }),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  const body = await response.json().catch(() => undefined);
  const clientId = typeof body === 'object' && body !== null ? (body as Record<string, unknown>).client_id : undefined;
  if (!response.ok || typeof clientId !== 'string' || clientId === '') {
    throw new SignInError(`T3 Code refused to register T3-Tab for a sign-in (HTTP ${response.status}).`);
  }
  return clientId;
}

/** Trades the code for a token with the PKCE verifier, and keeps it only when T3 granted exactly read-only access. */
async function exchange(pending: PendingSignIn, code: string): Promise<T3Credential> {
  const response = await pending.environment.fetch(pending.metadata.tokenEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: pending.redirectUri,
      client_id: pending.clientId,
      code_verifier: pending.verifier,
      resource: pending.environment.resource,
    }).toString(),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  }).catch((error: unknown) => {
    throw error instanceof T3ConnectionError ? error : new SignInError('T3 Code did not answer while finishing the sign-in. Sign in again.');
  });
  const body: unknown = await response.json().catch(() => undefined);
  const token = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
  if (!response.ok) throw new SignInError(`T3 Code refused to finish the sign-in (HTTP ${response.status}). Sign in again.`);
  if (
    typeof token.access_token !== 'string' ||
    token.access_token === '' ||
    token.access_token.length > MAX_TOKEN_CHARS ||
    typeof token.token_type !== 'string' ||
    token.token_type.toLowerCase() !== 'bearer' ||
    typeof token.expires_in !== 'number' ||
    !(token.expires_in > 0)
  ) {
    throw new SignInError('T3 Code answered the sign-in in a form T3-Tab does not understand.');
  }
  const scopes = typeof token.scope === 'string' ? token.scope.split(' ').filter(Boolean) : [];
  if (scopes.length !== 1 || scopes[0] !== T3_READ_SCOPE) {
    throw new SignInError(
      'T3 Code granted more than read-only access, so T3-Tab did not keep the sign-in. In T3 Code, revoke T3-Tab in Settings → Sharing & access, then sign in again and choose Read only.',
    );
  }
  return {
    version: 1,
    environment: pending.environment.origin,
    resource: pending.environment.resource,
    clientId: pending.clientId,
    accessToken: token.access_token,
    scope: T3_READ_SCOPE,
    expiresAt: Date.now() + token.expires_in * 1_000,
  };
}

async function getJson(environment: T3Environment, url: string): Promise<Record<string, unknown>> {
  const response = await environment.fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
  const body: unknown = response.ok ? await response.json().catch(() => undefined) : undefined;
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new SignInError(`T3 Code at ${new URL(url).origin} does not offer a sign-in for outside agents. Update T3 Code.`);
  }
  return body as Record<string, unknown>;
}

/** Errors whose fixed messages may be shown to the owner. */
function isSafeError(error: unknown): error is Error {
  return error instanceof SignInError || error instanceof T3ConnectionError;
}

function sameSecret(presented: string | null, expected: string): boolean {
  if (presented === null || presented.length !== expected.length) return false;
  let difference = 0;
  for (let index = 0; index < expected.length; index += 1) difference |= presented.charCodeAt(index) ^ expected.charCodeAt(index);
  return difference === 0;
}

/** A small page for the sign-in tab. Its script drops the code from the address bar and from this history entry. */
function page(response: ServerResponse, status: number, message: string): void {
  const text = message.replace(/[&<>"]/g, (character) => `&#${character.charCodeAt(0)};`);
  response.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    connection: 'close',
    'content-security-policy': "default-src 'none'; script-src 'sha256-" + REPLACE_SCRIPT_HASH + "'; frame-ancestors 'none'",
  });
  response.end(`<!doctype html><meta charset="utf-8"><title>T3-Tab sign-in</title><p>${text}</p><script>${REPLACE_SCRIPT}</script>`);
}

const REPLACE_SCRIPT = "history.replaceState(null,'','/done')";
const REPLACE_SCRIPT_HASH = createHash('sha256').update(REPLACE_SCRIPT).digest('base64');

async function listenLoopback(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
}
