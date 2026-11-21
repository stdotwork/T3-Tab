import { describe, expect, it } from 'vitest';

import { PROTOCOL_VERSION } from '../src/index.js';

describe('protocol version', () => {
  it('is the first protocol version', () => {
    expect(PROTOCOL_VERSION).toBe(1);
  });
});
