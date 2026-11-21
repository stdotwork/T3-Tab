import type { T3Catalog, T3Project, T3Provider } from '@t3-tab/protocol';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

/** The only T3 tools T3-Tab calls. Both are read-only in T3 (`McpToolAccess.reads`). */
export const T3_LIST_TOOLS = ['t3_project_list', 'orchestrator_capabilities'] as const;

const CALL_TIMEOUT_MS = 15_000;
const PAGE_LIMIT = 100;
const MAX_PAGES = 10;

/** Thrown with a fixed message: never T3's response body, which could echo what was sent. */
export class T3CatalogError extends Error {
  constructor(
    message: string,
    readonly unauthorized = false,
  ) {
    super(message);
  }
}

/**
 * Lists T3's projects, provider instances and models through its `/mcp` endpoint with the read-only credential. The
 * token goes in the Authorization header of requests to `resource` only; redirects are refused, so it cannot be
 * forwarded anywhere else.
 */
export async function fetchCatalog(resource: string, accessToken: string): Promise<T3Catalog> {
  let unauthorized = false;
  const guardedFetch = async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const target = new URL(url);
    if (target.href !== new URL(resource).href) throw new T3CatalogError('T3-Tab refused to send its T3 sign-in to another address.');
    const response = await fetch(target, { ...init, redirect: 'error' });
    // 401 is T3's answer to a token it does not accept (McpHttpServer.ts); nothing else ends the sign-in.
    if (response.status === 401) unauthorized = true;
    return response;
  };
  const transport = new StreamableHTTPClientTransport(new URL(resource), {
    requestInit: { headers: { Authorization: `Bearer ${accessToken}` } },
    fetch: guardedFetch,
  });
  const client = new Client({ name: 'T3-Tab', version: '0.1.0' });
  try {
    try {
      await client.connect(transport, { timeout: CALL_TIMEOUT_MS });
    } catch {
      throw failure(unauthorized, 'T3 Code did not answer at its MCP address.');
    }
    const projects: T3Project[] = [];
    let cursor: number | null = 0;
    for (let page = 0; page < MAX_PAGES && cursor !== null; page += 1) {
      const result = await call(client, 't3_project_list', cursor === 0 ? { limit: PAGE_LIMIT } : { cursor, limit: PAGE_LIMIT }, () => unauthorized);
      const parsed = parseProjectPage(result);
      projects.push(...parsed.projects);
      cursor = parsed.nextCursor;
    }
    const capabilities = await call(client, 'orchestrator_capabilities', {}, () => unauthorized);
    return { projects, providers: parseProviders(capabilities), fetchedAt: Date.now() };
  } finally {
    await transport.terminateSession().catch(() => undefined);
    await client.close().catch(() => undefined);
  }
}

async function call(client: Client, name: (typeof T3_LIST_TOOLS)[number], args: Record<string, unknown>, unauthorized: () => boolean): Promise<unknown> {
  let result: Awaited<ReturnType<Client['callTool']>>;
  try {
    result = await client.callTool({ name, arguments: args }, undefined, { timeout: CALL_TIMEOUT_MS });
  } catch {
    throw failure(unauthorized(), `T3 Code did not answer ${name}.`);
  }
  if (result.isError === true) throw new T3CatalogError(`T3 Code refused ${name}.`);
  if (typeof result.structuredContent === 'object' && result.structuredContent !== null) return result.structuredContent;
  const text = Array.isArray(result.content)
    ? result.content
        .filter((item): item is { type: 'text'; text: string } => item.type === 'text' && typeof item.text === 'string')
        .map((item) => item.text)
        .join('')
    : '';
  try {
    return JSON.parse(text);
  } catch {
    throw new T3CatalogError(`T3 Code's answer to ${name} could not be read.`);
  }
}

function failure(unauthorized: boolean, message: string): T3CatalogError {
  return unauthorized ? new T3CatalogError('T3 Code no longer accepts T3-Tab\'s sign-in.', true) : new T3CatalogError(message);
}

export function parseProjectPage(value: unknown): { projects: T3Project[]; nextCursor: number | null } {
  const page = record(value);
  if (!Array.isArray(page.projects)) throw new T3CatalogError("T3 Code's project list could not be read.");
  const projects: T3Project[] = [];
  for (const item of page.projects) {
    const project = record(item);
    if (typeof project.id !== 'string' || typeof project.title !== 'string' || typeof project.workspaceRoot !== 'string') continue;
    if (project.deletedAt !== undefined && project.deletedAt !== null) continue;
    if (project.archivedAt !== undefined && project.archivedAt !== null) continue;
    const entry: T3Project = { id: project.id, title: project.title, workspaceRoot: project.workspaceRoot };
    const selection = record(project.defaultModelSelection);
    if (typeof selection.instanceId === 'string' && typeof selection.model === 'string') {
      entry.defaultProvider = selection.instanceId;
      entry.defaultModel = selection.model;
    }
    projects.push(entry);
  }
  const next = page.nextCursor;
  return { projects, nextCursor: typeof next === 'number' && Number.isInteger(next) && next > 0 ? next : null };
}

export function parseProviders(value: unknown): T3Provider[] {
  const result = record(value);
  if (!Array.isArray(result.providers)) throw new T3CatalogError("T3 Code's provider list could not be read.");
  const providers: T3Provider[] = [];
  for (const item of result.providers) {
    const provider = record(item);
    if (typeof provider.providerInstanceId !== 'string' || !Array.isArray(provider.models)) continue;
    const name =
      typeof provider.displayName === 'string' && provider.displayName !== ''
        ? provider.displayName
        : typeof provider.driverKind === 'string'
          ? `${provider.providerInstanceId} (${provider.driverKind})`
          : provider.providerInstanceId;
    const models = provider.models.flatMap((model) => {
      const entry = record(model);
      if (typeof entry.id !== 'string') return [];
      return [typeof entry.label === 'string' ? { id: entry.id, label: entry.label } : { id: entry.id }];
    });
    const entry: T3Provider = { instanceId: provider.providerInstanceId, name, models };
    if (typeof provider.omittedModels === 'number' && provider.omittedModels > 0) entry.omittedModels = provider.omittedModels;
    const constraints = Array.isArray(provider.constraints) ? provider.constraints.filter((text) => typeof text === 'string') : [];
    if (constraints.length > 0) entry.unavailable = constraints.join(' ');
    providers.push(entry);
  }
  return providers;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
