import { describe, expect, it } from 'vitest';

import { PROTOCOL_MISMATCH, PROTOCOL_VERSION } from '../src/index.js';

describe('protocol version', () => {
  it('is version 3, which added panel setup, T3 pairing and prompts in agent threads', () => {
    expect(PROTOCOL_VERSION).toBe(3);
  });

  it('has a mismatch message that fits a WebSocket close reason', () => {
    expect(new TextEncoder().encode(PROTOCOL_MISMATCH).length).toBeLessThanOrEqual(123);
  });
});
