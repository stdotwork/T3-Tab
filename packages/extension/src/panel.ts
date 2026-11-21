import {
  isOriginKey,
  originOf,
  type PermissionDecision,
  type PermissionPrompt,
  type SitePermission,
  type StoredSitePermission,
} from './permissions';
import { permissionPrompts, sessionStore, siteStore } from './runtime';
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

export type PanelRequest =
  | { type: 'panel.state'; tabId?: number }
  | { type: 'panel.shareTab'; sessionId: string; tabId?: number }
  | { type: 'panel.unshareTab'; sessionId: string; tabId?: number }
  | { type: 'panel.decide'; promptId: string; decision: PermissionDecision }
  | { type: 'panel.setSite'; origin: string; setting: SitePermission };

/** The extension API the side panel uses; the end-to-end harness calls the same messages. */
export async function handlePanelRequest(value: unknown): Promise<PanelState | { ok: true }> {
  const request = parsePanelRequest(value);
  if (request.type === 'panel.state') return await panelState(request.tabId);
  if (request.type === 'panel.shareTab') {
    const tab = await panelTab(request.tabId);
    await sessionStore.share(request.sessionId, tab.id);
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
  if (
    candidate.type === 'panel.decide' &&
    typeof candidate.promptId === 'string' &&
    (candidate.decision === 'allow-once' || candidate.decision === 'always-allow' || candidate.decision === 'decline')
  ) {
    return { type: 'panel.decide', promptId: candidate.promptId, decision: candidate.decision };
  }
  if (
    candidate.type === 'panel.setSite' &&
    typeof candidate.origin === 'string' &&
    isOriginKey(candidate.origin) &&
    (candidate.setting === 'ask' || candidate.setting === 'allow')
  ) {
    return { type: 'panel.setSite', origin: candidate.origin, setting: candidate.setting };
  }
  throw new Error('Invalid panel request');
}
