import { spawn as spawnProcess } from 'node:child_process';

import { T3_PANEL_CLIENT_LABEL, type T3Pairing, type T3SessionReply } from '@t3-tab/protocol';

import { firstLine } from './commands.js';
import { findT3 } from './locate.js';
import { run, STOP_GRACE_MS, type Spawn } from './process.js';
import { T3ConnectionError } from './t3-connection.js';
import { findT3Environment, type T3Environment } from './t3-environment.js';

const COMMAND_TIMEOUT_MS = 30_000;
const PAIRING_TTL = '5m';
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const THREAD_ID = /^[A-Za-z0-9][A-Za-z0-9_.:%-]{0,255}$/;
const PROOF = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const TOKEN = /^[\x21-\x7e]{1,8192}$/;
const TOKEN_EXCHANGE = 'urn:ietf:params:oauth:grant-type:token-exchange';
const ACCESS_TOKEN = 'urn:ietf:params:oauth:token-type:access_token';
const BOOTSTRAP_TOKEN = 'urn:t3:params:oauth:token-type:environment-bootstrap';
const REQUEST_TIMEOUT_MS = 10_000;

export interface T3PairingOptions {
  env: NodeJS.ProcessEnv;
  spawn?: Spawn;
  graceMs?: number;
}

/**
 * The side panel's T3 session, from the background program's side. The pairing credential is minted and spent here and
 * never reaches the panel, and every request that carries a credential or token goes through `confirmedFetch`, on a
 * connection the recorded T3 process was checked to hold. The panel signs each request's DPoP proof, so its key stays in
 * the browser. Nothing here is stored, logged or put in an error message.
 */
export class T3PanelPairing {
  private readonly spawn: Spawn;

  constructor(private readonly options: T3PairingOptions) {
    this.spawn = options.spawn ?? ((command, args, spawnOptions) => spawnProcess(command, args, spawnOptions));
  }

  async pair(value: unknown): Promise<T3Pairing> {
    const { origin, dpop } = (value ?? {}) as Record<string, unknown>;
    if (typeof origin !== 'string' || typeof dpop !== 'string' || !PROOF.test(dpop)) throw new Error('Invalid T3 pairing request');
    const t3 = await this.requireT3();
    const environment = await findT3Environment(this.options.env);
    if ('problem' in environment) throw new Error(environment.problem);
    if (environment.origin !== origin) throw new Error('T3 Code moved to another address. Try again.');
    // The credential will be sent to this address, so it is checked first: the process T3 recorded for it must hold the
    // connection that answers. Nothing is minted for an address that fails.
    try {
      const probe = await environment.fetch(`${environment.origin}/.well-known/oauth-authorization-server`, {
        signal: AbortSignal.timeout(5_000),
      });
      await probe.body?.cancel();
    } catch (error) {
      throw new Error(error instanceof T3ConnectionError ? error.message : `T3 Code at ${environment.origin} did not answer.`);
    }
    // Default scopes: a full client session, like T3's own apps. The label names the pairing in T3's access list.
    const result = await this.runT3(t3, ['auth', 'pairing', 'create', '--json', '--ttl', PAIRING_TTL, '--label', T3_PANEL_CLIENT_LABEL]);
    const printed = parseObject(result.stdout);
    const credential = printed?.credential;
    if (typeof credential !== 'string' || credential === '') throw new Error('t3 did not print a pairing credential.');
    const reply = await this.tokenRequest(environment, dpop, {
      grant_type: TOKEN_EXCHANGE,
      subject_token: credential,
      subject_token_type: BOOTSTRAP_TOKEN,
      requested_token_type: ACCESS_TOKEN,
      client_label: T3_PANEL_CLIENT_LABEL,
      client_device_type: 'desktop',
    });
    if (reply.outcome !== 'token') throw new Error(`T3 refused the sign-in (HTTP ${reply.outcome === 'refused' ? reply.status : 0}).`);
    return { origin: environment.origin, accessToken: reply.accessToken, expiresIn: reply.expiresIn };
  }

  /** Renews the panel's session or gets its WebSocket ticket. A stored address T3 no longer runs at gets nothing. */
  async session(value: unknown): Promise<T3SessionReply> {
    const { kind, origin, accessToken, dpop } = (value ?? {}) as Record<string, unknown>;
    if ((kind !== 'renew' && kind !== 'ticket') || typeof origin !== 'string') throw new Error('Invalid T3 session request');
    if (typeof accessToken !== 'string' || !TOKEN.test(accessToken) || typeof dpop !== 'string' || !PROOF.test(dpop)) {
      throw new Error('Invalid T3 session request');
    }
    const environment = await findT3Environment(this.options.env);
    if ('problem' in environment) throw new Error(environment.problem);
    if (environment.origin !== origin) return { outcome: 'moved' };
    if (kind === 'renew') {
      return await this.tokenRequest(environment, dpop, {
        grant_type: TOKEN_EXCHANGE,
        subject_token: accessToken,
        subject_token_type: ACCESS_TOKEN,
        requested_token_type: ACCESS_TOKEN,
      });
    }
    const response = await this.post(environment, '/api/auth/websocket-ticket/rpc', { authorization: `DPoP ${accessToken}`, dpop });
    if (!response.ok) {
      await response.body?.cancel();
      return { outcome: 'refused', status: response.status };
    }
    const { ticket } = (await response.json()) as { ticket?: unknown };
    if (typeof ticket !== 'string' || ticket === '') throw new Error('T3 sent no connection ticket.');
    return { outcome: 'ticket', ticket };
  }

  /** The thread's runtime mode as T3 reports it now. A failure throws, and the caller treats that as not confirmed. */
  async threadMode(threadId: unknown): Promise<{ runtimeMode: string }> {
    if (typeof threadId !== 'string' || !THREAD_ID.test(threadId)) throw new Error('Invalid thread id');
    const t3 = await this.requireT3();
    const result = await this.runT3(t3, ['thread', 'show', '--json', '--messages', '1', threadId]);
    const thread = parseObject(result.stdout)?.thread;
    const runtimeMode = typeof thread === 'object' && thread !== null ? (thread as { runtimeMode?: unknown }).runtimeMode : undefined;
    if (typeof runtimeMode !== 'string') throw new Error('t3 reported no runtime mode.');
    return { runtimeMode };
  }

  private async tokenRequest(environment: T3Environment, dpop: string, form: Record<string, string>): Promise<T3SessionReply> {
    const response = await this.post(environment, '/oauth/token', { 'content-type': 'application/x-www-form-urlencoded', dpop }, new URLSearchParams(form).toString());
    if (!response.ok) {
      await response.body?.cancel();
      return { outcome: 'refused', status: response.status };
    }
    const { access_token: accessToken, expires_in: expiresIn } = (await response.json()) as { access_token?: unknown; expires_in?: unknown };
    if (typeof accessToken !== 'string' || accessToken === '' || typeof expiresIn !== 'number') throw new Error('T3 sent no access token.');
    return { outcome: 'token', accessToken, expiresIn };
  }

  private async post(environment: T3Environment, path: string, headers: Record<string, string>, body?: string): Promise<Response> {
    try {
      return await environment.fetch(`${environment.origin}${path}`, {
        method: 'POST',
        headers,
        ...(body === undefined ? {} : { body }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw new Error(error instanceof T3ConnectionError ? error.message : `T3 Code at ${environment.origin} did not answer.`);
    }
  }

  /** Revokes every T3 session labelled as the panel's. */
  async unpair(): Promise<{ revoked: number }> {
    const t3 = await this.requireT3();
    const listed = await this.runT3(t3, ['auth', 'session', 'list', '--json']);
    let sessions: unknown;
    try {
      sessions = JSON.parse(listed.stdout);
    } catch {
      throw new Error('t3 printed no session list.');
    }
    const ids = (Array.isArray(sessions) ? sessions : []).flatMap((entry): string[] => {
      const { sessionId, client } = (entry ?? {}) as { sessionId?: unknown; client?: { label?: unknown } | null };
      return typeof sessionId === 'string' && SESSION_ID.test(sessionId) && client?.label === T3_PANEL_CLIENT_LABEL ? [sessionId] : [];
    });
    let revoked = 0;
    for (const id of ids) {
      await this.runT3(t3, ['auth', 'session', 'revoke', id]);
      revoked += 1;
    }
    return { revoked };
  }

  private async requireT3(): Promise<string> {
    const path = await findT3(this.options.env);
    if (path === undefined) throw new Error('T3 Code was not found.');
    return path;
  }

  /** A failure names the command's own first error line. stdout is never part of an error: it can hold the credential. */
  private async runT3(path: string, args: string[]): Promise<{ stdout: string }> {
    const result = await run(this.spawn, path, args, {
      env: this.options.env,
      timeoutMs: COMMAND_TIMEOUT_MS,
      graceMs: this.options.graceMs ?? STOP_GRACE_MS,
    });
    if (result.code !== 0) throw new Error(firstLine(result.stderr) || `t3 exited with code ${String(result.code)}`);
    return result;
  }
}

function parseObject(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text.trim());
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}
