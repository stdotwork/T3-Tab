// A fake T3 Code environment for T3-Tab's sign-in: the OAuth metadata, client registration, authorize, approval page,
// token endpoint and the `/mcp` endpoint that T3's outside agents use, with the same paths, checks and answers as T3
// Code (apps/server/src/auth/McpOAuth.ts, mcpOAuthHttp.ts, mcp/McpHttpServer.ts and the project and orchestrator
// toolkits). Tokens and codes are random per run. It never talks to a real T3.
//
// `redirectMatches` and the 401 answer's body and challenge are adapted from T3 Code
// (https://github.com/pingdotgg/t3code, apps/server/src/auth/McpOAuth.ts and apps/server/src/mcp/McpHttpServer.ts),
// MIT License, Copyright (c) 2026 T3 Tools Inc. Changed: rewritten in plain JavaScript without Effect.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const READ = 'orchestration:read';
const OPERATE = 'orchestration:operate';
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
const NOW = '2026-11-20T10:00:00.000Z';

export const FAKE_PROJECTS = [
  project('proj-demo', 'Demo app', '/work/demo', { instanceId: 'claudeAgent', model: 'claude-sonnet-5-5' }),
  project('proj-docs', 'Docs site', '/work/docs', null),
  project('proj-api', 'API server', '/work/api', { instanceId: 'codex', model: 'gpt-5.3-codex' }),
  { ...project('proj-old', 'Old archived thing', '/work/old', null), archivedAt: NOW },
];

export const FAKE_CAPABILITIES = {
  parentThreadId: null,
  inheritedProviderInstanceId: null,
  inheritedModel: null,
  inheritedOptions: [],
  runtimeMode: 'approval-required',
  interactionMode: 'default',
  providers: [
    {
      providerInstanceId: 'claudeAgent',
      driverKind: 'claudeAgent',
      displayName: 'Claude',
      models: [
        { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5' },
        { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5', options: [{ id: 'effort', values: ['low', 'high'], default: 'low' }] },
      ],
      omittedModels: 3,
      runtimeModes: ['approval-required', 'full-access'],
      canRunChildTask: true,
      canRunCrossProviderChildTask: true,
      constraints: [],
    },
    {
      providerInstanceId: 'codex',
      driverKind: 'codex',
      displayName: null,
      models: [{ id: 'gpt-5.3-codex' }],
      canRunChildTask: true,
      canRunCrossProviderChildTask: false,
      constraints: [],
    },
    {
      providerInstanceId: 'opencode',
      driverKind: 'opencode',
      displayName: 'OpenCode',
      models: [{ id: 'big-pickle' }],
      canRunChildTask: false,
      canRunCrossProviderChildTask: false,
      constraints: ['Provider executable is not installed.'],
    },
  ],
  features: {
    appOwnedSubagents: true,
    asyncPolling: true,
    cancellation: true,
    batchThreadCreation: true,
    threadManagement: true,
    incrementalThreadRead: true,
    scheduledTasks: true,
    maxBatchThreads: 8,
  },
};

const TOOLS = [
  { name: 't3_project_list', description: 'List projects. Pages can shift.', annotations: { readOnlyHint: true } },
  { name: 'orchestrator_capabilities', description: 'List providers, models, options, and runtime modes.', annotations: { readOnlyHint: true } },
  { name: 't3_thread_launch', description: 'Start a thread.', annotations: { destructiveHint: true } },
].map((tool) => ({ ...tool, inputSchema: { type: 'object', properties: {} } }));

/**
 * Starts the fake on 127.0.0.1. `pageSize` caps a project page, to exercise paging. `advertiseIss: false` leaves
 * `authorization_response_iss_parameter_supported` out of the metadata; `callbackIss` makes the answer to the sign-in
 * carry the right issuer, another one (`wrong`) or none (`missing`).
 */
export async function startFakeT3({ pageSize = 100, advertiseIss = true, callbackIss = 'right' } = {}) {
  const clients = new Set();
  const codes = new Map();
  const tokens = new Map();
  const sessions = new Map();
  const issued = [];
  const log = [];
  let origin = '';

  const server = createServer((request, response) => {
    void handle(request, response).catch((error) => {
      if (!response.headersSent) response.writeHead(500, { 'content-type': 'text/plain' });
      response.end(String(error));
    });
  });

  async function handle(request, response) {
    const url = new URL(request.url ?? '/', origin);
    const authorization = request.headers.authorization;
    log.push({ method: request.method, path: url.pathname, bearer: typeof authorization === 'string' ? authorization.replace(/^Bearer /, '') : undefined });
    const path = url.pathname;
    if (request.method === 'GET' && (path === '/.well-known/oauth-protected-resource' || path === '/.well-known/oauth-protected-resource/mcp')) {
      return json(response, 200, {
        resource: `${origin}/mcp`,
        authorization_servers: [origin],
        scopes_supported: [READ, OPERATE],
        bearer_methods_supported: ['header'],
        resource_name: 'T3 Code',
      });
    }
    if (request.method === 'GET' && path === '/.well-known/oauth-authorization-server') {
      return json(response, 200, {
        issuer: origin,
        authorization_endpoint: `${origin}/oauth/mcp/authorize`,
        token_endpoint: `${origin}/oauth/mcp/token`,
        registration_endpoint: `${origin}/oauth/mcp/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
        scopes_supported: [READ, OPERATE],
        ...(advertiseIss ? { authorization_response_iss_parameter_supported: true } : {}),
      });
    }
    if (request.method === 'POST' && path === '/oauth/mcp/register') {
      const body = JSON.parse((await readBody(request)) || '{}');
      const redirectUris = Array.isArray(body.redirect_uris) ? body.redirect_uris : [];
      if (redirectUris.length === 0 || redirectUris.length > 5 || !redirectUris.every(isAllowedRedirect)) {
        return json(response, 400, { error: 'invalid_redirect_uri', error_description: 'Redirect URIs must be https, or http on localhost.' });
      }
      const name = String(body.client_name ?? '').trim().slice(0, 100) || 'MCP client';
      const clientId = `${Buffer.from(JSON.stringify({ v: 1, n: name, r: redirectUris })).toString('base64url')}.${randomBytes(16).toString('base64url')}`;
      clients.add(clientId);
      return json(response, 201, {
        client_id: clientId,
        client_name: name,
        redirect_uris: redirectUris,
        grant_types: ['authorization_code'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      });
    }
    if (request.method === 'GET' && path === '/oauth/mcp/authorize') {
      const checked = validateAuthorization(Object.fromEntries(url.searchParams));
      if (checked.page !== undefined) return html(response, 400, checked.page);
      if (checked.redirect !== undefined) return redirect(response, checked.redirect);
      return redirect(response, `/connect-agent${url.search}`);
    }
    if (request.method === 'GET' && path === '/connect-agent') {
      const checked = validateAuthorization(Object.fromEntries(url.searchParams));
      if (checked.page !== undefined) return html(response, 400, checked.page);
      const hidden = [...url.searchParams].map(([key, value]) => `<input type="hidden" name="${escape(key)}" value="${escape(value)}">`).join('');
      const button = (access, label) => `<form method="post" action="/oauth/mcp/decision">${hidden}<input type="hidden" name="decision" value="${access}"><button>${label}</button></form>`;
      return html(
        response,
        200,
        `<h1>Connect an agent</h1><p>${escape(checked.client.name)} wants access. It returns to ${escape(new URL(checked.redirectUri).host)}.</p>` +
          button('read-only', 'Approve: Read only') +
          button('full-access', 'Approve: Full access') +
          button('deny', 'Deny'),
      );
    }
    if (request.method === 'POST' && path === '/oauth/mcp/decision') {
      const form = Object.fromEntries(new URLSearchParams(await readBody(request)));
      const { decision, ...authorization } = form;
      const checked = validateAuthorization(authorization);
      if (checked.page !== undefined) return html(response, 400, checked.page);
      if (checked.redirect !== undefined) return redirect(response, checked.redirect);
      if (decision === 'deny') return redirect(response, withParams(checked.redirectUri, { error: 'access_denied', state: authorization.state, iss: answerIssuer() }));
      if (decision !== 'read-only' && decision !== 'full-access') return html(response, 400, 'Unknown decision');
      const code = randomBytes(32).toString('base64url');
      codes.set(code, {
        clientId: checked.client.id,
        redirectUri: checked.redirectUri,
        challenge: authorization.code_challenge,
        resource: `${origin}/mcp`,
        access: decision,
        expiresAt: Date.now() + 60_000,
      });
      return redirect(response, withParams(checked.redirectUri, { code, state: authorization.state, iss: answerIssuer() }));
    }
    if (request.method === 'POST' && path === '/oauth/mcp/token') {
      const form = Object.fromEntries(new URLSearchParams(await readBody(request)));
      const fail = (error, description) => json(response, 400, { error, error_description: description });
      if (form.grant_type !== 'authorization_code') return fail('unsupported_grant_type', 'Only authorization_code is supported.');
      if (!form.code || !form.redirect_uri || !form.client_id || !form.code_verifier) return fail('invalid_request', 'Missing fields.');
      if (!clients.has(form.client_id)) return fail('invalid_client', 'The client is unknown.');
      const pending = codes.get(form.code);
      codes.delete(form.code);
      const verifies =
        /^[A-Za-z0-9\-._~]{43,128}$/.test(form.code_verifier) &&
        createHash('sha256').update(form.code_verifier).digest('base64url') === pending?.challenge;
      if (
        pending === undefined ||
        pending.expiresAt <= Date.now() ||
        pending.clientId !== form.client_id ||
        pending.redirectUri !== form.redirect_uri ||
        (form.resource !== undefined && form.resource !== pending.resource) ||
        !verifies
      ) {
        return fail('invalid_grant', 'The authorization code is invalid or expired.');
      }
      const token = randomBytes(32).toString('base64url');
      tokens.set(token, pending.access);
      issued.push(token);
      return json(response, 200, {
        access_token: token,
        token_type: 'Bearer',
        expires_in: 30 * 24 * 60 * 60,
        scope: pending.access === 'read-only' ? READ : `${READ} ${OPERATE}`,
      });
    }
    if (path === '/mcp') {
      const token = typeof authorization === 'string' && authorization.startsWith('Bearer ') ? authorization.slice(7) : undefined;
      const access = token === undefined ? undefined : tokens.get(token);
      if (access === undefined) {
        response.writeHead(401, {
          'content-type': 'application/json',
          'cache-control': 'no-store',
          'www-authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"${token === undefined ? '' : ', error="invalid_token"'}`,
        });
        return response.end(JSON.stringify({ error: 'invalid_mcp_credential', message: 'A valid T3 Code MCP credential is required.' }));
      }
      const sessionId = request.headers['mcp-session-id'];
      let transport = typeof sessionId === 'string' ? sessions.get(sessionId) : undefined;
      if (transport === undefined) {
        if (typeof sessionId === 'string') return json(response, 404, { error: 'Unknown session' });
        transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID(), onsessioninitialized: (id) => sessions.set(id, transport) });
        transport.onclose = () => {
          if (transport.sessionId !== undefined) sessions.delete(transport.sessionId);
        };
        await mcpServer(access).connect(transport);
      }
      const body = request.method === 'POST' ? JSON.parse(await readBody(request)) : undefined;
      return await transport.handleRequest(request, response, body);
    }
    html(response, 404, 'Not found');
  }

  function answerIssuer() {
    if (callbackIss === 'missing') return undefined;
    return callbackIss === 'wrong' ? 'http://127.0.0.1:1' : origin;
  }

  function mcpServer(access) {
    const mcp = new Server({ name: 'T3 Code', version: '0.0.0-fake' }, { capabilities: { tools: {} } });
    mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
    mcp.setRequestHandler(CallToolRequestSchema, async (request) => {
      const name = request.params.name;
      const args = request.params.arguments ?? {};
      log.push({ tool: name, args });
      if (name === 't3_project_list') {
        const cursor = Number.isInteger(args.cursor) ? args.cursor : 0;
        const limit = Math.min(Number.isInteger(args.limit) ? args.limit : 20, pageSize, 100);
        const projects = FAKE_PROJECTS.slice(cursor, cursor + limit);
        const next = cursor + limit < FAKE_PROJECTS.length ? cursor + limit : null;
        return result({ projects, nextCursor: next });
      }
      if (name === 'orchestrator_capabilities') return result(FAKE_CAPABILITIES);
      if (access === 'read-only') {
        return failure({ code: 'capability_denied', message: 'This tool changes the environment, and this MCP client was approved for read-only access.' });
      }
      return failure({ code: 'not_supported', message: 'The fake does not run threads.' });
    });
    return mcp;
  }

  function validateAuthorization(query) {
    const client = clientOf(query.client_id);
    if (client === undefined) return { page: 'This sign-in link names an unknown app. Start the sign-in again from it.' };
    const redirectUri = query.redirect_uri;
    if (redirectUri === undefined || !client.redirectUris.some((registered) => redirectMatches(registered, redirectUri))) {
      return { page: 'This sign-in link sends you to an address the app did not register.' };
    }
    const fail = (error, description) => ({ redirect: withParams(redirectUri, { error, error_description: description, state: query.state, iss: origin }) });
    if (query.response_type !== 'code') return fail('unsupported_response_type', 'Only response_type=code is supported.');
    if (query.code_challenge_method !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(query.code_challenge ?? '')) {
      return fail('invalid_request', 'PKCE with code_challenge_method=S256 is required.');
    }
    if (query.resource !== undefined && query.resource.replace(/\/+$/, '') !== `${origin}/mcp`) return fail('invalid_target', 'Wrong resource.');
    return { client, redirectUri };
  }

  function clientOf(clientId) {
    if (typeof clientId !== 'string' || !clients.has(clientId)) return undefined;
    const payload = JSON.parse(Buffer.from(clientId.split('.')[0], 'base64url').toString('utf8'));
    return { id: clientId, name: payload.n, redirectUris: payload.r };
  }

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  origin = `http://127.0.0.1:${server.address().port}`;

  return {
    origin,
    /** Every token the fake issued this run. */
    issued: () => [...issued],
    /** Requests in order: method, path and the bearer token sent with it, and each tool call. */
    log: () => [...log],
    /** What the owner does in T3's Settings → Sharing & access: revoke every sign-in. */
    revokeAll: () => tokens.clear(),
    /** Accepts a token the test stored itself, as one this fake issued with read-only access. */
    acceptToken: (token) => void tokens.set(token, 'read-only'),
    close: async () => {
      for (const transport of sessions.values()) await transport.close().catch(() => undefined);
      server.closeAllConnections();
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

/** What the owner's browser does on T3's approval page: open the authorize link, choose an access level, follow the answer. */
export async function approveInBrowser(authorizeUrl, decision) {
  const first = await fetch(authorizeUrl, { redirect: 'manual' });
  const pageUrl = new URL(first.headers.get('location') ?? '', authorizeUrl);
  const form = new URLSearchParams(pageUrl.searchParams);
  form.set('decision', decision);
  const answer = await fetch(new URL('/oauth/mcp/decision', authorizeUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
    redirect: 'manual',
  });
  const callback = answer.headers.get('location');
  if (callback === null) throw new Error(`The fake T3 did not redirect: ${answer.status} ${await answer.text()}`);
  const landed = await fetch(callback);
  return { callback, status: landed.status, text: await landed.text() };
}

function project(id, title, workspaceRoot, defaultModelSelection) {
  return {
    id,
    title,
    workspaceRoot,
    repositoryIdentity: null,
    defaultModelSelection,
    scripts: [],
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: null,
  };
}

function result(value) {
  return { structuredContent: value, content: [{ type: 'text', text: JSON.stringify(value) }] };
}

function failure(value) {
  return { isError: true, content: [{ type: 'text', text: JSON.stringify(value) }] };
}

function isAllowedRedirect(value) {
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK.has(url.hostname))) && !value.includes('#');
  } catch {
    return false;
  }
}

/** Loopback redirects ignore the port (RFC 8252 §7.3), as T3's `redirectMatches` does. */
function redirectMatches(registered, presented) {
  if (!isAllowedRedirect(registered) || !isAllowedRedirect(presented)) return false;
  const left = new URL(registered);
  const right = new URL(presented);
  if (left.protocol === 'https:' || right.protocol === 'https:') return left.href === right.href;
  return left.hostname === right.hostname && left.pathname === right.pathname && left.search === right.search;
}

function withParams(base, params) {
  const url = new URL(base);
  for (const [key, value] of Object.entries(params)) if (value !== undefined) url.searchParams.set(key, value);
  return url.toString();
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

function json(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
}

function html(response, status, body) {
  response.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
  response.end(`<!doctype html><meta charset="utf-8"><title>T3 Code</title>${body}`);
}

function redirect(response, location) {
  response.writeHead(302, { location, 'cache-control': 'no-store' });
  response.end();
}

function escape(value) {
  return String(value).replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);
}
