import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { parse } from 'smol-toml';

import { tomlString } from '../toml.js';

/** The variable a provider's bearer token reaches Codex through. Codex does not pass it on to MCP servers. */
const CODEX_TOKEN_ENV = 'T3_TAB_CODEX_PROVIDER_TOKEN';
const HEADER_ENV_PREFIX = 'T3_TAB_CODEX_PROVIDER_HEADER_';

/** Provider settings of Codex 0.166.0 (`ModelProviderInfo`) that hold no credential once checked below. */
const CARRIED_KEYS: ReadonlySet<string> = new Set([
  'name',
  'base_url',
  'model_catalog_url',
  'env_key',
  'env_key_instructions',
  'project_id',
  'location',
  'credential_file',
  'wire_api',
  'capabilities',
  'query_params',
  'env_http_headers',
  'request_max_retries',
  'stream_max_retries',
  'stream_idle_timeout_ms',
  'websocket_connect_timeout_ms',
  'requires_openai_auth',
  'supports_websockets',
  'supports_standalone_web_search',
]);
/** Sign-in settings that run a command or hold credentials, and have no form that stays off the command line. */
const SIGN_IN_KEYS = ['auth', 'gateway_oauth', 'aws'];
const SECRET_NAME = /key|token|secret|passw|credential|auth|cookie|signature|^(?:sig|code)$/i;
// Codex splits a `-c` path on dots, so a provider name with one cannot be addressed.
const PROVIDER_NAME = /^[A-Za-z0-9_-]+$/;

/** The owner's active Codex provider, as `-c` settings plus the variables its credentials travel in. */
export interface CodexProvider {
  /** `key=value` pairs for `-c`. They hold no credential. */
  settings: string[];
  /** The model the owner's config selects. A model chosen in the panel replaces it. */
  model?: string;
  /** Variables for the Codex process only. */
  env: Record<string, string>;
  /** Names of provider settings T3-Tab does not know, which were left out. */
  ignored: string[];
}

function isTable(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date);
}

/** A TOML value for a `-c` setting, on one line. */
export function tomlValue(value: unknown): string | undefined {
  if (typeof value === 'string') return tomlString(value);
  if (typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : undefined;
  if (Array.isArray(value)) {
    const items = value.map(tomlValue);
    return items.includes(undefined) ? undefined : `[${items.join(', ')}]`;
  }
  if (!isTable(value)) return undefined;
  const fields = Object.entries(value).map(([key, field]) => {
    const text = tomlValue(field);
    return text === undefined ? undefined : `${tomlString(key)} = ${text}`;
  });
  return fields.includes(undefined) ? undefined : `{ ${fields.join(', ')} }`;
}

function urlHoldsCredential(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return true;
  }
  return (
    url.username !== '' ||
    url.password !== '' ||
    url.hash !== '' ||
    [...url.searchParams.keys()].some((name) => SECRET_NAME.test(name))
  );
}

/**
 * Reads only the active custom provider from `$CODEX_HOME/config.toml`, for a run that otherwise ignores that file.
 * Without one it returns undefined and nothing is added. A credential never goes on the command line: a bearer
 * token and static headers move to environment variables of the Codex process, and a credential with no such route
 * stops the run, because falling back to another provider would send the owner's work somewhere they did not choose.
 */
export async function readCodexProvider(env: NodeJS.ProcessEnv): Promise<CodexProvider | undefined> {
  const path = join(env.CODEX_HOME?.trim() || join(env.HOME?.trim() || homedir(), '.codex'), 'config.toml');
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new Error(`T3-Tab could not read Codex's ${path}.`);
  }
  let config: Record<string, unknown>;
  try {
    config = parse(text, { integersAsBigInt: 'asNeeded' }) as Record<string, unknown>;
  } catch {
    // The parser's message quotes the file, which may hold a token.
    throw new Error(`T3-Tab could not parse Codex's ${path}. Fix that file, then start the run again.`);
  }
  const name = config.model_provider;
  if (typeof name !== 'string' || !isTable(config.model_providers)) return undefined;
  if (!Object.hasOwn(config.model_providers, name)) return undefined;
  const table = config.model_providers[name];
  if (!isTable(table)) return undefined;

  const refuse = (what: string): Error =>
    new Error(`T3-Tab cannot run Codex with provider "${name}": ${what}. Change that in Codex's config, or use a T3 Code thread.`);
  if (!PROVIDER_NAME.test(name)) throw refuse('its name can only be passed to Codex with letters, digits, "_" and "-"');
  for (const key of SIGN_IN_KEYS) {
    if (table[key] !== undefined) throw refuse(`its \`${key}\` sign-in cannot be passed without putting it on the command line`);
  }
  for (const key of ['base_url', 'model_catalog_url']) {
    const value = table[key];
    if (value !== undefined && (typeof value !== 'string' || urlHoldsCredential(value))) {
      throw refuse(`its \`${key}\` holds a credential or is not an address, and would go on the command line`);
    }
  }
  if (table.query_params !== undefined) {
    if (!isTable(table.query_params)) throw refuse('`query_params` is not a table of text values');
    for (const [param, value] of Object.entries(table.query_params)) {
      if (typeof value !== 'string') throw refuse('a value in `query_params` is not text');
      if (SECRET_NAME.test(param)) throw refuse('a secret in `query_params` would go on the command line');
    }
  }
  if (table.env_key !== undefined && typeof table.env_key !== 'string') {
    throw refuse('`env_key` is not text');
  }

  const prefix = `model_providers.${name}`;
  const settings = [`model_provider=${tomlString(name)}`];
  const childEnv: Record<string, string> = {};
  const ignored: string[] = [];
  for (const [key, value] of Object.entries(table)) {
    if (key === 'env_key' || key === 'experimental_bearer_token' || key === 'http_headers' || key === 'env_http_headers') continue;
    const text = CARRIED_KEYS.has(key) ? tomlValue(value) : undefined;
    if (text === undefined) ignored.push(key);
    else settings.push(`${prefix}.${key}=${text}`);
  }

  // Codex reads `env_key` before a bearer token, so a provider with its own variable keeps it.
  const envKey = typeof table.env_key === 'string' && table.env_key.trim() !== '' ? table.env_key : undefined;
  const token = table.experimental_bearer_token;
  if (envKey !== undefined) {
    settings.push(`${prefix}.env_key=${tomlString(envKey)}`);
  } else if (typeof token === 'string' && token.trim() !== '') {
    childEnv[CODEX_TOKEN_ENV] = token;
    settings.push(`${prefix}.env_key=${tomlString(CODEX_TOKEN_ENV)}`);
  }

  const headerVariables = Object.create(null) as Record<string, string>;
  if (table.http_headers !== undefined) {
    if (!isTable(table.http_headers)) throw refuse('`http_headers` is not a table of text values');
    for (const [index, [header, value]] of Object.entries(table.http_headers).entries()) {
      if (typeof value !== 'string') throw refuse('a value in `http_headers` is not text');
      const variable = `${HEADER_ENV_PREFIX}${index}`;
      childEnv[variable] = value;
      headerVariables[header] = variable;
    }
  }
  if (table.env_http_headers !== undefined) {
    if (!isTable(table.env_http_headers)) throw refuse('`env_http_headers` is not a table of variable names');
    for (const [header, value] of Object.entries(table.env_http_headers)) {
      if (typeof value !== 'string') throw refuse('a value in `env_http_headers` is not a variable name');
      headerVariables[header] = value;
    }
  }
  if (Object.keys(headerVariables).length > 0) {
    const text = tomlValue(headerVariables);
    if (text === undefined) throw refuse('`env_http_headers` is not a table of variable names');
    settings.push(`${prefix}.env_http_headers=${text}`);
  }

  const provider: CodexProvider = { settings, env: childEnv, ignored };
  if (typeof config.model === 'string' && config.model !== '') provider.model = config.model;
  return provider;
}
