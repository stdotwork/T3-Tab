export const PROTOCOL_VERSION = 2 as const;
/** Shown when the extension and the background program speak different protocol versions. It is also a WebSocket close reason, so at most 123 bytes. */
export const PROTOCOL_MISMATCH = 'T3-Tab extension and background program are different versions. Rebuild, run t3-tab install, reload.';
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

/** How a claim code reaches the session that redeems it. */
export type ClaimRoute = 'launch' | 'message';

/** Requests the background program sends to the extension, with their params and results. */
export interface BrowserMethods {
  'session.register': { params: Record<string, never>; result: { registered: true } };
  /**
   * Shares with the calling session the tabs the owner picked in the side panel when it started an agent. The
   * extension issued `code` and holds the tabs it names; the daemon only passes it on. `route` says how the code
   * arrived: `launch` from a direct run's private file, `message` from the `tabs` tool. A code works on one route.
   */
  'session.claim': { params: { code: string; route: ClaimRoute }; result: { shared: number[] } };
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

/** How a side-panel conversation runs: as a T3 Code thread, or as Claude Code or Codex started directly. */
export type AgentVia = 't3' | 'claude' | 'codex';

export type AgentStatus = 'running' | 'waiting' | 'idle' | 'failed';

export interface AgentMessage {
  role: 'user' | 'assistant' | 'error';
  text: string;
}

/** One conversation the side panel started. The daemon holds it in memory. */
export interface AgentConversation {
  id: string;
  via: AgentVia;
  title: string;
  status: AgentStatus;
  /** The T3 thread id, or the Claude Code or Codex session id once the CLI reported it. */
  threadId?: string;
  /** For a T3 thread: the project id or path. For a direct run: the working folder. */
  project?: string;
  provider?: string;
  model?: string;
  messages: AgentMessage[];
  error?: string;
  updatedAt: number;
}

export type T3State = 'running' | 'stopped' | 'missing' | 'error';

export interface AgentsStatus {
  t3: { state: T3State; path?: string; detail?: string };
  /** Paths of the agent CLIs a direct run would use, when found. */
  claude?: string;
  codex?: string;
}

export interface AgentStartParams {
  via: AgentVia;
  message: string;
  project?: string;
  provider?: string;
  model?: string;
  /** Issued by the extension for the tabs the owner shares with this conversation. */
  claim: string;
}

/** A T3 project the panel can start a thread in, as T3's `t3_project_list` reports it. */
export interface T3Project {
  id: string;
  title: string;
  workspaceRoot: string;
  /** The project's default provider instance and model, when it has one. */
  defaultProvider?: string;
  defaultModel?: string;
}

/** A T3 provider instance and the models `orchestrator_capabilities` lists for it. */
export interface T3Provider {
  instanceId: string;
  name: string;
  models: Array<{ id: string; label?: string }>;
  /** Models T3 left out of its short list. */
  omittedModels?: number;
  /** Why T3 says the provider cannot run now, when it says so. */
  unavailable?: string;
}

export interface T3Catalog {
  projects: T3Project[];
  providers: T3Provider[];
  fetchedAt: number;
}

/**
 * T3-Tab's own read-only sign-in to T3 Code, used only to list projects, providers and models. The credential stays
 * in the background program; this view never carries it.
 */
export interface T3Access {
  state: 'signed-out' | 'signing-in' | 'signed-in';
  /** The T3 environment address, such as `http://127.0.0.1:3773`. */
  environment?: string;
  /** When T3 ends the sign-in, in milliseconds since the epoch. */
  expiresAt?: number;
  /** One line: why the lists are unavailable, or what the last sign-in attempt did. */
  detail?: string;
  catalog?: T3Catalog;
}

/** Requests the extension sends to the background program for the side panel, with their params and results. */
export interface DaemonMethods {
  'agents.status': { params: { refresh?: boolean }; result: AgentsStatus };
  'agents.list': { params: Record<string, never>; result: { conversations: AgentConversation[] } };
  'agents.start': { params: AgentStartParams; result: { conversation: AgentConversation } };
  'agents.send': { params: { id: string; message: string; claim?: string }; result: { conversation: AgentConversation } };
  /** The sign-in state and, when signed in, T3's lists; `refresh` fetches the lists again. */
  't3.access': { params: { refresh?: boolean }; result: T3Access };
  /** Starts a sign-in and returns the T3 page the owner approves it on. */
  't3.signIn': { params: Record<string, never>; result: { url: string } };
  't3.signOut': { params: Record<string, never>; result: T3Access };
}

export type DaemonMethod = keyof DaemonMethods;

export type BrowserDaemonRequestMessage = {
  [M in DaemonMethod]: {
    type: 'browser.daemonRequest';
    protocolVersion: typeof PROTOCOL_VERSION;
    requestId: string;
    method: M;
    params: DaemonMethods[M]['params'];
  };
}[DaemonMethod];

export type DaemonReplyMessage =
  | { type: 'daemon.reply'; protocolVersion: typeof PROTOCOL_VERSION; requestId: string; ok: true; result: unknown }
  | { type: 'daemon.reply'; protocolVersion: typeof PROTOCOL_VERSION; requestId: string; ok: false; error: string };

export type BrowserMessage =
  | BrowserHelloMessage
  | BrowserDaemonRequestMessage
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
  /** A side-panel claim code the MCP process read from its private file, for a direct run. */
  claim?: string;
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
