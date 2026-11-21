import type { ClaimRoute } from '@t3-tab/protocol';

import { originOf } from './permissions';
import type { SessionStore } from './sessions';

/** One tab the owner shares with an agent started from the side panel, and the origin it showed then. */
export interface ClaimTab {
  tabId: number;
  origin?: string;
}

/** A code for one redemption. It names the grant it came from. */
interface StoredClaim {
  tabs: ClaimTab[];
  createdAt: number;
  expiresAt: number;
  route: ClaimRoute;
  grant: string;
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
}

interface ClaimState {
  claims: Record<string, StoredClaim>;
  grants: Record<string, StoredGrant>;
}

const CLAIMS_KEY = 'claims';
const GRANTS_KEY = 'claimGrants';
const MAX_CLAIMS = 30;
// A code in a thread's first message waits only for the agent's first call, so a stored transcript holds a dead code.
const MESSAGE_CLAIM_TTL_MS = 10 * 60_000;
// A direct run's code stays in a private file and memory, and is redeemed at the first tool call of a turn of up to an hour.
const LAUNCH_CLAIM_TTL_MS = 60 * 60_000;
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
      state.grants[grant] = { tabs, sessionIds: [], createdAt: now };
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

  /** Issues `code` for what is left of a conversation's grant. False when it has no grant or no tabs left. */
  async renew(conversationId: string, code: string): Promise<boolean> {
    return await this.mutate((state) => {
      const entry = Object.entries(state.grants).find(([, grant]) => grant.conversationId === conversationId);
      if (entry === undefined || entry[1].tabs.length === 0) return false;
      const now = Date.now();
      state.claims[code] = { tabs: entry[1].tabs, createdAt: now, expiresAt: now + LAUNCH_CLAIM_TTL_MS, route: 'launch', grant: entry[0] };
      newest(state.claims);
      return true;
    });
  }

  async revoke(code: string): Promise<void> {
    await this.mutate((state) => {
      delete state.claims[code];
    });
  }

  /**
   * Redeems a code for a session in one serialized step: the expiry check and the delete cannot interleave with
   * another redemption. A code offered on the wrong route is refused and stays valid for its own.
   */
  async consume(code: string, route: ClaimRoute, sessionId: string): Promise<ClaimTab[] | undefined> {
    return await this.mutate((state) => {
      if (!Object.hasOwn(state.claims, code)) return undefined;
      const claim = state.claims[code] as StoredClaim;
      if (claim.expiresAt <= Date.now()) {
        delete state.claims[code];
        return undefined;
      }
      if (claim.route !== route) return undefined;
      delete state.claims[code];
      const grant = state.grants[claim.grant];
      if (grant !== undefined && !grant.sessionIds.includes(sessionId)) grant.sessionIds.push(sessionId);
      return claim.tabs;
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
      claims[code] = { tabs, createdAt, expiresAt, route: route as ClaimRoute, grant };
    }
    const grants: Record<string, StoredGrant> = {};
    for (const [id, candidate] of entries(stored[GRANTS_KEY])) {
      const tabs = parseTabs(candidate.tabs);
      const { sessionIds, conversationId, createdAt } = candidate;
      if (tabs === undefined || !Array.isArray(sessionIds) || typeof createdAt !== 'number') continue;
      grants[id] = {
        tabs,
        sessionIds: sessionIds.filter((value): value is string => typeof value === 'string'),
        createdAt,
        ...(typeof conversationId === 'string' ? { conversationId } : {}),
      };
    }
    return { claims, grants };
  }
}

/**
 * Shares a claim's tabs with a session and uses the code up. A tab still on the origin it showed when the owner
 * started the agent is shared with that origin approved, as a panel share is; a tab that moved since is shared
 * unapproved, so the session is asked again before it reads the new site.
 */
export async function claimTabs(
  claims: ClaimStore,
  sessions: SessionStore,
  sessionId: string,
  code: string,
  route: ClaimRoute = 'message',
): Promise<number[]> {
  const tabs = await claims.consume(code, route, sessionId);
  if (tabs === undefined) throw new Error('Unknown claim code, or one already used or expired. Start the session again from the side panel.');
  const shared: number[] = [];
  for (const claimed of tabs) {
    const tab = await chrome.tabs.get(claimed.tabId).catch(() => undefined);
    if (tab?.id === undefined) continue;
    const origin = originOf(tab.url ?? tab.pendingUrl ?? '');
    await sessions.share(sessionId, tab.id, origin !== undefined && origin === claimed.origin ? origin : undefined);
    shared.push(tab.id);
  }
  return shared;
}
