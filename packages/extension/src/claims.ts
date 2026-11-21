import { originOf } from './permissions';
import type { SessionStore } from './sessions';

/** One tab the owner shares with an agent started from the side panel, and the origin it showed then. */
export interface ClaimTab {
  tabId: number;
  origin?: string;
}

interface StoredClaim {
  tabs: ClaimTab[];
  createdAt: number;
}

const CLAIMS_KEY = 'claims';
const MAX_CLAIMS = 30;
let mutation = Promise.resolve();

/** A random code that names the tabs the owner picked; only the side panel issues one. */
export function newClaimCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

/**
 * Claim codes the side panel issued when it started an agent, kept for this browser run. The session that
 * presents a code gets the tabs it names shared, as if the owner had pressed "Share current tab" for it.
 */
export class ClaimStore {
  async issue(code: string, tabs: ClaimTab[]): Promise<void> {
    await this.mutate((claims) => {
      claims[code] = { tabs, createdAt: Date.now() };
      const codes = Object.keys(claims).sort((left, right) => (claims[left]?.createdAt ?? 0) - (claims[right]?.createdAt ?? 0));
      for (const old of codes.slice(0, Math.max(0, codes.length - MAX_CLAIMS))) delete claims[old];
    });
  }

  async revoke(code: string): Promise<void> {
    await this.mutate((claims) => {
      delete claims[code];
    });
  }

  async get(code: string): Promise<ClaimTab[] | undefined> {
    await mutation;
    return (await this.all())[code]?.tabs;
  }

  private async mutate(change: (claims: Record<string, StoredClaim>) => void): Promise<void> {
    const next = mutation.then(async () => {
      const claims = await this.all();
      change(claims);
      await chrome.storage.session.set({ [CLAIMS_KEY]: claims });
    });
    mutation = next.catch(() => undefined);
    await next;
  }

  private async all(): Promise<Record<string, StoredClaim>> {
    const stored = await chrome.storage.session.get(CLAIMS_KEY);
    const value = stored[CLAIMS_KEY];
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
    const claims: Record<string, StoredClaim> = {};
    for (const [code, candidate] of Object.entries(value)) {
      if (typeof candidate !== 'object' || candidate === null) continue;
      const record = candidate as Record<string, unknown>;
      if (!Array.isArray(record.tabs) || typeof record.createdAt !== 'number') continue;
      const tabs = record.tabs.flatMap((tab): ClaimTab[] => {
        if (typeof tab !== 'object' || tab === null || !Number.isInteger((tab as ClaimTab).tabId)) return [];
        const origin = (tab as ClaimTab).origin;
        return [typeof origin === 'string' ? { tabId: (tab as ClaimTab).tabId, origin } : { tabId: (tab as ClaimTab).tabId }];
      });
      claims[code] = { tabs, createdAt: record.createdAt };
    }
    return claims;
  }
}

/**
 * Shares a claim's tabs with a session. A tab still on the origin it showed when the owner started the agent is
 * shared with that origin approved, as a panel share is; a tab that moved since is shared unapproved, so the
 * session is asked again before it reads the new site.
 */
export async function claimTabs(
  claims: ClaimStore,
  sessions: SessionStore,
  sessionId: string,
  code: string,
): Promise<number[]> {
  const tabs = await claims.get(code);
  if (tabs === undefined) throw new Error('Unknown claim code. Start the session again from the side panel.');
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
