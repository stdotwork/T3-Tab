import { describe, expect, it } from 'vitest';

import { makeSessionName } from '../src/daemon-messages.js';

describe('MCP sessions', () => {
  it('names a session from the MCP client name and a short id', () => {
    expect(makeSessionName('Codex CLI', '12345678-aaaa-bbbb-cccc-123456789abc')).toBe('Codex CLI · 12345678');
  });

  it('sanitizes and falls back for an unnamed client', () => {
    expect(makeSessionName('  bad\u0000  name  ', 'abc')).toBe('bad name · abc');
    expect(makeSessionName('', '')).toBe('MCP client · session');
  });
});
