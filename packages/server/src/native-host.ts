import { PROTOCOL_VERSION, type NativeDaemonRequest, type NativeResponse } from '@t3-tab/protocol';

import { ensureDaemon } from './client.js';
import { readNativeMessage, writeNativeMessage } from './native-json.js';

export async function runNativeHost(): Promise<void> {
  let response: NativeResponse;
  try {
    const request: unknown = await readNativeMessage(process.stdin);
    if (!isNativeDaemonRequest(request)) throw new Error('Unsupported native messaging request');
    const state = await ensureDaemon();
    response = {
      type: 'native.daemon',
      protocolVersion: PROTOCOL_VERSION,
      port: state.port,
      token: state.token,
    };
  } catch (error) {
    response = {
      type: 'native.error',
      protocolVersion: PROTOCOL_VERSION,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  await writeNativeMessage(process.stdout, response);
}

function isNativeDaemonRequest(value: unknown): value is NativeDaemonRequest {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return candidate.type === 'native.daemon' && candidate.protocolVersion === PROTOCOL_VERSION;
}
