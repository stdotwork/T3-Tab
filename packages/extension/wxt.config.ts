import { randomBytes } from 'node:crypto';

import { defineConfig } from 'wxt';

import { EXTENSION_MANIFEST, EXTENSION_MANIFEST_VERSION } from './src/manifest';

// One ID per build run, shared by every entry point. `T3_TAB_BUILD_ID` fixes it (the end-to-end run does, to make a
// second build to swap in under a running browser).
const buildId = process.env.T3_TAB_BUILD_ID?.trim() || `${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`;

export default defineConfig({
  manifestVersion: EXTENSION_MANIFEST_VERSION,
  manifest: EXTENSION_MANIFEST,
  vite: () => ({ define: { __T3_TAB_BUILD_ID__: JSON.stringify(buildId) } }),
});
