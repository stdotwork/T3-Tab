import { describe, expect, it } from 'vitest';

import { EXTENSION_ORIGIN } from '@t3-tab/protocol';

import { connectionRole, isExtensionOrigin, isLoopbackHostHeader, tokensMatch } from '../src/security.js';

describe('link security checks', () => {
  it('accepts only the exact random token', () => {
    expect(tokensMatch('correct-token', 'correct-token')).toBe(true);
    expect(tokensMatch('correct-token', 'wrong-token')).toBe(false);
    expect(tokensMatch('correct-token', 'correct-token-longer')).toBe(false);
    expect(tokensMatch('correct-token', undefined)).toBe(false);
  });

  it('accepts only the T3-Tab extension origin', () => {
    expect(isExtensionOrigin(EXTENSION_ORIGIN)).toBe(true);
    expect(isExtensionOrigin('chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')).toBe(false);
    expect(isExtensionOrigin(`${EXTENSION_ORIGIN}/`)).toBe(false);
    expect(isExtensionOrigin('http://127.0.0.1:8765')).toBe(false);
    expect(connectionRole(undefined, 'control')).toBe('control');
    expect(connectionRole(EXTENSION_ORIGIN, 'extension')).toBe('extension');
    expect(connectionRole(EXTENSION_ORIGIN, 'control')).toBeUndefined();
    expect(connectionRole(undefined, 'extension')).toBeUndefined();
    expect(connectionRole('https://example.com', 'control')).toBeUndefined();
    expect(connectionRole('https://example.com', 'extension')).toBeUndefined();
  });

  it('accepts loopback Host headers and rejects hostnames that can resolve elsewhere', () => {
    expect(isLoopbackHostHeader('127.0.0.1:8765')).toBe(true);
    expect(isLoopbackHostHeader('localhost:8765')).toBe(true);
    expect(isLoopbackHostHeader('[::1]:8765')).toBe(true);
    expect(isLoopbackHostHeader('127.0.0.1')).toBe(true);
    expect(isLoopbackHostHeader('127.0.0.1.example:8765')).toBe(false);
    expect(isLoopbackHostHeader('0.0.0.0:8765')).toBe(false);
    expect(isLoopbackHostHeader('example.com:8765')).toBe(false);
    expect(isLoopbackHostHeader('localhost:not-a-port')).toBe(false);
    expect(isLoopbackHostHeader(undefined)).toBe(false);
  });
});
