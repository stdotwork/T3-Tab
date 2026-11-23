/** Replaced at build time (`wxt.config.ts`): one value per build, the same in the service worker and the side panel. */
declare const __T3_TAB_BUILD_ID__: string | undefined;

/**
 * Identifies the build this file came from. An unpacked extension serves the panel's files from disk each time the panel
 * opens, but its service worker keeps running the code it loaded until the extension is reloaded, so after a rebuild the
 * two can be different builds. The panel asks the worker for its ID and reloads the extension when they differ.
 * `dev` (unit tests, no bundler) never counts as a mismatch.
 */
export const BUILD_ID: string = typeof __T3_TAB_BUILD_ID__ === 'undefined' ? 'dev' : __T3_TAB_BUILD_ID__;
