import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { EXTENSION_ID } from '@t3-tab/protocol';

import { EXTENSION_KEY, EXTENSION_MANIFEST, EXTENSION_MANIFEST_VERSION } from '../src/manifest.js';

describe('extension manifest', () => {
  it('targets Manifest V3 and includes the link permissions', () => {
    expect(EXTENSION_MANIFEST_VERSION).toBe(3);
    expect(EXTENSION_MANIFEST.name).toBe('T3-Tab');
    expect(EXTENSION_MANIFEST.permissions).toContain('sidePanel');
    expect(EXTENSION_MANIFEST.permissions).toContain('nativeMessaging');
    expect(EXTENSION_MANIFEST.permissions).toContain('tabs');
    expect(EXTENSION_MANIFEST.permissions).toContain('tabGroups');
    expect(EXTENSION_MANIFEST.permissions).toContain('storage');
  });

  it('asks for the navigation events that name the tab a popup was opened from', () => {
    expect(EXTENSION_MANIFEST.permissions).toContain('webNavigation');
  });

  it('asks for the debugger permission the page reader needs', () => {
    expect(EXTENSION_MANIFEST.permissions).toContain('debugger');
  });

  it('derives the fixed extension id shared with the daemon', () => {
    const digest = createHash('sha256').update(Buffer.from(EXTENSION_KEY, 'base64')).digest().subarray(0, 16);
    const derived = [...digest]
      .flatMap((byte) => [byte >> 4, byte & 15])
      .map((nibble) => String.fromCharCode(97 + nibble))
      .join('');
    expect(derived).toBe(EXTENSION_ID);
  });
});
