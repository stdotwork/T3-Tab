import { describe, expect, it } from 'vitest';

import { PROTOCOL_MISMATCH, PROTOCOL_VERSION } from '../src/index.js';

describe('protocol version', () => {
  it('is version 2, which added the side-panel daemon requests', () => {
    expect(PROTOCOL_VERSION).toBe(2);
  });

  it('has a mismatch message that fits a WebSocket close reason', () => {
    expect(new TextEncoder().encode(PROTOCOL_MISMATCH).length).toBeLessThanOrEqual(123);
  });
});
