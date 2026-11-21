import { PROTOCOL_VERSION, type NativeDaemonRequest, type NativeResponse } from '@t3-tab/protocol';

import { ensureDaemon } from './client.js';
import { readNativeMessage, writeNativeMessage } from './native-json.js';
import { readExtensionState, stateDirectory } from './state.js';

const EXTENSION_STATE_WAIT_MS = 2_000;

export async function runNativeHost(): Promise<void> {
  let response: NativeResponse;
  try {
    const request: unknown = await readNativeMessage(process.stdin);
    if (!isNativeDaemonRequest(request)) throw new Error('Unsupported native messaging request');
    response = { type: 'native.daemon', protocolVersion: PROTOCOL_VERSION, ...(await extensionConfiguration()) };
  } catch (error) {
    response = {
      type: 'native.error',
      protocolVersion: PROTOCOL_VERSION,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  await writeNativeMessage(process.stdout, response);
}

/** The running daemon's port and the extension's own secret, which is never the control token MCP servers use. */
async function extensionConfiguration(): Promise<{ port: number; token: string }> {
  const directory = stateDirectory();
  const deadline = Date.now() + EXTENSION_STATE_WAIT_MS;
  for (;;) {
    const state = await ensureDaemon();
    const extension = await readExtensionState(directory);
    if (extension !== null && extension.pid === state.pid && extension.port === state.port) {
      return { port: state.port, token: extension.token };
    }
    if (Date.now() >= deadline) {
      throw new Error(`The running T3-Tab daemon (process ${state.pid}) has no extension token. Stop it, then reopen the browser.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

function isNativeDaemonRequest(value: unknown): value is NativeDaemonRequest {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return candidate.type === 'native.daemon' && candidate.protocolVersion === PROTOCOL_VERSION;
}
