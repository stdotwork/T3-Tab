import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { T3_PANEL_CLIENT_LABEL } from '@t3-tab/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { T3PanelPairing } from '../src/agents/t3-pairing.js';

const CREDENTIAL = 'SECRETPAIRING9';

let root: string;
let env: NodeJS.ProcessEnv;
let server: Server | undefined;
let requests: Recorded[];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 't3-tab-pairing-'));
  await mkdir(join(root, 'home'), { recursive: true });
  await mkdir(join(root, 'bin'), { recursive: true });
  env = { HOME: join(root, 'home'), PATH: join(root, 'bin'), T3CODE_HOME: join(root, 't3') };
  requests = [];
});

afterEach(async () => {
  if (server !== undefined) {
    const running = server;
    running.closeAllConnections();
    await new Promise((resolve) => running.close(resolve));
    server = undefined;
  }
  await rm(root, { recursive: true, force: true });
});

interface Recorded {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/** What the listener answers to a POST; a test sets it before it asks. */
let postAnswer: { status: number; body: unknown };

/** A T3 that listens in this process, so the pid T3-Tab checks is this one. `storedOrigin` is what its runtime file says. */
async function runningT3(pid = process.pid, storedOrigin?: (listening: string) => string): Promise<string> {
  server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      requests.push({ method: request.method ?? '', url: request.url ?? '', headers: request.headers, body: Buffer.concat(chunks).toString('utf8') });
      if (request.method === 'POST') {
        response.statusCode = postAnswer.status;
        response.end(JSON.stringify(postAnswer.body));
      } else response.end('{}');
    });
  });
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  const address = server?.address();
  if (address === null || address === undefined || typeof address === 'string') throw new Error('no address');
  const origin = `http://127.0.0.1:${address.port}`;
  await mkdir(join(root, 't3', 'userdata'), { recursive: true });
  await writeFile(
    join(root, 't3', 'userdata', 'server-runtime.json'),
    JSON.stringify({ version: 1, origin: storedOrigin?.(origin) ?? origin, pid, startedAt: new Date().toISOString() }),
  );
  return origin;
}

/** A `t3` that records its arguments and answers with what the test gives it. */
async function fakeT3(script: string): Promise<string> {
  const log = join(root, 'calls');
  const path = join(root, 'bin', 't3');
  await writeFile(path, `#!/bin/sh\necho "$*" >> "${log}"\n${script}\n`);
  await chmod(path, 0o755);
  return log;
}

const calls = async (log: string): Promise<string[]> => (await readFile(log, 'utf8').catch(() => '')).split('\n').filter((line) => line !== '');

const DPOP = 'aaa.bbb.ccc';
const TOKEN_ANSWER = { access_token: 'ACCESS1', expires_in: 3600, token_type: 'DPoP' };
const mintsCredential = `printf '{"id":"p1","credential":"${CREDENTIAL}","label":"x","scopes":[],"expiresAt":"2026-11-23T00:05:00.000Z"}'`;

describe('pairing the panel with T3 Code', () => {
  it('mints a five-minute credential, spends it itself on the checked connection and returns only the session', async () => {
    const origin = await runningT3();
    postAnswer = { status: 200, body: TOKEN_ANSWER };
    const log = await fakeT3(mintsCredential);
    const pairing = await new T3PanelPairing({ env }).pair({ origin, dpop: DPOP });
    expect(pairing).toEqual({ origin, accessToken: 'ACCESS1', expiresIn: 3600 });
    expect(JSON.stringify(pairing)).not.toContain(CREDENTIAL);
    expect(await calls(log)).toEqual([`auth pairing create --json --ttl 5m --label ${T3_PANEL_CLIENT_LABEL}`]);
    // A probe first, then the token request carrying the panel's proof and the credential as the subject token.
    expect(requests.map(({ method, url }) => `${method} ${url}`)).toEqual(['GET /.well-known/oauth-authorization-server', 'POST /oauth/token']);
    const token = requests[1];
    expect(token?.headers.dpop).toBe(DPOP);
    expect(token?.headers['content-type']).toBe('application/x-www-form-urlencoded');
    const form = new URLSearchParams(token?.body);
    expect(form.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:token-exchange');
    expect(form.get('subject_token')).toBe(CREDENTIAL);
    expect(form.get('subject_token_type')).toBe('urn:t3:params:oauth:token-type:environment-bootstrap');
    expect(form.get('requested_token_type')).toBe('urn:ietf:params:oauth:token-type:access_token');
    expect(form.get('client_label')).toBe(T3_PANEL_CLIENT_LABEL);
  });

  it('mints nothing and sends nothing when the recorded process does not own the listener', async () => {
    const origin = await runningT3(process.ppid);
    postAnswer = { status: 200, body: TOKEN_ANSWER };
    const log = await fakeT3(mintsCredential);
    await expect(new T3PanelPairing({ env }).pair({ origin, dpop: DPOP })).rejects.toThrow('could not confirm that the running T3 Code owns its address');
    expect(await calls(log)).toEqual([]);
    expect(requests).toEqual([]);
  });

  it('mints nothing when T3 now runs at another address than the panel asked for', async () => {
    await runningT3();
    const log = await fakeT3(mintsCredential);
    await expect(new T3PanelPairing({ env }).pair({ origin: 'http://127.0.0.1:1', dpop: DPOP })).rejects.toThrow('moved to another address');
    expect(await calls(log)).toEqual([]);
    expect(requests).toEqual([]);
  });

  it('refuses a request without an origin or a well-formed proof before running anything', async () => {
    const origin = await runningT3();
    const log = await fakeT3(mintsCredential);
    for (const value of [undefined, {}, { origin }, { origin, dpop: 'not a proof' }, { origin, dpop: 5 }, { origin: 5, dpop: DPOP }]) {
      await expect(new T3PanelPairing({ env }).pair(value)).rejects.toThrow('Invalid T3 pairing request');
    }
    expect(await calls(log)).toEqual([]);
    expect(requests).toEqual([]);
  });

  it('says T3 is not running, or not found, without running anything', async () => {
    const log = await fakeT3('exit 0');
    await expect(new T3PanelPairing({ env }).pair({ origin: 'http://127.0.0.1:1', dpop: DPOP })).rejects.toThrow('T3 Code is not running.');
    await rm(join(root, 'bin', 't3'));
    await expect(new T3PanelPairing({ env }).pair({ origin: 'http://127.0.0.1:1', dpop: DPOP })).rejects.toThrow('T3 Code was not found.');
    expect(await calls(log)).toEqual([]);
  });

  it('never puts the credential in an error', async () => {
    const origin = await runningT3();
    postAnswer = { status: 200, body: TOKEN_ANSWER };
    await fakeT3(`printf 'not json ${CREDENTIAL}'`);
    const failure = await new T3PanelPairing({ env }).pair({ origin, dpop: DPOP }).then(() => new Error('paired'), (error: unknown) => error as Error);
    expect(failure.message).toBe('t3 did not print a pairing credential.');
    expect(failure.message).not.toContain(CREDENTIAL);
    await fakeT3(`printf '${CREDENTIAL}'; echo 'refused' >&2; exit 3`);
    const refused = await new T3PanelPairing({ env }).pair({ origin, dpop: DPOP }).then(() => new Error('paired'), (error: unknown) => error as Error);
    expect(refused.message).toBe('refused');
    // T3 itself refuses the exchange: the error carries the status and not the credential.
    await fakeT3(mintsCredential);
    postAnswer = { status: 400, body: { error: 'invalid_grant', detail: CREDENTIAL } };
    const exchange = await new T3PanelPairing({ env }).pair({ origin, dpop: DPOP }).then(() => new Error('paired'), (error: unknown) => error as Error);
    expect(exchange.message).toBe('T3 refused the sign-in (HTTP 400).');
    expect(exchange.message).not.toContain(CREDENTIAL);
  });
});

describe('the panel\'s T3 session requests', () => {
  it('sends a renewal to the token endpoint with the proof, the old token as subject, and returns the new token', async () => {
    const origin = await runningT3();
    postAnswer = { status: 200, body: { access_token: 'ACCESS2', expires_in: 100 } };
    const reply = await new T3PanelPairing({ env }).session({ kind: 'renew', origin, accessToken: 'ACCESS1', dpop: DPOP });
    expect(reply).toEqual({ outcome: 'token', accessToken: 'ACCESS2', expiresIn: 100 });
    expect(requests).toHaveLength(1);
    const [request] = requests;
    expect(`${request?.method} ${request?.url}`).toBe('POST /oauth/token');
    expect(request?.headers.dpop).toBe(DPOP);
    expect(request?.headers['content-type']).toBe('application/x-www-form-urlencoded');
    const form = new URLSearchParams(request?.body);
    expect(Object.fromEntries(form)).toEqual({
      grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
      subject_token: 'ACCESS1',
      subject_token_type: 'urn:ietf:params:oauth:token-type:access_token',
      requested_token_type: 'urn:ietf:params:oauth:token-type:access_token',
    });
  });

  it('sends a ticket request to the WebSocket ticket path with a DPoP authorization and returns the ticket', async () => {
    const origin = await runningT3();
    postAnswer = { status: 200, body: { ticket: 'TICKET1' } };
    const reply = await new T3PanelPairing({ env }).session({ kind: 'ticket', origin, accessToken: 'ACCESS1', dpop: DPOP });
    expect(reply).toEqual({ outcome: 'ticket', ticket: 'TICKET1' });
    expect(requests).toHaveLength(1);
    const [request] = requests;
    expect(`${request?.method} ${request?.url}`).toBe('POST /api/auth/websocket-ticket/rpc');
    expect(request?.headers.authorization).toBe('DPoP ACCESS1');
    expect(request?.headers.dpop).toBe(DPOP);
    expect(request?.body).toBe('');
  });

  it('returns moved and sends nothing when the stored origin is not the one T3 runs at now', async () => {
    const origin = await runningT3();
    postAnswer = { status: 200, body: TOKEN_ANSWER };
    for (const kind of ['renew', 'ticket'] as const) {
      expect(await new T3PanelPairing({ env }).session({ kind, origin: 'http://127.0.0.1:1', accessToken: 'ACCESS1', dpop: DPOP })).toEqual({ outcome: 'moved' });
    }
    expect(origin).not.toBe('http://127.0.0.1:1');
    expect(requests).toEqual([]);
  });

  it('sends nothing and rejects when another process owns the listener', async () => {
    const origin = await runningT3(process.ppid);
    postAnswer = { status: 200, body: TOKEN_ANSWER };
    for (const kind of ['renew', 'ticket'] as const) {
      await expect(new T3PanelPairing({ env }).session({ kind, origin, accessToken: 'ACCESS1', dpop: DPOP })).rejects.toThrow(
        'could not confirm that the running T3 Code owns its address',
      );
    }
    expect(requests).toEqual([]);
  });

  it('reports T3\'s HTTP refusal as a status, for a renewal and for a ticket', async () => {
    const origin = await runningT3();
    postAnswer = { status: 401, body: { error: 'invalid_token' } };
    for (const kind of ['renew', 'ticket'] as const) {
      expect(await new T3PanelPairing({ env }).session({ kind, origin, accessToken: 'ACCESS1', dpop: DPOP })).toEqual({ outcome: 'refused', status: 401 });
    }
  });

  it('refuses invalid parameters before connecting', async () => {
    const origin = await runningT3();
    postAnswer = { status: 200, body: TOKEN_ANSWER };
    const base = { kind: 'renew', origin, accessToken: 'ACCESS1', dpop: DPOP };
    for (const value of [
      undefined,
      {},
      { ...base, kind: 'pair' },
      { ...base, origin: 5 },
      { ...base, accessToken: '' },
      { ...base, accessToken: 'has a space' },
      { ...base, accessToken: 7 },
      { ...base, dpop: 'nope' },
      { ...base, dpop: undefined },
    ]) {
      await expect(new T3PanelPairing({ env }).session(value), JSON.stringify(value)).rejects.toThrow('Invalid T3 session request');
    }
    expect(requests).toEqual([]);
  });
});

describe('a thread\'s runtime mode', () => {
  it('runs t3 thread show for that thread only and returns the mode it printed', async () => {
    const log = await fakeT3(`printf '{"thread":{"id":"th1","runtimeMode":"full-access"},"messages":[]}'`);
    expect(await new T3PanelPairing({ env }).threadMode('th1')).toEqual({ runtimeMode: 'full-access' });
    expect(await calls(log)).toEqual(['thread show --json --messages 0 th1']);
  });

  it('refuses ids that start with a dash or hold a space before running anything', async () => {
    const log = await fakeT3(`printf '{"thread":{"runtimeMode":"full-access"}}'`);
    for (const id of ['-rf', '--project', 'a b', '', 'a\nb', 5, undefined]) {
      await expect(new T3PanelPairing({ env }).threadMode(id), String(id)).rejects.toThrow('Invalid thread id');
    }
    expect(await calls(log)).toEqual([]);
  });

  it('throws when the output has no mode, is not JSON or the command fails', async () => {
    await fakeT3(`printf '{"thread":{"id":"th1"}}'`);
    await expect(new T3PanelPairing({ env }).threadMode('th1')).rejects.toThrow('t3 reported no runtime mode.');
    await fakeT3(`printf '{"thread":{"runtimeMode":5}}'`);
    await expect(new T3PanelPairing({ env }).threadMode('th1')).rejects.toThrow('t3 reported no runtime mode.');
    await fakeT3(`printf 'garbage'`);
    await expect(new T3PanelPairing({ env }).threadMode('th1')).rejects.toThrow('t3 reported no runtime mode.');
    await fakeT3(`echo 'no such thread' >&2; exit 2`);
    await expect(new T3PanelPairing({ env }).threadMode('th1')).rejects.toThrow('no such thread');
  });
});

describe('ending the panel\'s T3 sessions', () => {
  const session = (sessionId: string, label: string): unknown => ({ sessionId, client: { label }, scopes: [] });

  it('revokes exactly the sessions the panel opened', async () => {
    const log = await fakeT3(
      `if [ "$3" = list ]; then printf '%s' '${JSON.stringify([session('a1', T3_PANEL_CLIENT_LABEL), session('b2', 'T3-Tab'), session('c3', 'Phone'), session('d4', T3_PANEL_CLIENT_LABEL), session('-rf', T3_PANEL_CLIENT_LABEL)])}'; fi`,
    );
    expect(await new T3PanelPairing({ env }).unpair()).toEqual({ revoked: 2 });
    expect(await calls(log)).toEqual(['auth session list --json', 'auth session revoke a1', 'auth session revoke d4']);
  });

  it('reports a list it cannot read, and a revoke that fails', async () => {
    await fakeT3(`if [ "$3" = list ]; then printf 'oops'; fi`);
    await expect(new T3PanelPairing({ env }).unpair()).rejects.toThrow('t3 printed no session list.');
    await fakeT3(`if [ "$3" = list ]; then printf '%s' '${JSON.stringify([session('a1', T3_PANEL_CLIENT_LABEL)])}'; else echo 'no such session' >&2; exit 1; fi`);
    await expect(new T3PanelPairing({ env }).unpair()).rejects.toThrow('no such session');
  });

  it('revokes nothing when no session carries the label', async () => {
    const log = await fakeT3(`if [ "$3" = list ]; then printf '[]'; fi`);
    expect(await new T3PanelPairing({ env }).unpair()).toEqual({ revoked: 0 });
    expect(await calls(log)).toEqual(['auth session list --json']);
  });
});
