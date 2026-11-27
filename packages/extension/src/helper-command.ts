/**
 * The command the panel shows for installing the helper, which is the part of T3-Tab that lives on the machine.
 * It works from any folder and installs for the current user only.
 *
 * ONE SWITCH: `HELPER_CHANNEL`. The product build uses npm; until the package is published, the build the owner tests
 * fetches the same packed helper from a GitHub prerelease with a small install script (`scripts/install-test-build.sh`,
 * which ends in the same `t3-tab setup`). Publishing means changing `'test'` to `'product'` here, nothing else.
 */
export const HELPER_CHANNEL = 'test' as 'test' | 'product';

export const PRODUCT_HELPER_COMMAND = 'npx t3-tab@latest setup';
export const TEST_HELPER_COMMAND = 'curl -fsSL https://raw.githubusercontent.com/stdotwork/T3-Tab/main/scripts/install-test-build.sh | sh';

export const HELPER_COMMAND = HELPER_CHANNEL === 'product' ? PRODUCT_HELPER_COMMAND : TEST_HELPER_COMMAND;

/** What the helper needs on the machine, as the panel says it. */
export const HELPER_REQUIREMENT = 'Needs Node.js 20 or newer.';
