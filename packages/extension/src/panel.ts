import {
  claimNote,
  type AgentConversation,
  type AgentsStatus,
  type AgentVia,
  type SetupAgent,
  type SetupStatus,
  type T3Access,
  type T3Pairing,
  type T3SessionParams,
  type T3SessionReply,
} from '@t3-tab/protocol';

import { newClaimCode, removeConversationTab, T3_CONVERSATION_PREFIX, type ClaimTab } from './claims';
import { BUILD_ID } from './build-id';
import { askDaemon, daemonLinkState, type HelperState } from './daemon-link';
import {
  isOriginKey,
  type AutoAllowed,
  originOf,
  type PermissionDecision,
  type PermissionPrompt,
  type SitePermission,
  type StoredSitePermission,
} from './permissions';
import { claimStore, permissionPrompts, sessionStore, siteStore } from './runtime';
import type { StoredSession } from './sessions';

export interface PanelTab {
  id: number;
  title: string;
  url: string;
}

export interface PanelState {
  sessions: StoredSession[];
  currentTab: PanelTab | undefined;
  pending: PermissionPrompt[];
  sites: StoredSitePermission[];
  /** The last requests let through without a prompt because the thread has full access in T3 Code. */
  autoAllowed: AutoAllowed[];
}

/**
 * What the panel's agent section shows: which agents can run, the tabs a start would share, the conversations, and
 * T3-Tab's read-only T3 sign-in with T3's project and model lists.
 */
export interface AgentPanelState {
  status: AgentsStatus;
  shareTabs: PanelTab[];
  conversations: AgentConversation[];
  t3Access: T3Access;
  /** The owner's tabs each conversation holds, by conversation id. A closed tab is left out. */
  conversationTabs: Record<string, PanelTab[]>;
}

export interface AgentStartRequest {
  type: 'panel.agentStart';
  via: AgentVia;
  message: string;
  project?: string;
  provider?: string;
  model?: string;
  tabId?: number;
  /** The owner took the tab chip off: the run starts with no shared tabs. */
  noTabs?: boolean;
}

export type PanelRequest =
  | { type: 'panel.state'; tabId?: number }
  | { type: 'panel.helper' }
  | { type: 'panel.build' }
  | { type: 'panel.setup'; refresh?: boolean }
  | { type: 'panel.addAgent'; agent: SetupAgent }
  | { type: 'panel.t3Pair'; origin: string; dpop: string }
  | ({ type: 'panel.t3Session' } & T3SessionParams)
  | { type: 'panel.t3Unpair' }
  | { type: 'panel.agentGet'; id: string }
  | { type: 'panel.agentStop'; id: string }
  | { type: 'panel.t3Claim'; tabId?: number }
  | { type: 'panel.t3ClaimBind'; code: string; threadId: string }
  | { type: 'panel.t3ClaimRevoke'; code: string }
  | { type: 'panel.agents'; refresh?: boolean; tabId?: number }
  | AgentStartRequest
  | { type: 'panel.agentSend'; id: string; message: string }
  | { type: 'panel.t3SignIn' }
  | { type: 'panel.t3SignOut' }
  | { type: 'panel.agentRemoveTab'; id: string; tabId: number }
  | { type: 'panel.conversationTabs'; id: string }
  | { type: 'panel.shareTab'; sessionId: string; tabId?: number }
  | { type: 'panel.unshareTab'; sessionId: string; tabId?: number }
  | { type: 'panel.decide'; promptId: string; decision: PermissionDecision }
  | { type: 'panel.setSite'; origin: string; setting: SitePermission };

/** The extension API the side panel uses; the end-to-end harness calls the same messages. */
export async function handlePanelRequest(
  value: unknown,
): Promise<
  | PanelState
  | { tabs: PanelTab[] }
  | AgentPanelState
  | { conversation: AgentConversation }
  | T3Access
  | HelperState
  | { buildId: string }
  | SetupStatus
  | T3Pairing
  | T3SessionReply
  | T3ClaimResult
  | { revoked: number }
  | { ok: true }
> {
  const request = parsePanelRequest(value);
  if (request.type === 'panel.state') return await panelState(request.tabId);
  if (request.type === 'panel.helper') return await daemonLinkState();
  if (request.type === 'panel.build') return { buildId: BUILD_ID };
  if (request.type === 'panel.setup') return await askDaemon('setup.status', request.refresh === true ? { refresh: true } : {});
  if (request.type === 'panel.addAgent') return await askDaemon('setup.addAgent', { agent: request.agent });
  if (request.type === 'panel.t3Pair') return await askDaemon('t3.pair', { origin: request.origin, dpop: request.dpop });
  if (request.type === 'panel.t3Session') {
    const { kind, origin, accessToken, dpop } = request;
    return await askDaemon('t3.session', { kind, origin, accessToken, dpop });
  }
  if (request.type === 'panel.t3Unpair') return await askDaemon('t3.unpair', {});
  if (request.type === 'panel.agentGet') return await askDaemon('agents.get', { id: request.id });
  if (request.type === 'panel.agentStop') return await askDaemon('agents.stop', { id: request.id });
  if (request.type === 'panel.t3Claim') return await issueT3Claim(request.tabId);
  if (request.type === 'panel.t3ClaimBind') {
    if (!(await claimStore.bindByCode(request.code, t3ConversationKey(request.threadId)))) throw new Error('Unknown claim code');
    return { ok: true };
  }
  if (request.type === 'panel.t3ClaimRevoke') {
    await revokeClaim(request.code);
    return { ok: true };
  }
  if (request.type === 'panel.agents') return await agentPanelState(request.refresh === true, request.tabId);
  if (request.type === 'panel.agentStart') return await startAgent(request);
  if (request.type === 'panel.agentSend') return await sendToAgent(request.id, request.message);
  if (request.type === 'panel.t3SignIn') return await signInToT3();
  if (request.type === 'panel.t3SignOut') return await askDaemon('t3.signOut', {});
  if (request.type === 'panel.conversationTabs') {
    const held = (await claimStore.conversationTabs())[request.id] ?? [];
    const tabs = await Promise.all(held.map(async ({ tabId }) => await panelTab(tabId).catch(() => undefined)));
    return { tabs: tabs.filter((tab) => tab !== undefined) };
  }
  if (request.type === 'panel.agentRemoveTab') {
    await removeConversationTab(claimStore, sessionStore, request.id, request.tabId);
    return { ok: true };
  }
  if (request.type === 'panel.shareTab') {
    const tab = await panelTab(request.tabId);
    await sessionStore.share(request.sessionId, tab.id, originOf(tab.url));
    return { ok: true };
  }
  if (request.type === 'panel.unshareTab') {
    const tab = await panelTab(request.tabId);
    await sessionStore.unshare(request.sessionId, tab.id);
    await claimStore.forgetTab(request.sessionId, tab.id);
    return { ok: true };
  }
  if (request.type === 'panel.decide') {
    await permissionPrompts.decide(request.promptId, request.decision);
    return { ok: true };
  }
  await siteStore.set(request.origin, request.setting);
  return { ok: true };
}

async function panelState(tabId: number | undefined): Promise<PanelState> {
  const [sessions, pending, sites, currentTab] = await Promise.all([
    sessionStore.list(),
    Promise.resolve(permissionPrompts.list()),
    siteStore.list(),
    panelTab(tabId).catch(() => undefined),
  ]);
  let visibleSites = sites;
  if (currentTab !== undefined) {
    const origin = originOf(currentTab.url);
    if (origin !== undefined && !sites.some((site) => site.origin === origin)) {
      const currentSite: StoredSitePermission = { origin, setting: 'ask' };
      visibleSites = [...sites, currentSite].sort((left, right) => left.origin.localeCompare(right.origin));
    }
  }
  return { sessions, pending, sites: visibleSites, currentTab, autoAllowed: permissionPrompts.autoAllowed() };
}

async function agentPanelState(refresh: boolean, tabId: number | undefined): Promise<AgentPanelState> {
  const [status, list, shareTabs, held, t3Access] = await Promise.all([
    askDaemon('agents.status', refresh ? { refresh: true } : {}),
    askDaemon('agents.list', {}),
    shareTargets(tabId).catch(() => []),
    claimStore.conversationTabs(),
    askDaemon('t3.access', refresh ? { refresh: true } : {}).catch(
      (error: unknown): T3Access => ({ state: 'signed-out', detail: error instanceof Error ? error.message : String(error) }),
    ),
  ]);
  const conversationTabs: Record<string, PanelTab[]> = {};
  for (const conversation of list.conversations) {
    const tabs = await Promise.all((held[conversation.id] ?? []).map(async ({ tabId: id }) => await panelTab(id).catch(() => undefined)));
    conversationTabs[conversation.id] = tabs.filter((tab) => tab !== undefined);
  }
  return { status, conversations: list.conversations, shareTabs, conversationTabs, t3Access };
}

/**
 * Asks the background program to start the sign-in, then opens T3's approval page in a normal tab of this browser,
 * where the owner approves it in T3 Code's own page. The tab joins no session, and the extension never sees the
 * credential: T3 sends the answer to the background program's one-use listener.
 */
async function signInToT3(): Promise<{ ok: true }> {
  const { url } = await askDaemon('t3.signIn', {});
  const page = new URL(url);
  if (page.protocol !== 'http:' && page.protocol !== 'https:') throw new Error('The T3 sign-in page has an address T3-Tab does not open');
  await chrome.tabs.create({ url: page.href, active: true });
  return { ok: true };
}

/**
 * Starts an agent with the owner's current tab, or every tab of the current tab's group when the owner grouped it
 * themselves. The extension issues the claim code here, so only a start from the panel can share tabs.
 */
async function startAgent(request: AgentStartRequest): Promise<{ conversation: AgentConversation }> {
  const tabs = request.noTabs === true ? [] : await shareTargets(request.tabId);
  const claimTabs: ClaimTab[] = tabs.map((tab) => {
    const origin = originOf(tab.url);
    return origin === undefined ? { tabId: tab.id } : { tabId: tab.id, origin };
  });
  const claim = newClaimCode();
  // A direct run gets its code through a private file; a T3 thread's agent can only read it in its first message.
  const grant = await claimStore.issue(claim, claimTabs, { route: request.via === 't3' ? 'message' : 'launch' });
  const params = { via: request.via, message: request.message, claim, ...optionalFields(request) };
  try {
    const started = await askDaemon('agents.start', params);
    await claimStore.bindConversation(grant, started.conversation.id);
    return started;
  } catch (error) {
    await revokeClaim(claim);
    throw error;
  }
}

/** What the panel needs to start a T3 thread that shares the owner's tabs. */
export interface T3ClaimResult {
  code: string;
  /** The line to add to the thread's first message: the agent reads the code from it and claims the tabs. */
  note: string;
  tabs: PanelTab[];
}

/** The key a claim's grant uses for a T3 thread the panel started itself. */
function t3ConversationKey(threadId: string): string {
  return `${T3_CONVERSATION_PREFIX}${threadId}`;
}

/**
 * Issues a claim code for the owner's current tab (or its group, by the rule `startAgent` uses) for a thread the panel
 * launches over its own connection to T3. Whether the thread has Full access is asked of T3 when a request needs it.
 */
async function issueT3Claim(tabId: number | undefined): Promise<T3ClaimResult> {
  const tabs = await shareTargets(tabId);
  const claimTabs: ClaimTab[] = tabs.map((tab) => {
    const origin = originOf(tab.url);
    return origin === undefined ? { tabId: tab.id } : { tabId: tab.id, origin };
  });
  const code = newClaimCode();
  await claimStore.issue(code, claimTabs, { route: 'message' });
  return { code, note: claimNote(code), tabs };
}

/** Withdraws a code, and takes back any tab an agent got through it if no thread was ever bound to it. */
async function revokeClaim(code: string): Promise<void> {
  for (const { sessionId, tabId } of await claimStore.revoke(code)) await sessionStore.dropShare([sessionId], tabId);
}

/** Each turn of a direct run is a new process and session, so it gets a new code for the tabs still shared. */
async function sendToAgent(id: string, message: string): Promise<{ conversation: AgentConversation }> {
  const claim = newClaimCode();
  const renewed = await claimStore.renew(id, claim);
  try {
    return await askDaemon('agents.send', { id, message, ...(renewed ? { claim } : {}) });
  } catch (error) {
    if (renewed) await revokeClaim(claim);
    throw error;
  }
}

function optionalFields(request: AgentStartRequest): { project?: string; provider?: string; model?: string } {
  const fields: { project?: string; provider?: string; model?: string } = {};
  if (request.project !== undefined) fields.project = request.project;
  if (request.provider !== undefined) fields.provider = request.provider;
  if (request.model !== undefined) fields.model = request.model;
  return fields;
}

/** The current tab, or all tabs of its group when that group is the owner's own rather than a session's. */
async function shareTargets(tabId: number | undefined): Promise<PanelTab[]> {
  const current = await panelTab(tabId);
  const tab = await chrome.tabs.get(current.id);
  const groupId = tab.groupId;
  if (groupId === undefined || groupId === chrome.tabGroups.TAB_GROUP_ID_NONE) return [current];
  const sessions = await sessionStore.list();
  if (sessions.some((session) => session.groupId === groupId)) return [current];
  const members = await chrome.tabs.query({ groupId });
  return members.flatMap((member) =>
    member.id === undefined ? [] : [{ id: member.id, title: member.title ?? '', url: member.url ?? member.pendingUrl ?? '' }],
  );
}

async function panelTab(tabId: number | undefined): Promise<PanelTab> {
  const tab =
    tabId === undefined
      ? (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]
      : await chrome.tabs.get(tabId).catch(() => undefined);
  if (tab?.id === undefined) throw new Error('No current tab');
  return { id: tab.id, title: tab.title ?? '', url: tab.url ?? tab.pendingUrl ?? '' };
}

function parsePanelRequest(value: unknown): PanelRequest {
  if (typeof value !== 'object' || value === null) throw new Error('Invalid panel request');
  const candidate = value as Record<string, unknown>;
  if (candidate.type === 'panel.state') {
    return Number.isInteger(candidate.tabId)
      ? { type: 'panel.state', tabId: candidate.tabId as number }
      : { type: 'panel.state' };
  }
  if ((candidate.type === 'panel.shareTab' || candidate.type === 'panel.unshareTab') && typeof candidate.sessionId === 'string') {
    return Number.isInteger(candidate.tabId)
      ? { type: candidate.type, sessionId: candidate.sessionId, tabId: candidate.tabId as number }
      : { type: candidate.type, sessionId: candidate.sessionId };
  }
  if (candidate.type === 'panel.agents') {
    const request: PanelRequest = { type: 'panel.agents', refresh: candidate.refresh === true };
    if (Number.isInteger(candidate.tabId)) request.tabId = candidate.tabId as number;
    return request;
  }
  if (
    candidate.type === 'panel.agentStart' &&
    (candidate.via === 't3' || candidate.via === 'claude' || candidate.via === 'codex') &&
    typeof candidate.message === 'string'
  ) {
    const request: AgentStartRequest = { type: 'panel.agentStart', via: candidate.via, message: candidate.message };
    for (const key of ['project', 'provider', 'model'] as const) {
      const field = candidate[key];
      if (typeof field === 'string' && field.trim() !== '') request[key] = field.trim();
    }
    if (Number.isInteger(candidate.tabId)) request.tabId = candidate.tabId as number;
    if (candidate.noTabs === true) request.noTabs = true;
    return request;
  }
  if (candidate.type === 'panel.conversationTabs' && typeof candidate.id === 'string') return { type: 'panel.conversationTabs', id: candidate.id };
  if (candidate.type === 'panel.t3SignIn' || candidate.type === 'panel.t3SignOut') return { type: candidate.type };
  if (candidate.type === 'panel.t3Pair' && typeof candidate.origin === 'string' && typeof candidate.dpop === 'string') {
    return { type: 'panel.t3Pair', origin: candidate.origin, dpop: candidate.dpop };
  }
  if (
    candidate.type === 'panel.t3Session' &&
    (candidate.kind === 'renew' || candidate.kind === 'ticket') &&
    typeof candidate.origin === 'string' &&
    typeof candidate.accessToken === 'string' &&
    typeof candidate.dpop === 'string'
  ) {
    return { type: 'panel.t3Session', kind: candidate.kind, origin: candidate.origin, accessToken: candidate.accessToken, dpop: candidate.dpop };
  }
  if (candidate.type === 'panel.helper' || candidate.type === 'panel.build' || candidate.type === 'panel.t3Unpair') {
    return { type: candidate.type };
  }
  if (candidate.type === 'panel.setup') return { type: 'panel.setup', refresh: candidate.refresh === true };
  if (candidate.type === 'panel.addAgent' && (candidate.agent === 'claude' || candidate.agent === 'codex')) {
    return { type: 'panel.addAgent', agent: candidate.agent };
  }
  if ((candidate.type === 'panel.agentGet' || candidate.type === 'panel.agentStop') && typeof candidate.id === 'string') {
    return { type: candidate.type, id: candidate.id };
  }
  if (candidate.type === 'panel.t3Claim') {
    return Number.isInteger(candidate.tabId) ? { type: 'panel.t3Claim', tabId: candidate.tabId as number } : { type: 'panel.t3Claim' };
  }
  if (candidate.type === 'panel.t3ClaimBind' && typeof candidate.code === 'string' && typeof candidate.threadId === 'string' && candidate.threadId !== '') {
    return { type: 'panel.t3ClaimBind', code: candidate.code, threadId: candidate.threadId };
  }
  if (candidate.type === 'panel.t3ClaimRevoke' && typeof candidate.code === 'string') return { type: 'panel.t3ClaimRevoke', code: candidate.code };
  if (candidate.type === 'panel.agentSend' && typeof candidate.id === 'string' && typeof candidate.message === 'string') {
    return { type: 'panel.agentSend', id: candidate.id, message: candidate.message };
  }
  if (candidate.type === 'panel.agentRemoveTab' && typeof candidate.id === 'string' && Number.isInteger(candidate.tabId)) {
    return { type: 'panel.agentRemoveTab', id: candidate.id, tabId: candidate.tabId as number };
  }
  if (
    candidate.type === 'panel.decide' &&
    typeof candidate.promptId === 'string' &&
    (candidate.decision === 'allow-once' ||
      candidate.decision === 'always-allow-read' ||
      candidate.decision === 'always-allow' ||
      candidate.decision === 'decline')
  ) {
    return { type: 'panel.decide', promptId: candidate.promptId, decision: candidate.decision };
  }
  if (
    candidate.type === 'panel.setSite' &&
    typeof candidate.origin === 'string' &&
    isOriginKey(candidate.origin) &&
    (candidate.setting === 'ask' || candidate.setting === 'read' || candidate.setting === 'allow')
  ) {
    return { type: 'panel.setSite', origin: candidate.origin, setting: candidate.setting };
  }
  throw new Error('Invalid panel request');
}
