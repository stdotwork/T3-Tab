import type { TabInfo, ToolSession } from '@t3-tab/protocol';

import { isOriginKey, restrictedPageReason } from './permissions';

export interface StoredSession extends ToolSession {
  groupId?: number;
  sharedTabIds: number[];
  /** Origins approved for this session on each tab, keyed by tab id. */
  approvedOrigins: Record<string, string[]>;
  /** Last origin observed for each tab. A different origin invalidates its approvals. */
  currentOrigins: Record<string, string>;
  /** The tab the page tools use when a call names none: the last one this session opened, switched to or was handed. */
  currentTabId?: number;
  /** The T3 thread the daemon showed this session's process runs for. Its mode is still asked of T3 per request. */
  t3ThreadId?: string;
}

/** What one `shareAll` added for a tab, so a failed redemption can take back exactly that. */
export interface ShareUndo {
  tabId: number;
  addedShare: boolean;
  addedOrigin: string | undefined;
  previousOrigin: string | undefined;
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

/** True when the session has approved this origin for this tab, so its title and address may be shown. */
export function hasApprovedOrigin(session: StoredSession, tabId: number, origin: string): boolean {
  return session.approvedOrigins[String(tabId)]?.includes(origin) === true;
}

/**
 * The one session a tab opened from `opener` belongs to, or undefined. Only the opener's tab group names a
 * session. A tab shared with a session is still the owner's, and so are the tabs the owner opens from it
 * (a middle-click, a `target=_blank` link), so a shared opener gives a new tab to nobody.
 */
export function sessionForPopup(
  sessions: StoredSession[],
  opener: { id?: number | undefined; groupId?: number | undefined },
): StoredSession | undefined {
  const grouped = sessions.filter((session) => session.groupId !== undefined && session.groupId === opener.groupId);
  return grouped.length === 1 ? grouped[0] : undefined;
}

export function usableSessionTabs(session: StoredSession, tabs: chrome.tabs.Tab[]): chrome.tabs.Tab[] {
  return tabs.filter(
    (tab) =>
      tab.id !== undefined &&
      canSessionUseTab(session, tab) &&
      restrictedPageReason(tab.url ?? tab.pendingUrl ?? '') === undefined,
  );
}

/** The tab a call that names none is about: the session's current tab, else the one in front, else its first. */
export function currentSessionTab(session: StoredSession, usable: chrome.tabs.Tab[], frontId: number | undefined): chrome.tabs.Tab | undefined {
  return (
    usable.find((tab) => tab.id === session.currentTabId) ??
    usable.find((tab) => tab.id === frontId) ??
    usable[0]
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

  async register(session: ToolSession, t3ThreadId?: string): Promise<StoredSession> {
    return await this.mutate((sessions) => {
      const record = sessions[session.id] ?? { ...session, sharedTabIds: [], approvedOrigins: {}, currentOrigins: {} };
      record.name = session.name;
      if (typeof t3ThreadId === 'string' && t3ThreadId !== '') record.t3ThreadId = t3ThreadId;
      else delete record.t3ThreadId;
      sessions[session.id] = record;
      return record;
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
      session.currentTabId = tabId;
      return session;
    });
  }

  /** Shares several tabs in one storage write, so a failure leaves none of them shared. */
  async shareAll(id: string, tabs: Array<{ tabId: number; origin?: string }>): Promise<ShareUndo[]> {
    return await this.mutate((sessions) => {
      const session = sessions[id];
      if (session === undefined) throw new Error('Session is not registered');
      let handedOver = false;
      return tabs.map(({ tabId, origin }) => {
        const key = String(tabId);
        const undo: ShareUndo = {
          tabId,
          addedShare: !session.sharedTabIds.includes(tabId),
          addedOrigin: origin !== undefined && session.approvedOrigins[key]?.includes(origin) !== true ? origin : undefined,
          previousOrigin: session.currentOrigins[key],
        };
        if (undo.addedShare) {
          session.sharedTabIds.push(tabId);
          // The owner handed this tab over just now, so it is what the agent should look at next.
          if (!handedOver) session.currentTabId = tabId;
          handedOver = true;
        }
        if (origin !== undefined) approve(session, tabId, origin);
        return undo;
      });
    });
  }

  /** Takes back what `shareAll` added. It never adds a share, so a tab the owner removed since stays removed. */
  async undoShares(id: string, undos: ShareUndo[]): Promise<void> {
    if (undos.length === 0) return;
    await this.mutate((sessions) => {
      const session = sessions[id];
      if (session === undefined) return;
      for (const undo of undos) {
        const key = String(undo.tabId);
        if (undo.addedShare) {
          session.sharedTabIds = session.sharedTabIds.filter((value) => value !== undo.tabId);
          if (session.currentTabId === undo.tabId) delete session.currentTabId;
        }
        if (undo.addedOrigin === undefined) continue;
        const left = (session.approvedOrigins[key] ?? []).filter((origin) => origin !== undo.addedOrigin);
        if (left.length === 0) delete session.approvedOrigins[key];
        else session.approvedOrigins[key] = left;
        if (session.currentOrigins[key] === undo.addedOrigin) {
          if (undo.previousOrigin === undefined) delete session.currentOrigins[key];
          else session.currentOrigins[key] = undo.previousOrigin;
        }
      }
    });
  }

  /** The owner took a tab back: these sessions, those still registered, lose it and its approvals. */
  async dropShare(ids: string[], tabId: number): Promise<void> {
    await this.mutate((sessions) => {
      for (const id of ids) {
        const session = sessions[id];
        if (session === undefined) continue;
        session.sharedTabIds = session.sharedTabIds.filter((value) => value !== tabId);
        delete session.approvedOrigins[String(tabId)];
        delete session.currentOrigins[String(tabId)];
      }
    });
  }

  async setCurrentTab(id: string, tabId: number): Promise<void> {
    await this.mutate((sessions) => {
      const session = sessions[id];
      if (session === undefined) throw new Error('Session is not registered');
      session.currentTabId = tabId;
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
    return session !== undefined && hasApprovedOrigin(session, tabId, origin);
  }

  async forgetTab(tabId: number): Promise<void> {
    await this.mutate((sessions) => {
      for (const session of Object.values(sessions)) {
        session.sharedTabIds = session.sharedTabIds.filter((value) => value !== tabId);
        if (session.currentTabId === tabId) delete session.currentTabId;
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
      if (typeof record.currentTabId === 'number') session.currentTabId = record.currentTabId;
      if (typeof record.t3ThreadId === 'string') session.t3ThreadId = record.t3ThreadId;
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
