import type { ClaimRoute } from '@t3-tab/protocol';

import { originOf } from './permissions';
import type { SessionStore, ShareUndo } from './sessions';

/** One tab the owner shares with an agent started from the side panel, and the origin it showed then. */
export interface ClaimTab {
  tabId: number;
  origin?: string;
}

/** Held while one session shares a code's tabs, so nobody else can redeem it. It lapses if the worker stops. */
interface ClaimReservation {
  token: string;
  sessionId: string;
  until: number;
  /** True when this reservation added the session to the grant, so a release takes it off again. */
  addedSession: boolean;
}

/** A code for one redemption. It names the grant it came from. */
interface StoredClaim {
  tabs: ClaimTab[];
  createdAt: number;
  expiresAt: number;
  route: ClaimRoute;
  grant: string;
  reservation?: ClaimReservation;
}

/**
 * What the owner shared with one conversation. Later turns of a direct run get new codes from it, so a tab the
 * owner unshared from any of the conversation's sessions is not shared again.
 */
interface StoredGrant {
  tabs: ClaimTab[];
  sessionIds: string[];
  conversationId?: string;
  createdAt: number;
  /** A `launch` grant is a direct run's, whose later turns get new codes. A T3 thread's session keeps its tabs. */
  route: ClaimRoute;
  /** The code the grant was first issued with, so the panel can bind a thread to it after the code was redeemed. */
  code?: string;
}

/** A tab a session holds only through a grant that was withdrawn. */
export interface RevokedShare {
  sessionId: string;
  tabId: number;
}

interface ClaimState {
  claims: Record<string, StoredClaim>;
  grants: Record<string, StoredGrant>;
}

/** A panel-launched T3 thread's conversation key is this prefix and the thread id. */
export const T3_CONVERSATION_PREFIX = 't3:';

const CLAIMS_KEY = 'claims';
const GRANTS_KEY = 'claimGrants';
const MAX_CLAIMS = 30;
// A code in a thread's first message waits only for the agent's first call, so a stored transcript holds a dead code.
const MESSAGE_CLAIM_TTL_MS = 10 * 60_000;
// A direct run's code stays in a private file and memory, and is redeemed at the first tool call of a turn of up to an hour.
const LAUNCH_CLAIM_TTL_MS = 60 * 60_000;
// Longer than sharing a few tabs takes. It only matters if the service worker stops part way through a redemption.
const RESERVATION_MS = 30_000;
const UNKNOWN_CLAIM = 'Unknown claim code, or one already used or expired. Start the session again from the side panel.';
const ROUTES: readonly string[] = ['launch', 'message'] satisfies ClaimRoute[];
let mutation: Promise<unknown> = Promise.resolve();

/** A random code that names the tabs the owner picked; only the side panel issues one. */
export function newClaimCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function newest<T extends { createdAt: number }>(records: Record<string, T>): void {
  const keys = Object.keys(records).sort((left, right) => (records[left]?.createdAt ?? 0) - (records[right]?.createdAt ?? 0));
  for (const old of keys.slice(0, Math.max(0, keys.length - MAX_CLAIMS))) delete records[old];
}

function parseTabs(value: unknown): ClaimTab[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.flatMap((tab): ClaimTab[] => {
    if (typeof tab !== 'object' || tab === null || !Number.isInteger((tab as ClaimTab).tabId)) return [];
    const origin = (tab as ClaimTab).origin;
    return [typeof origin === 'string' ? { tabId: (tab as ClaimTab).tabId, origin } : { tabId: (tab as ClaimTab).tabId }];
  });
}

function entries(value: unknown): Array<[string, Record<string, unknown>]> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return [];
  return Object.entries(value).flatMap(([key, candidate]): Array<[string, Record<string, unknown>]> =>
    typeof candidate === 'object' && candidate !== null ? [[key, candidate as Record<string, unknown>]] : [],
  );
}

/**
 * Claim codes the side panel issued when it started an agent, kept for this browser run. The session that
 * presents a code gets the tabs it names shared, as if the owner had pressed "Share current tab" for it. Each
 * code works once, within its time limit, on the one route it was issued for.
 */
export class ClaimStore {
  /** Issues a code and returns the id of the new grant it belongs to. */
  async issue(code: string, tabs: ClaimTab[], options: { route?: ClaimRoute } = {}): Promise<string> {
    const route = options.route ?? 'message';
    const grant = crypto.randomUUID();
    await this.mutate((state) => {
      const now = Date.now();
      state.grants[grant] = { tabs, sessionIds: [], createdAt: now, route, code };
      const ttl = route === 'launch' ? LAUNCH_CLAIM_TTL_MS : MESSAGE_CLAIM_TTL_MS;
      state.claims[code] = { tabs, createdAt: now, expiresAt: now + ttl, route, grant };
      newest(state.claims);
      newest(state.grants);
    });
    return grant;
  }

  /** Records which conversation a grant belongs to, so its next direct turn can get a fresh code. */
  async bindConversation(grant: string, conversationId: string): Promise<void> {
    await this.mutate((state) => {
      const record = state.grants[grant];
      if (record !== undefined) record.conversationId = conversationId;
    });
  }

  /** Binds the grant a code was issued for to a conversation, also after the code was redeemed. False when no grant has the code. */
  async bindByCode(code: string, conversationId: string): Promise<boolean> {
    return await this.mutate((state) => {
      const record = Object.values(state.grants).find((grant) => grant.code === code);
      if (record === undefined) return false;
      record.conversationId = conversationId;
      return true;
    });
  }

  /**
   * The T3 threads whose Full access this session needs: `proven`, the thread the daemon showed its process runs for,
   * and every thread its grants are bound to. Undefined when it has neither, and for any grant of a direct run. A code
   * the panel has not bound yet names no thread, so it counts against a session only when nothing proves its thread.
   */
  async t3ThreadsOf(sessionId: string, proven?: string): Promise<string[] | undefined> {
    await mutation;
    const { grants } = await this.read();
    const held = Object.values(grants).filter((grant) => grant.sessionIds.includes(sessionId));
    const threads = new Set<string>(proven === undefined ? [] : [proven]);
    for (const { conversationId } of held) {
      if (conversationId === undefined && proven !== undefined) continue;
      if (conversationId?.startsWith(T3_CONVERSATION_PREFIX) !== true) return undefined;
      threads.add(conversationId.slice(T3_CONVERSATION_PREFIX.length));
    }
    return threads.size === 0 ? undefined : [...threads];
  }

  /**
   * Issues `code` for what is left of a direct run's grant. False when it has no grant or no tabs left, and for a
   * T3 thread, whose session keeps its tabs between messages.
   */
  async renew(conversationId: string, code: string): Promise<boolean> {
    return await this.mutate((state) => {
      const entry = Object.entries(state.grants).find(([, grant]) => grant.conversationId === conversationId);
      if (entry === undefined || entry[1].route !== 'launch' || entry[1].tabs.length === 0) return false;
      const now = Date.now();
      state.claims[code] = { tabs: entry[1].tabs, createdAt: now, expiresAt: now + LAUNCH_CLAIM_TTL_MS, route: 'launch', grant: entry[0] };
      newest(state.claims);
      return true;
    });
  }

  /**
   * Withdraws a code. A grant no thread was ever bound to goes with it, even if an agent already redeemed the code,
   * and the shares that only it gave are returned for the caller to take back.
   */
  async revoke(code: string): Promise<RevokedShare[]> {
    return await this.mutate((state) => {
      const grantId = state.claims[code]?.grant ?? Object.entries(state.grants).find(([, grant]) => grant.code === code)?.[0];
      delete state.claims[code];
      if (grantId === undefined) return [];
      const grant = state.grants[grantId];
      if (grant === undefined || grant.conversationId !== undefined) return [];
      delete state.grants[grantId];
      for (const [other, claim] of Object.entries(state.claims)) if (claim.grant === grantId) delete state.claims[other];
      const others = Object.values(state.grants);
      return grant.sessionIds.flatMap((sessionId) =>
        grant.tabs
          .filter(({ tabId }) => !others.some((entry) => entry.sessionIds.includes(sessionId) && entry.tabs.some((tab) => tab.tabId === tabId)))
          .map(({ tabId }) => ({ sessionId, tabId })),
      );
    });
  }

  /**
   * Holds a code for one session while it shares the tabs: the expiry check and the hold are one serialized step,
   * so only one redemption can proceed. A code offered on the wrong route is refused and stays valid for its own.
   * Finish it with `finish`, or give it back with `release`.
   */
  async reserve(code: string, route: ClaimRoute, sessionId: string): Promise<{ token: string; tabs: ClaimTab[] } | undefined> {
    return await this.mutate((state) => {
      if (!Object.hasOwn(state.claims, code)) return undefined;
      const claim = state.claims[code] as StoredClaim;
      const now = Date.now();
      if (claim.expiresAt <= now) {
        delete state.claims[code];
        return undefined;
      }
      if (claim.route !== route) return undefined;
      if (claim.reservation !== undefined && claim.reservation.until > now) {
        // Not "unknown": the daemon keeps a code it can retry, and this one may yet be released.
        if (claim.reservation.sessionId === sessionId) throw new Error('This claim code is already being redeemed. Try again in a moment.');
        return undefined;
      }
      const grant = state.grants[claim.grant];
      const addedSession = grant !== undefined && !grant.sessionIds.includes(sessionId);
      if (addedSession) grant.sessionIds.push(sessionId);
      const token = crypto.randomUUID();
      claim.reservation = { token, sessionId, until: now + RESERVATION_MS, addedSession };
      return { token, tabs: claim.tabs };
    });
  }

  /** Uses the code up and returns its tabs as they are now, without any the owner took back meanwhile. */
  async finish(code: string, token: string): Promise<ClaimTab[] | undefined> {
    return await this.mutate((state) => {
      if (!Object.hasOwn(state.claims, code)) return undefined;
      const claim = state.claims[code] as StoredClaim;
      if (claim.reservation?.token !== token) return undefined;
      delete state.claims[code];
      return claim.tabs;
    });
  }

  /** Gives a reserved code back after a failure, so it can be redeemed again until it expires. */
  async release(code: string, token: string): Promise<void> {
    await this.mutate((state) => {
      if (!Object.hasOwn(state.claims, code)) return;
      const claim = state.claims[code] as StoredClaim;
      if (claim.reservation?.token !== token) return;
      const grant = state.grants[claim.grant];
      if (grant !== undefined && claim.reservation.addedSession) {
        grant.sessionIds = grant.sessionIds.filter((id) => id !== claim.reservation?.sessionId);
      }
      delete claim.reservation;
    });
  }

  /** The tabs each conversation still holds, for the side panel to show. */
  async conversationTabs(): Promise<Record<string, ClaimTab[]>> {
    await mutation;
    const { grants } = await this.read();
    const tabs: Record<string, ClaimTab[]> = {};
    for (const grant of Object.values(grants)) {
      if (grant.conversationId === undefined) continue;
      // A T3 thread can hold several grants, one for each message that shared a tab.
      const held = tabs[grant.conversationId] ?? [];
      tabs[grant.conversationId] = [...held, ...grant.tabs.filter((tab) => !held.some((entry) => entry.tabId === tab.tabId))];
    }
    return tabs;
  }

  /**
   * The owner took a tab back from a conversation: its later codes, issued or not, leave the tab out. Returns the
   * sessions that may hold it now.
   */
  async removeConversationTab(conversationId: string, tabId: number): Promise<string[]> {
    return await this.mutate((state) => {
      const sessionIds = new Set<string>();
      for (const [id, grant] of Object.entries(state.grants)) {
        if (grant.conversationId !== conversationId) continue;
        grant.tabs = grant.tabs.filter((tab) => tab.tabId !== tabId);
        for (const sessionId of grant.sessionIds) sessionIds.add(sessionId);
        for (const claim of Object.values(state.claims)) {
          if (claim.grant === id) claim.tabs = claim.tabs.filter((tab) => tab.tabId !== tabId);
        }
      }
      return [...sessionIds];
    });
  }

  /** The owner unshared a tab from a session: its conversation's later codes, issued or not, leave the tab out. */
  async forgetTab(sessionId: string, tabId: number): Promise<void> {
    await this.mutate((state) => {
      for (const [id, grant] of Object.entries(state.grants)) {
        if (!grant.sessionIds.includes(sessionId)) continue;
        grant.tabs = grant.tabs.filter((tab) => tab.tabId !== tabId);
        for (const claim of Object.values(state.claims)) {
          if (claim.grant === id) claim.tabs = claim.tabs.filter((tab) => tab.tabId !== tabId);
        }
      }
    });
  }

  private async mutate<T>(change: (state: ClaimState) => T): Promise<T> {
    const next = mutation.then(async () => {
      const state = await this.read();
      const result = change(state);
      await chrome.storage.session.set({ [CLAIMS_KEY]: state.claims, [GRANTS_KEY]: state.grants });
      return result;
    });
    mutation = next.catch(() => undefined);
    return await next;
  }

  private async read(): Promise<ClaimState> {
    const stored = await chrome.storage.session.get([CLAIMS_KEY, GRANTS_KEY]);
    const claims: Record<string, StoredClaim> = {};
    for (const [code, candidate] of entries(stored[CLAIMS_KEY])) {
      const tabs = parseTabs(candidate.tabs);
      const { createdAt, expiresAt, route, grant } = candidate;
      if (tabs === undefined || typeof createdAt !== 'number' || typeof expiresAt !== 'number') continue;
      if (typeof route !== 'string' || !ROUTES.includes(route) || typeof grant !== 'string') continue;
      const reservation = parseReservation(candidate.reservation);
      claims[code] = { tabs, createdAt, expiresAt, route: route as ClaimRoute, grant, ...(reservation === undefined ? {} : { reservation }) };
    }
    const grants: Record<string, StoredGrant> = {};
    for (const [id, candidate] of entries(stored[GRANTS_KEY])) {
      const tabs = parseTabs(candidate.tabs);
      const { sessionIds, conversationId, createdAt, route } = candidate;
      if (tabs === undefined || !Array.isArray(sessionIds) || typeof createdAt !== 'number') continue;
      grants[id] = {
        tabs,
        sessionIds: sessionIds.filter((value): value is string => typeof value === 'string'),
        createdAt,
        route: route === 'message' ? 'message' : 'launch',
        ...(typeof candidate.code === 'string' ? { code: candidate.code } : {}),
        ...(typeof conversationId === 'string' ? { conversationId } : {}),
      };
    }
    return { claims, grants };
  }
}

function parseReservation(value: unknown): ClaimReservation | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const { token, sessionId, until, addedSession } = value as Record<string, unknown>;
  if (typeof token !== 'string' || typeof sessionId !== 'string' || typeof until !== 'number') return undefined;
  return { token, sessionId, until, addedSession: addedSession === true };
}

/**
 * Shares a claim's tabs with a session, then uses the code up. A tab still on the origin it showed when the owner
 * started the agent is shared with that origin approved, as a panel share is; a tab that moved since is shared
 * unapproved, so the session is asked again before it reads the new site. If anything fails, the shares are taken
 * back and the code stays valid for another try until it expires.
 */
export async function claimTabs(
  claims: ClaimStore,
  sessions: SessionStore,
  sessionId: string,
  code: string,
  route: ClaimRoute = 'message',
): Promise<number[]> {
  const reservation = await claims.reserve(code, route, sessionId);
  if (reservation === undefined) throw new Error(UNKNOWN_CLAIM);
  let undos: ShareUndo[] = [];
  try {
    const targets: Array<{ tabId: number; origin?: string }> = [];
    for (const claimed of reservation.tabs) {
      const tab = await chrome.tabs.get(claimed.tabId).catch(() => undefined);
      if (tab?.id === undefined) continue;
      const origin = originOf(tab.url ?? tab.pendingUrl ?? '');
      targets.push(origin !== undefined && origin === claimed.origin ? { tabId: tab.id, origin } : { tabId: tab.id });
    }
    undos = await sessions.shareAll(sessionId, targets);
    const current = await claims.finish(code, reservation.token);
    if (current === undefined) throw new Error(UNKNOWN_CLAIM);
    // The owner may have taken a tab back after it was read above and before it was shared.
    const kept = new Set(current.map((tab) => tab.tabId));
    for (const { tabId } of targets) {
      if (!kept.has(tabId)) await sessions.dropShare([sessionId], tabId);
    }
    return targets.flatMap(({ tabId }) => (kept.has(tabId) ? [tabId] : []));
  } catch (error) {
    await sessions.undoShares(sessionId, undos).catch(() => undefined);
    await claims.release(code, reservation.token).catch(() => undefined);
    throw error;
  }
}

/** Takes a tab back from a conversation: from its later turns, and from any of its sessions still connected. */
export async function removeConversationTab(
  claims: ClaimStore,
  sessions: SessionStore,
  conversationId: string,
  tabId: number,
): Promise<void> {
  const sessionIds = await claims.removeConversationTab(conversationId, tabId);
  await sessions.dropShare(sessionIds, tabId);
}
