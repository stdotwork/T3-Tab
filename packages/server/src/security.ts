import { timingSafeEqual } from 'node:crypto';

import { EXTENSION_ORIGINS } from '@t3-tab/protocol';

export type ConnectionRole = 'extension' | 'control';

/** Which of the daemon's two secrets a connection presented. */
export type ConnectionCredential = 'extension' | 'control';

export function tokensMatch(expected: string, provided: string | undefined): boolean {
  if (provided === undefined) return false;
  const expectedBytes = Buffer.from(expected, 'utf8');
  const providedBytes = Buffer.from(provided, 'utf8');
  return expectedBytes.length === providedBytes.length && timingSafeEqual(expectedBytes, providedBytes);
}

export function isExtensionOrigin(origin: string | undefined): boolean {
  return origin !== undefined && EXTENSION_ORIGINS.includes(origin);
}

/**
 * The role comes from the secret: the control token, which every MCP server reads, can never take the extension role.
 * The Origin must agree as well, so a web page that somehow held a token is still refused.
 */
export function connectionRole(origin: string | undefined, credential: ConnectionCredential): ConnectionRole | undefined {
  if (credential === 'control') return origin === undefined ? 'control' : undefined;
  return isExtensionOrigin(origin) ? 'extension' : undefined;
}

export function isLoopbackHostHeader(value: string | undefined): boolean {
  if (value === undefined) return false;
  const host = value.trim().toLowerCase();
  if (host === '') return false;

  if (host.startsWith('[')) {
    const closingBracket = host.indexOf(']');
    if (closingBracket < 0) return false;
    if (host.slice(0, closingBracket + 1) !== '[::1]') return false;
    const remainder = host.slice(closingBracket + 1);
    return remainder === '' || isValidPortSuffix(remainder);
  }

  if (host.includes(':')) {
    if ((host.match(/:/g) ?? []).length !== 1) return false;
    const colon = host.lastIndexOf(':');
    const port = host.slice(colon);
    if (!isValidPortSuffix(port)) return false;
    return isLoopbackHostname(host.slice(0, colon));
  }

  return isLoopbackHostname(host);
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === '127.0.0.1' || hostname === 'localhost';
}

function isValidPortSuffix(suffix: string): boolean {
  if (!/^:\d{1,5}$/.test(suffix)) return false;
  const port = Number(suffix.slice(1));
  return port >= 1 && port <= 65_535;
}
