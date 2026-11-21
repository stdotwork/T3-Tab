import { describe, expect, it } from 'vitest';

import { makeSession } from '../src/mcp.js';

describe('MCP sessions', () => {
  it('names a session from the MCP client name and a short id', () => {
    expect(makeSession('12345678-aaaa-bbbb-cccc-123456789abc', 'Codex CLI')).toEqual({
      id: '12345678-aaaa-bbbb-cccc-123456789abc',
      name: 'Codex CLI · 12345678',
    });
  });

  it('sanitizes and falls back for an unnamed client', () => {
    expect(makeSession('abc', '  bad\u0000  name  ').name).toBe('bad name · abc');
    expect(makeSession('', '').name).toBe('MCP client · session');
  });
});
