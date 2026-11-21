export const PROTOCOL_VERSION = 1 as const;
export const DEFAULT_DAEMON_PORT = 8765;
export const NATIVE_HOST_NAME = 'com.t3tab.native';
export const EXTENSION_ID = 'gggnknbjooockcnnocejdolfdpjifebm';
export const EXTENSION_ORIGIN = `chrome-extension://${EXTENSION_ID}`;

/** Default long edge, in pixels, of a screenshot. */
export const DEFAULT_SCREENSHOT_MAX_EDGE = 1280;

export interface BrowserHelloMessage {
  type: 'browser.hello';
  protocolVersion: typeof PROTOCOL_VERSION;
  browserId: string;
  browserName: string;
}

export interface BrowserPingMessage {
  type: 'browser.ping';
  protocolVersion: typeof PROTOCOL_VERSION;
}

export interface BrowserPongMessage {
  type: 'browser.pong';
  protocolVersion: typeof PROTOCOL_VERSION;
}

export interface BrowserTabCountMessage {
  type: 'browser.tabCount';
  protocolVersion: typeof PROTOCOL_VERSION;
  tabCount: number;
}

/** Sent when a tab is closed, so the background program can drop what it holds for it. */
export interface BrowserTabClosedMessage {
  type: 'browser.tabClosed';
  protocolVersion: typeof PROTOCOL_VERSION;
  tabId: number;
}

export interface ToolSession {
  /** Issued by the daemon and bound to the control connection that registered it. */
  id: string;
  /** The MCP client's name plus a short id, shown in the tab group and side panel. */
  name: string;
}

export interface TabInfo {
  id: number;
  title: string;
  url: string;
  /** True for the tab the browser has in front: the default target of `read` and `screenshot`. */
  active: boolean;
  /** Chromium's tab group id, when the tab is grouped. */
  groupId?: number;
  /**
   * Set when the session has not approved the origin the tab now shows: `title` is empty and `url` is
   * only that origin, until a read, an action or the owner approves it.
   */
  needsApproval?: true;
}

/** One accessibility node, trimmed in the extension to what the page reader needs. */
export interface AxNode {
  id: string;
  /** Empty for ignored nodes. */
  role: string;
  name: string;
  value?: string;
  ignored?: true;
  /** Flags the reader prints, such as `checked`, `disabled`, `expanded`, `level`. */
  props?: Record<string, string | number | boolean>;
  children: string[];
  /** Stable for the life of one document; the key of a ref. */
  backendId?: number;
}

export interface PageReadResult {
  tab: number;
  title: string;
  url: string;
  /** Changes when the tab's document is replaced; held refs are void then. */
  epoch: number;
  /** Root first. */
  nodes: AxNode[];
}

export interface ActClickStep {
  click: { ref: string };
}

export interface ActTypeStep {
  type: { ref?: string | undefined; text: string };
}

export interface ActFillStep {
  fill: { ref: string; value: string };
}

export interface ActPressStep {
  press: { key: string };
}

export interface ActSelectStep {
  select: { ref: string; value: string };
}

export interface ActScrollStep {
  scroll: { ref?: string | undefined; dx?: number | undefined; dy?: number | undefined };
}

export interface ActHoverStep {
  hover: { ref: string };
}

export interface ActWaitStep {
  wait: { ms: number } | { for: string };
}

/** One action in an ordered `act` batch. */
export type ActStep =
  | ActClickStep
  | ActTypeStep
  | ActFillStep
  | ActPressStep
  | ActSelectStep
  | ActScrollStep
  | ActHoverStep
  | ActWaitStep;

export type ActAction = 'click' | 'type' | 'fill' | 'press' | 'select' | 'scroll' | 'hover' | 'wait';

export interface ActFailure {
  /** One-based position in the batch. */
  step: number;
  action: ActAction;
  error: string;
}

export interface PageActionResult extends PageReadResult {
  /** Set when the batch stopped before its last step. */
  failure?: ActFailure;
}

export interface ScreenshotResult {
  tab: number;
  /** Base64 JPEG. */
  data: string;
  width: number;
  height: number;
  viewportWidth: number;
  viewportHeight: number;
}

/** Requests the background program sends to the extension, with their params and results. */
export interface BrowserMethods {
  'session.register': { params: Record<string, never>; result: { registered: true } };
  'session.unregister': { params: Record<string, never>; result: { unregistered: true } };
  'tabs.list': { params: Record<string, never>; result: { tabs: TabInfo[] } };
  'tabs.open': { params: { url: string }; result: { tab: TabInfo } };
  'tabs.switch': { params: { tab: number }; result: { tab: TabInfo } };
  'tabs.close': { params: { tab: number }; result: { closed: number } };
  'page.read': { params: { tab?: number }; result: PageReadResult };
  'page.screenshot': { params: { tab?: number; maxEdge: number }; result: ScreenshotResult };
  'page.act': {
    params: { tab?: number; steps: ActStep[]; backendIds: Array<number | null>; epoch: number };
    result: PageActionResult;
  };
  'page.eval': { params: { tab?: number; expression: string }; result: { value: unknown } };
}

export type BrowserMethod = keyof BrowserMethods;

export type BrowserRequestMessage = {
  [M in BrowserMethod]: {
    type: 'browser.request';
    protocolVersion: typeof PROTOCOL_VERSION;
    requestId: string;
    method: M;
    session: ToolSession;
    params: BrowserMethods[M]['params'];
  };
}[BrowserMethod];

export interface BrowserResponseOkMessage {
  type: 'browser.response';
  protocolVersion: typeof PROTOCOL_VERSION;
  requestId: string;
  ok: true;
  result: unknown;
}

export interface BrowserResponseErrorMessage {
  type: 'browser.response';
  protocolVersion: typeof PROTOCOL_VERSION;
  requestId: string;
  ok: false;
  error: string;
}

export type BrowserResponseMessage = BrowserResponseOkMessage | BrowserResponseErrorMessage;

export type BrowserMessage =
  | BrowserHelloMessage
  | BrowserPingMessage
  | BrowserPongMessage
  | BrowserTabCountMessage
  | BrowserTabClosedMessage
  | BrowserResponseMessage;

export interface BrowserStatus {
  id: string;
  name: string;
  tabCount: number;
}

export interface ControlSessionRegisterRequest {
  type: 'control.request';
  protocolVersion: typeof PROTOCOL_VERSION;
  requestId: string;
  method: 'session.register';
  clientName: string;
}

export interface ControlStatusRequest {
  type: 'control.request';
  protocolVersion: typeof PROTOCOL_VERSION;
  requestId: string;
  method: 'status';
}

export type ToolMethod = 'tabs' | 'read' | 'screenshot' | 'act' | 'run_js';

/** A browser tool call from an MCP server. `session` is the calling MCP process and owns its tabs. */
export interface ControlToolRequest {
  type: 'control.request';
  protocolVersion: typeof PROTOCOL_VERSION;
  requestId: string;
  method: ToolMethod;
  session: ToolSession;
  params: Record<string, unknown>;
}

export type ToolContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };

export interface ControlStatusResponse {
  type: 'control.response';
  protocolVersion: typeof PROTOCOL_VERSION;
  requestId: string;
  ok: true;
  result: {
    browsers: BrowserStatus[];
  };
}

export interface ControlToolResponse {
  type: 'control.response';
  protocolVersion: typeof PROTOCOL_VERSION;
  requestId: string;
  ok: true;
  result: {
    content: ToolContent[];
  };
}

export interface ControlErrorResponse {
  type: 'control.response';
  protocolVersion: typeof PROTOCOL_VERSION;
  requestId: string | null;
  ok: false;
  error: string;
}

export interface ControlSessionRegisterResponse {
  type: 'control.response';
  protocolVersion: typeof PROTOCOL_VERSION;
  requestId: string;
  ok: true;
  result: {
    session: ToolSession;
  };
}

export type ControlRequest = ControlSessionRegisterRequest | ControlStatusRequest | ControlToolRequest;
export type ControlResponse =
  | ControlSessionRegisterResponse
  | ControlStatusResponse
  | ControlToolResponse
  | ControlErrorResponse;

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
