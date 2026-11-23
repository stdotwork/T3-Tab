import { spawn as spawnProcess } from 'node:child_process';

import { T3_PANEL_CLIENT_LABEL, type T3Pairing } from '@t3-tab/protocol';

import { firstLine } from './commands.js';
import { findT3 } from './locate.js';
import { run, STOP_GRACE_MS, type Spawn } from './process.js';
import { T3ConnectionError } from './t3-connection.js';
import { findT3Environment } from './t3-environment.js';

const COMMAND_TIMEOUT_MS = 30_000;
const PAIRING_TTL = '5m';
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

export interface T3PairingOptions {
  env: NodeJS.ProcessEnv;
  spawn?: Spawn;
  graceMs?: number;
}

/**
 * Gives the side panel a one-time credential for its own connection to T3 Code, and ends the sessions it opened.
 * The credential goes to the panel and nowhere else: it is not stored, logged or put in an error message.
 */
export class T3PanelPairing {
  private readonly spawn: Spawn;

  constructor(private readonly options: T3PairingOptions) {
    this.spawn = options.spawn ?? ((command, args, spawnOptions) => spawnProcess(command, args, spawnOptions));
  }

  async pair(): Promise<T3Pairing> {
    const t3 = await this.requireT3();
    const environment = await findT3Environment(this.options.env);
    if ('problem' in environment) throw new Error(environment.problem);
    // The panel will connect to this address with the credential, so the address is checked first: the process T3
    // recorded for it must hold the connection that answers. Nothing is minted for an address that fails.
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
    const value = parseObject(result.stdout);
    const credential = value?.credential;
    const expiresAt = value?.expiresAt;
    if (typeof credential !== 'string' || credential === '' || typeof expiresAt !== 'string') {
      throw new Error('t3 did not print a pairing credential.');
    }
    return { origin: environment.origin, credential, expiresAt };
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
