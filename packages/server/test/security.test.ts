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

  it('handles different lengths, empty strings, undefined, and non-ASCII tokens', () => {
    const cases: Array<[string | undefined, string, boolean]> = [
      ['secret', 'secret', true],
      ['secret', 'secreT', false],
      ['short', 'longer-secret', false],
      ['longer-secret', 'short', false],
      ['', '', true],
      ['', 'a', false],
      ['a', '', false],
      [undefined, 'secret', false],
      [undefined, '', false],
      ['café', 'café', true],
      ['café', 'cafe', false],
      ['é', 'ab', false],
      ['á', 'a\u0301', false],
      ['日本語', '日本語', true],
      ['🔑', '🔑', true],
      ['🔑', '🔒', false],
    ];
    for (const [presented, expected, want] of cases) {
      expect(tokensMatch(expected, presented)).toBe(want);
    }
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
