export const PROTOCOL_VERSION = 5 as const;
/** Shown when the extension and the background program speak different protocol versions. It is also a WebSocket close reason, so at most 123 bytes. */
export const PROTOCOL_MISMATCH = 'The T3-Tab extension and helper are different versions.';
/** The close reason and error text that say which side is behind. Each fits a WebSocket close reason. */
export const HELPER_OUTDATED = 'The T3-Tab helper is older than the extension.';
export const EXTENSION_OUTDATED = 'The T3-Tab extension is older than the helper.';
/** What a side that speaks `PROTOCOL_VERSION` says about a peer that spoke `theirs`. */
export function mismatchReason(theirs: number): string {
  return theirs > PROTOCOL_VERSION ? HELPER_OUTDATED : EXTENSION_OUTDATED;
}
export const DEFAULT_DAEMON_PORT = 8765;
export const NATIVE_HOST_NAME = 'com.t3tab.native';
/**
 * The extension's ID. The manifest `key` (`EXTENSION_KEY` in the extension) fixes it, so an unpacked build gets the
 * same ID on every machine.
 */
export const EXTENSION_ID = 'gggnknbjooockcnnocejdolfdpjifebm';
/**
 * STORE ID: the ID the browser store assigns once the extension is published. Fill it in then (the store's dashboard
 * also shows the public key to put in `EXTENSION_KEY`, which makes unpacked builds use this ID too). Until then it is
 * undefined and only `EXTENSION_ID` is allowed.
 */
export const STORE_EXTENSION_ID: string | undefined = undefined;
/** Every ID the native host manifest and the daemon accept. */
export const EXTENSION_IDS: readonly string[] = STORE_EXTENSION_ID === undefined ? [EXTENSION_ID] : [...new Set([EXTENSION_ID, STORE_EXTENSION_ID])];
export const EXTENSION_ORIGINS: readonly string[] = EXTENSION_IDS.map((id) => `chrome-extension://${id}`);
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

/** Sent when a permission prompt opens, so the daemon can show it in the thread of the session that asked. */
export interface BrowserPromptOpenedMessage {
  type: 'browser.promptOpened';
  protocolVersion: typeof PROTOCOL_VERSION;
  /** The session the prompt belongs to; only that session's control connection is told. */
  session: ToolSession;
  prompt: PromptNotice;
}

/** Sent when a permission prompt is decided, times out or is cancelled, wherever it was answered. */
export interface BrowserPromptClosedMessage {
  type: 'browser.promptClosed';
  protocolVersion: typeof PROTOCOL_VERSION;
  promptId: string;
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
  /** True for the session's current tab, the default target of the page tools: the last it opened or switched to. */
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
  /** Flags the reader prints, such as `checked`, `disabled`, `expanded`, `level`, and a link's `url`. */
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

/** Returns the target element ref of an `act` step, when the step names one. */
export function actStepRef(step: ActStep): string | undefined {
  if ('click' in step) return step.click.ref;
  if ('type' in step) return step.type.ref;
  if ('fill' in step) return step.fill.ref;
  if ('select' in step) return step.select.ref;
  if ('scroll' in step) return step.scroll.ref;
  if ('hover' in step) return step.hover.ref;
  return undefined;
}

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
  /** What the agent is told when the tab is waiting on a JavaScript dialog; `nodes` is empty then. */
  dialog?: string;
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

/** Why an MCP server could not take the claim code from the private file a direct run named. */
export type ClaimFileProblem = 'missing' | 'not-private' | 'wrong-owner' | 'not-a-file' | 'invalid' | 'unreadable';

/** Moves an existing tab: to an address, through its history, or by loading its page again. */
export type TabNavigation = 'goto' | 'back' | 'forward' | 'reload';

/** Requests the background program sends to the extension, with their params and results. */
export interface BrowserMethods {
  /** `t3ThreadId` is set only when the daemon proved which T3 thread the session's process runs for. */
  'session.register': { params: { t3ThreadId?: string }; result: { registered: true } };
  /**
   * Shares with the calling session the tabs the owner picked in the side panel when it started an agent. The
   * extension issued `code` and holds the tabs it names; the daemon only passes it on. `route` says how the code
   * arrived: `launch` from a direct run's private file, `message` from the `tabs` tool. A code works on one route.
   */
  'session.claim': { params: { code: string; route: ClaimRoute }; result: { shared: number[] } };
  'session.unregister': { params: Record<string, never>; result: { unregistered: true } };
  'tabs.list': { params: Record<string, never>; result: { tabs: TabInfo[] } };
  /** `redirectedFrom` is the origin asked for, set when the page ended up on another one. */
  'tabs.open': { params: { url: string }; result: { tab: TabInfo; redirectedFrom?: string } };
  'tabs.navigate': {
    params: { tab?: number; action: TabNavigation; url?: string };
    result: { tab: TabInfo; redirectedFrom?: string };
  };
  'tabs.switch': { params: { tab: number }; result: { tab: TabInfo } };
  'tabs.close': { params: { tab: number }; result: { closed: number } };
  'page.read': { params: { tab?: number }; result: PageReadResult };
  'page.screenshot': { params: { tab?: number; maxEdge: number }; result: ScreenshotResult };
  'page.act': {
    params: { tab?: number; steps: ActStep[]; backendIds: Array<number | null>; epoch: number };
    result: PageActionResult;
  };
  'page.eval': { params: { tab?: number; expression: string }; result: { value: unknown } };
  /**
   * Answers one waiting permission prompt on behalf of the session that owns it, from that session's own thread
   * (an MCP elicitation). Only these two answers are possible this way: never a lasting site setting.
   */
  'prompt.decide': { params: { promptId: string; decision: ElicitedDecision }; result: { decided: true } };
}

/** What an agent's own thread may answer a permission prompt with. */
export type ElicitedDecision = 'allow-once' | 'decline';

/** A permission prompt as the daemon and the owning session's MCP server see it. */
export interface PromptNotice {
  id: string;
  /** What the agent asked to do: the same four kinds the side panel's prompt names. */
  tool: 'read' | 'act' | 'run_js' | 'open';
  origin: string;
  /** The tab it concerns. A page being opened has none until the owner says yes. */
  tab?: { id: number; title: string };
  /** The address being opened or gone to, without credentials or fragment. */
  url?: string;
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

/** One entry of a conversation's thread view: a message, the agent's reasoning, or a tool call with its result. */
export type AgentItem =
  | {
      id: string;
      kind: 'user' | 'assistant' | 'reasoning' | 'error';
      text: string;
      /** True while the agent is still writing this text. */
      streaming?: boolean;
      /** When the item was added, in milliseconds since the epoch. */
      at?: number;
    }
  | {
      id: string;
      kind: 'tool';
      /** The tool's name without its server prefix, such as `read`, `act` or `status`. */
      name: string;
      /** What was asked, in one short line. */
      summary?: string;
      output?: string;
      status: 'running' | 'done' | 'failed';
    };

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
  /**
   * The thread view of a direct run, in order. A T3 thread shows no items: its thread is in T3 Code, which the panel
   * reads itself.
   */
  items: AgentItem[];
  /** When the current (or last) direct turn started, in milliseconds since the epoch. */
  startedAt?: number;
  /** When the last direct turn ended; absent while one is running. */
  finishedAt?: number;
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

export type SetupAgent = 'claude' | 'codex';

/** What the panel's setup steps show: which agents are installed and wired to T3-Tab, and whether T3 Code is around. */
export interface SetupStatus {
  agents: Array<{
    id: SetupAgent;
    /** The agent's command was found on this computer. */
    found: boolean;
    /** The `t3-tab` MCP entry is in that agent's user config. */
    registered: boolean;
  }>;
  t3: {
    state: T3State;
    /** T3 Code's address, such as `http://127.0.0.1:3773`, when it is running and the address is one T3-Tab can use. */
    origin?: string;
  };
}

/** The panel's new T3 session. The pairing credential behind it stays in the background program. */
export interface T3Pairing {
  origin: string;
  accessToken: string;
  /** Seconds until T3 ends this access token. */
  expiresIn: number;
}

/** What T3 answered to a session request the background program sent on a connection it checked. */
export type T3SessionReply =
  | { outcome: 'token'; accessToken: string; expiresIn: number }
  | { outcome: 'ticket'; ticket: string }
  /** T3's local voice transcription: whether it is available, and why not. */
  | { outcome: 'voice'; voice: T3VoiceStatus }
  /** T3 answered with this HTTP error. */
  | { outcome: 'refused'; status: number }
  /** T3 now runs at another address, so nothing was sent. */
  | { outcome: 'moved' };

/** What T3's `/api/voice/status` said, cut down to what the panel shows. */
export type T3VoiceStatus = { supported: false; reason: string } | { supported: true; state: 'ready' | 'missing-model' | 'transcribing' | 'other' };

export interface T3SessionParams {
  /** `ticket` is for T3's RPC socket, `media-ticket` for its voice socket. */
  kind: 'renew' | 'ticket' | 'media-ticket' | 'voice-status';
  origin: string;
  accessToken: string;
  /** A DPoP proof the panel signed for this request's method and address. */
  dpop: string;
}

/** The label T3-Tab's panel gives T3 for its pairing and for the session it opens, so a sign-out finds exactly those. */
export const T3_PANEL_CLIENT_LABEL = 'T3-Tab panel';

const CLAIM_NOTE_MARK = '\n\n[T3-Tab] ';

/**
 * The line added to a T3 thread's first message. A T3 thread's agent starts its MCP servers from its own
 * config, so nothing but the message can tell its session which tabs the owner picked.
 */
export function claimNote(code: string): string {
  return `${CLAIM_NOTE_MARK}The owner shared browser tabs with this thread. Before other browser tools, call the t3-tab \`tabs\` tool with {"claim": "${code}"}.`;
}

/** The message as the owner wrote it, without the claim note. */
export function withoutClaimNote(text: string): string {
  const index = text.indexOf(`${CLAIM_NOTE_MARK}The owner shared browser tabs`);
  return index === -1 ? text : text.slice(0, index);
}

/** An image that goes with a direct run's message: PNG, JPEG, GIF or WebP, base64-encoded. */
export interface AgentImage {
  name: string;
  mimeType: string;
  data: string;
}

export interface AgentStartParams {
  via: AgentVia;
  message: string;
  /** Direct runs only. */
  images?: AgentImage[];
  project?: string;
  provider?: string;
  model?: string;
  /** Issued by the extension for the tabs the owner shares with this conversation. */
  claim: string;
}

/** Requests the extension sends to the background program for the side panel, with their params and results. */
export interface DaemonMethods {
  'agents.status': { params: { refresh?: boolean }; result: AgentsStatus };
  'agents.list': { params: Record<string, never>; result: { conversations: AgentConversation[] } };
  'agents.start': { params: AgentStartParams; result: { conversation: AgentConversation } };
  'agents.send': { params: { id: string; message: string; claim?: string; images?: AgentImage[] }; result: { conversation: AgentConversation } };
  /** Which agents are installed and wired to T3-Tab, and whether T3 Code is running. */
  'setup.status': { params: { refresh?: boolean }; result: SetupStatus };
  /** Registers T3-Tab's MCP server in one agent's user config, as `t3-tab install --claude|--codex` does. */
  'setup.addAgent': { params: { agent: SetupAgent }; result: SetupStatus };
  /** Mints a pairing credential and exchanges it with the panel's proof on a connection checked to be T3's. */
  't3.pair': { params: { origin: string; dpop: string }; result: T3Pairing };
  /** Renews the panel's session or gets its WebSocket ticket, on a connection checked to be T3's. */
  't3.session': { params: T3SessionParams; result: T3SessionReply };
  /** The thread's runtime mode, as T3 reports it now. */
  't3.threadMode': { params: { threadId: string }; result: { runtimeMode: string } };
  /** Ends every T3 session the panel opened (those labelled `T3_PANEL_CLIENT_LABEL`). */
  't3.unpair': { params: Record<string, never>; result: { revoked: number } };
  /** One conversation, with its thread view. */
  'agents.get': { params: { id: string }; result: { conversation: AgentConversation } };
  /** Stops a direct run's current turn; the conversation goes back to idle. */
  'agents.stop': { params: { id: string }; result: { conversation: AgentConversation } };
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
  | BrowserPromptOpenedMessage
  | BrowserPromptClosedMessage
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
  /** Set instead of `claim` when the MCP process was given a claim file and could not use it. */
  claimFileProblem?: { file: string; problem: ClaimFileProblem };
  /** The MCP process's pid. The daemon believes it only if that process holds this connection's socket. */
  pid?: number;
}

export interface ControlStatusRequest {
  type: 'control.request';
  protocolVersion: typeof PROTOCOL_VERSION;
  requestId: string;
  method: 'status';
}

/** Answers a permission prompt of this connection's own session from its thread. */
export interface ControlPromptAnswerRequest {
  type: 'control.request';
  protocolVersion: typeof PROTOCOL_VERSION;
  requestId: string;
  method: 'prompt.answer';
  promptId: string;
  decision: ElicitedDecision;
}

/** Told to a session's MCP server, unasked, about its own permission prompts. */
export type ControlEvent =
  | { type: 'control.event'; protocolVersion: typeof PROTOCOL_VERSION; event: 'prompt.opened'; prompt: PromptNotice }
  | { type: 'control.event'; protocolVersion: typeof PROTOCOL_VERSION; event: 'prompt.closed'; promptId: string };

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

export type ControlRequest =
  | ControlSessionRegisterRequest
  | ControlStatusRequest
  | ControlToolRequest
  | ControlPromptAnswerRequest;
export interface ControlPromptAnswerResponse {
  type: 'control.response';
  protocolVersion: typeof PROTOCOL_VERSION;
  requestId: string;
  ok: true;
  result: { answered: true };
}

export type ControlResponse =
  | ControlPromptAnswerResponse
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
