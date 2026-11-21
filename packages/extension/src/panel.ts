import type { AgentConversation, AgentsStatus, AgentVia } from '@t3-tab/protocol';

import { newClaimCode, type ClaimTab } from './claims';
import { askDaemon } from './daemon-link';
import {
  isOriginKey,
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
}

/** What the panel's agent section shows: which agents can run, the tabs a start would share, and the conversations. */
export interface AgentPanelState {
  status: AgentsStatus;
  shareTabs: PanelTab[];
  conversations: AgentConversation[];
}

export interface AgentStartRequest {
  type: 'panel.agentStart';
  via: AgentVia;
  message: string;
  project?: string;
  provider?: string;
  model?: string;
  tabId?: number;
}

export type PanelRequest =
  | { type: 'panel.state'; tabId?: number }
  | { type: 'panel.agents'; refresh?: boolean; tabId?: number }
  | AgentStartRequest
  | { type: 'panel.agentSend'; id: string; message: string }
  | { type: 'panel.shareTab'; sessionId: string; tabId?: number }
  | { type: 'panel.unshareTab'; sessionId: string; tabId?: number }
  | { type: 'panel.decide'; promptId: string; decision: PermissionDecision }
  | { type: 'panel.setSite'; origin: string; setting: SitePermission };

/** The extension API the side panel uses; the end-to-end harness calls the same messages. */
export async function handlePanelRequest(
  value: unknown,
): Promise<PanelState | AgentPanelState | { conversation: AgentConversation } | { ok: true }> {
  const request = parsePanelRequest(value);
  if (request.type === 'panel.state') return await panelState(request.tabId);
  if (request.type === 'panel.agents') return await agentPanelState(request.refresh === true, request.tabId);
  if (request.type === 'panel.agentStart') return await startAgent(request);
  if (request.type === 'panel.agentSend') return await askDaemon('agents.send', { id: request.id, message: request.message });
  if (request.type === 'panel.shareTab') {
    const tab = await panelTab(request.tabId);
    await sessionStore.share(request.sessionId, tab.id, originOf(tab.url));
    return { ok: true };
  }
  if (request.type === 'panel.unshareTab') {
    const tab = await panelTab(request.tabId);
    await sessionStore.unshare(request.sessionId, tab.id);
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
  return { sessions, pending, sites: visibleSites, currentTab };
}

async function agentPanelState(refresh: boolean, tabId: number | undefined): Promise<AgentPanelState> {
  const [status, list, shareTabs] = await Promise.all([
    askDaemon('agents.status', refresh ? { refresh: true } : {}),
    askDaemon('agents.list', {}),
    shareTargets(tabId).catch(() => []),
  ]);
  return { status, conversations: list.conversations, shareTabs };
}

/**
 * Starts an agent with the owner's current tab, or every tab of the current tab's group when the owner grouped it
 * themselves. The extension issues the claim code here, so only a start from the panel can share tabs.
 */
async function startAgent(request: AgentStartRequest): Promise<{ conversation: AgentConversation }> {
  const tabs = await shareTargets(request.tabId);
  const claimTabs: ClaimTab[] = tabs.map((tab) => {
    const origin = originOf(tab.url);
    return origin === undefined ? { tabId: tab.id } : { tabId: tab.id, origin };
  });
  const claim = newClaimCode();
  await claimStore.issue(claim, claimTabs);
  const params = { via: request.via, message: request.message, claim, ...optionalFields(request) };
  try {
    return await askDaemon('agents.start', params);
  } catch (error) {
    await claimStore.revoke(claim);
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
export async function shareTargets(tabId: number | undefined): Promise<PanelTab[]> {
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
    return request;
  }
  if (candidate.type === 'panel.agentSend' && typeof candidate.id === 'string' && typeof candidate.message === 'string') {
    return { type: 'panel.agentSend', id: candidate.id, message: candidate.message };
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
