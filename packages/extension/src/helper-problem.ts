import { EXTENSION_OUTDATED, HELPER_OUTDATED, PROTOCOL_MISMATCH } from '@t3-tab/protocol';

/**
 * Why the helper is not connected, in the words the panel acts on:
 * `pending` (no attempt has failed yet), `missing` (the browser knows no helper: run the setup command), `blocked`
 * (one is registered but not for this extension), `helper-outdated`, `extension-outdated`, `failed` (the browser started
 * the helper and it stopped, such as for want of Node), `connection` (the helper's background program refused or closed
 * the connection) and `unknown`.
 */
export type HelperProblem = 'pending' | 'missing' | 'blocked' | 'helper-outdated' | 'extension-outdated' | 'failed' | 'connection' | 'unknown';

/** What the worker says when it has no error to report. */
export const NOT_CONNECTED = 'T3-Tab is not connected to its helper.';

export function classifyHelperProblem(message: string | undefined): HelperProblem {
  if (message === undefined) return 'pending';
  if (message === EXTENSION_OUTDATED) return 'extension-outdated';
  if (message === HELPER_OUTDATED || message === PROTOCOL_MISMATCH || message === 'Native host protocol mismatch' || message === 'Invalid protocol message') return 'helper-outdated';
  if (/not found/i.test(message)) return 'missing';
  if (/forbidden/i.test(message)) return 'blocked';
  if (/exited|communicating/i.test(message)) return 'failed';
  if (/background program/i.test(message)) return 'connection';
  return 'unknown';
}
