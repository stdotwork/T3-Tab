export const PROTOCOL_VERSION = 1 as const;
export const DEFAULT_DAEMON_PORT = 8765;
export const NATIVE_HOST_NAME = 'com.t3tab.native';
export const EXTENSION_ID = 'gggnknbjooockcnnocejdolfdpjifebm';
export const EXTENSION_ORIGIN = `chrome-extension://${EXTENSION_ID}`;

export interface BrowserHelloMessage {
  type: 'browser.hello';
  protocolVersion: typeof PROTOCOL_VERSION;
  browserId: string;
  browserName: string;
}

export interface BrowserTabCountMessage {
  type: 'browser.tabCount';
  protocolVersion: typeof PROTOCOL_VERSION;
  tabCount: number;
}

export type BrowserMessage = BrowserHelloMessage | BrowserTabCountMessage;

export interface BrowserStatus {
  id: string;
  name: string;
  tabCount: number;
}

export interface ControlStatusRequest {
  type: 'control.request';
  protocolVersion: typeof PROTOCOL_VERSION;
  requestId: string;
  method: 'status';
}

export interface ControlStatusResponse {
  type: 'control.response';
  protocolVersion: typeof PROTOCOL_VERSION;
  requestId: string;
  ok: true;
  result: {
    browsers: BrowserStatus[];
  };
}

export interface ControlErrorResponse {
  type: 'control.response';
  protocolVersion: typeof PROTOCOL_VERSION;
  requestId: string | null;
  ok: false;
  error: string;
}

export type ControlRequest = ControlStatusRequest;
export type ControlResponse = ControlStatusResponse | ControlErrorResponse;

export interface NativeDaemonRequest {
  type: 'native.daemon';
  protocolVersion: typeof PROTOCOL_VERSION;
}

export interface NativeDaemonResponse {
  type: 'native.daemon';
  protocolVersion: typeof PROTOCOL_VERSION;
  port: number;
  token: string;
}

export interface NativeErrorResponse {
  type: 'native.error';
  protocolVersion: typeof PROTOCOL_VERSION;
  error: string;
}

export type NativeResponse = NativeDaemonResponse | NativeErrorResponse;
