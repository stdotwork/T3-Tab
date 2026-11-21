import { describe, expect, it } from 'vitest';

import { EXTENSION_MANIFEST, EXTENSION_MANIFEST_VERSION } from '../src/manifest.js';

describe('extension manifest', () => {
  it('targets Manifest V3 and includes the side panel permission', () => {
    expect(EXTENSION_MANIFEST_VERSION).toBe(3);
    expect(EXTENSION_MANIFEST.name).toBe('T3-Tab');
    expect(EXTENSION_MANIFEST.permissions).toContain('sidePanel');
  });
});
