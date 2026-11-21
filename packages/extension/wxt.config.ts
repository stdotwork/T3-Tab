import { defineConfig } from 'wxt';

import { EXTENSION_MANIFEST, EXTENSION_MANIFEST_VERSION } from './src/manifest';

export default defineConfig({
  manifestVersion: EXTENSION_MANIFEST_VERSION,
  manifest: EXTENSION_MANIFEST,
});
