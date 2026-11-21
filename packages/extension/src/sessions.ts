import type { TabInfo, ToolSession } from '@t3-tab/protocol';

import { isOriginKey, restrictedPageReason } from './permissions';

export interface StoredSession extends ToolSession {
  groupId?: number;
  sharedTabIds: number[];
  /** Origins approved for this session on each tab, keyed by tab id. */
  approvedOrigins: Record<string, string[]>;
  /** Last origin observed for each tab. A different origin invalidates its approvals. */
  currentOrigins: Record<string, string>;
}

export type SessionColor = 'grey' | 'blue' | 'red' | 'yellow' | 'green' | 'pink' | 'purple' | 'cyan' | 'orange';
const COLORS: SessionColor[] = ['blue', 'green', 'purple', 'orange', 'pink', 'cyan', 'yellow', 'red'];

export function canSessionUseTab(session: StoredSession, tab: { groupId?: number | undefined; id?: number | undefined }): boolean {
  return (
    (session.groupId !== undefined && tab.groupId === session.groupId) ||
    (tab.id !== undefined && session.sharedTabIds.includes(tab.id))
  );
}

export function assertSessionTab(session: StoredSession, tab: { groupId?: number | undefined; id?: number | undefined }): void {
  if (canSessionUseTab(session, tab)) return;
  throw new Error(
    `Tab ${tab.id ?? 'unknown'} is not available to this session. Only tabs in its tab group or tabs the owner shared can be used.`,
  );
}

export function usableSessionTabs(session: StoredSession, tabs: chrome.tabs.Tab[]): chrome.tabs.Tab[] {
  return tabs.filter(
    (tab) =>
      tab.id !== undefined &&
      canSessionUseTab(session, tab) &&
      restrictedPageReason(tab.url ?? tab.pendingUrl ?? '') === undefined,
  );
}

export function tabInfo(tab: chrome.tabs.Tab, active: boolean): TabInfo {
  const info: TabInfo = {
    id: tab.id ?? -1,
    title: tab.title ?? '',
    url: tab.url ?? tab.pendingUrl ?? '',
    active,
  };
  if (tab.groupId !== undefined && tab.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE) info.groupId = tab.groupId;
  return info;
}

export function sessionColor(id: string): SessionColor {
  let hash = 0;
  for (const character of id) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return COLORS[hash % COLORS.length] ?? 'blue';
}

export function groupTitle(name: string): string {
  return name.length <= 50 ? name : `${name.slice(0, 47)}…`;
}

const SESSIONS_KEY = 'sessions';
let mutation = Promise.resolve();

/** Session records (including group and shares) survive the service worker stopping within one browser run. */
export class SessionStore {
  async get(id: string): Promise<StoredSession | undefined> {
    await mutation;
    return (await this.all())[id];
  }

  async register(session: ToolSession): Promise<StoredSession> {
    return await this.mutate((sessions) => {
      const existing = sessions[session.id];
      if (existing !== undefined) {
        existing.name = session.name;
        return existing;
      }
      const created: StoredSession = { ...session, sharedTabIds: [], approvedOrigins: {}, currentOrigins: {} };
      sessions[session.id] = created;
      return created;
    });
  }

  async unregister(id: string): Promise<void> {
    await this.mutate((sessions) => {
      delete sessions[id];
    });
  }

  async rememberGroup(id: string, groupId: number): Promise<StoredSession> {
    return await this.mutate((sessions) => {
      const session = sessions[id];
      if (session === undefined) throw new Error('Session is not registered');
      session.groupId = groupId;
      return session;
    });
  }

  async share(id: string, tabId: number, origin: string | undefined): Promise<StoredSession> {
    return await this.mutate((sessions) => {
      const session = sessions[id];
      if (session === undefined) throw new Error('Session is not registered');
      if (!session.sharedTabIds.includes(tabId)) session.sharedTabIds.push(tabId);
      if (origin !== undefined) approve(session, tabId, origin);
      return session;
    });
  }

  async approveOrigin(id: string, tabId: number, origin: string): Promise<void> {
    await this.mutate((sessions) => {
      const session = sessions[id];
      if (session === undefined) throw new Error('Session is not registered');
      approve(session, tabId, origin);
    });
  }

  async observeTabOrigin(tabId: number, origin: string | undefined): Promise<void> {
    await this.mutate((sessions) => {
      for (const session of Object.values(sessions)) {
        const key = String(tabId);
        if (origin === undefined) {
          delete session.approvedOrigins[key];
          delete session.currentOrigins[key];
        } else if (session.currentOrigins[key] !== origin) {
          delete session.approvedOrigins[key];
          session.currentOrigins[key] = origin;
        }
      }
    });
  }

  async hasApprovedOrigin(id: string, tabId: number, origin: string): Promise<boolean> {
    const session = await this.get(id);
    return session?.approvedOrigins[String(tabId)]?.includes(origin) === true;
  }

  async forGroup(groupId: number): Promise<StoredSession | undefined> {
    return (await this.list()).find((session) => session.groupId === groupId);
  }

  async forgetTab(tabId: number): Promise<void> {
    await this.mutate((sessions) => {
      for (const session of Object.values(sessions)) {
        session.sharedTabIds = session.sharedTabIds.filter((value) => value !== tabId);
        delete session.approvedOrigins[String(tabId)];
        delete session.currentOrigins[String(tabId)];
      }
    });
  }

  async unshare(id: string, tabId: number): Promise<StoredSession> {
    return await this.mutate((sessions) => {
      const session = sessions[id];
      if (session === undefined) throw new Error('Session is not registered');
      session.sharedTabIds = session.sharedTabIds.filter((value) => value !== tabId);
      return session;
    });
  }

  async list(): Promise<StoredSession[]> {
    await mutation;
    return Object.values(await this.all()).sort((left, right) => left.name.localeCompare(right.name));
  }

  private async mutate<T>(change: (sessions: Record<string, StoredSession>) => T): Promise<T> {
    let result!: T;
    const next = mutation.then(async () => {
      const sessions = await this.all();
      result = change(sessions);
      await chrome.storage.session.set({ [SESSIONS_KEY]: sessions });
    });
    mutation = next.catch(() => undefined);
    await next;
    return result;
  }

  private async all(): Promise<Record<string, StoredSession>> {
    const stored = await chrome.storage.session.get(SESSIONS_KEY);
    const value = stored[SESSIONS_KEY];
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
    const sessions: Record<string, StoredSession> = {};
    for (const [id, candidate] of Object.entries(value)) {
      if (typeof candidate !== 'object' || candidate === null) continue;
      const record = candidate as Record<string, unknown>;
      if (typeof record.name !== 'string' || !Array.isArray(record.sharedTabIds)) continue;
      const session: StoredSession = {
        id,
        name: record.name,
        sharedTabIds: record.sharedTabIds.filter((tabId): tabId is number => Number.isInteger(tabId)),
        approvedOrigins: parseApprovedOrigins(record.approvedOrigins),
        currentOrigins: parseCurrentOrigins(record.currentOrigins),
      };
      if (typeof record.groupId === 'number') session.groupId = record.groupId;
      sessions[id] = session;
    }
    return sessions;
  }
}

function approve(session: StoredSession, tabId: number, origin: string): void {
  const key = String(tabId);
  const origins = session.approvedOrigins[key] ?? [];
  if (!origins.includes(origin)) origins.push(origin);
  session.approvedOrigins[key] = origins;
  session.currentOrigins[key] = origin;
}

function parseCurrentOrigins(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const parsed: Record<string, string> = {};
  for (const [tabId, origin] of Object.entries(value)) {
    if (typeof origin === 'string' && isOriginKey(origin)) parsed[tabId] = origin;
  }
  return parsed;
}

function parseApprovedOrigins(value: unknown): Record<string, string[]> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const parsed: Record<string, string[]> = {};
  for (const [tabId, origins] of Object.entries(value)) {
    if (!Array.isArray(origins)) continue;
    const valid = origins.filter((origin): origin is string => typeof origin === 'string' && isOriginKey(origin));
    if (valid.length > 0) parsed[tabId] = valid;
  }
  return parsed;
}
