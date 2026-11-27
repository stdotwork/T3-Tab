import { describe, expect, it } from 'vitest';

import { EXTENSION_OUTDATED, HELPER_OUTDATED, PROTOCOL_MISMATCH, PROTOCOL_VERSION, mismatchReason } from '../src/index.js';

describe('protocol version', () => {
  it('is version 6, which added page.read with ifReadable, a read that never prompts', () => {
    expect(PROTOCOL_VERSION).toBe(6);
  });

  it('has mismatch messages that fit a WebSocket close reason', () => {
    for (const message of [PROTOCOL_MISMATCH, HELPER_OUTDATED, EXTENSION_OUTDATED]) {
      expect(new TextEncoder().encode(message).length).toBeLessThanOrEqual(123);
    }
  });

  it('says the helper is behind when the extension speaks a newer version, and the extension when it speaks an older one', () => {
    expect(mismatchReason(PROTOCOL_VERSION + 1)).toBe(HELPER_OUTDATED);
    expect(mismatchReason(PROTOCOL_VERSION - 1)).toBe(EXTENSION_OUTDATED);
  });
});
