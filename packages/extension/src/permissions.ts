import type { ToolSession } from '@t3-tab/protocol';

export type SitePermission = 'ask' | 'allow';
export type PermissionDecision = 'allow-once' | 'always-allow' | 'decline';
export type ActingTool = 'act' | 'run_js' | 'open';

export interface StoredSitePermission {
  origin: string;
  setting: SitePermission;
}

export interface PermissionPrompt {
  id: string;
  origin: string;
  tool: ActingTool;
  session: ToolSession;
}

export interface SitePermissionStore {
  get(origin: string): Promise<SitePermission | undefined>;
  set(origin: string, setting: SitePermission): Promise<void>;
  list(): Promise<StoredSitePermission[]>;
}

interface Pending extends PermissionPrompt {
  resolve(): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

export interface PermissionPromptsOptions {
  timeoutMs?: number;
  onChange?: (pending: PermissionPrompt[]) => void;
  makeId?: () => string;
}

/**
 * Enforces the per-origin action permission. Reading is deliberately not routed through here.
 * "Allow once" covers one tool call; "Always allow" writes the origin setting. A prompt that is
 * declined or times out rejects the waiting tool call.
 */
export class PermissionPrompts {
  private readonly pending = new Map<string, Pending>();
  private readonly timeoutMs: number;
  private readonly onChange: (pending: PermissionPrompt[]) => void;
  private readonly makeId: () => string;

  constructor(
    private readonly store: SitePermissionStore,
    options: PermissionPromptsOptions = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.onChange = options.onChange ?? (() => undefined);
    this.makeId = options.makeId ?? (() => crypto.randomUUID());
  }

  async authorize(origin: string, tool: ActingTool, session: ToolSession): Promise<void> {
    const setting = await this.store.get(origin);
    if (setting === 'allow') return;
    if (setting === undefined) await this.store.set(origin, 'ask');

    const id = this.makeId();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.settle(id);
        reject(new Error(`Permission for ${origin} timed out and was declined.`));
      }, this.timeoutMs);
      this.pending.set(id, { id, origin, tool, session, resolve, reject, timer });
      this.emit();
    });
  }

  async decide(id: string, decision: PermissionDecision): Promise<void> {
    const prompt = this.pending.get(id);
    if (prompt === undefined) throw new Error('That permission request is no longer waiting');
    if (decision === 'always-allow') {
      try {
        await this.store.set(prompt.origin, 'allow');
      } catch (error) {
        this.settle(id, false);
        prompt.reject(error instanceof Error ? error : new Error(String(error)));
        throw error;
      }
    }
    this.settle(id, decision !== 'decline');
  }

  cancelSession(sessionId: string): void {
    for (const prompt of this.pending.values()) {
      if (prompt.session.id === sessionId) this.settle(prompt.id, false);
    }
  }

  list(): PermissionPrompt[] {
    return [...this.pending.values()]
      .map(({ id, origin, tool, session }) => ({ id, origin, tool, session }))
      .sort((left, right) => left.origin.localeCompare(right.origin));
  }

  private settle(id: string, allowed?: boolean): void {
    const prompt = this.pending.get(id);
    if (prompt === undefined) return;
    clearTimeout(prompt.timer);
    this.pending.delete(id);
    if (allowed === true) prompt.resolve();
    else if (allowed === false) prompt.reject(new Error(`Permission declined for ${prompt.origin}.`));
    this.emit();
  }

  private emit(): void {
    this.onChange(this.list());
  }
}

const SITE_SETTINGS_KEY = 'sitePermissions';

/** Site settings are extension-local, one entry per HTTP(S) origin. */
export class ChromeSitePermissionStore implements SitePermissionStore {
  async get(origin: string): Promise<SitePermission | undefined> {
    return (await this.all())[origin];
  }

  async set(origin: string, setting: SitePermission): Promise<void> {
    const sites = await this.all();
    sites[origin] = setting;
    await chrome.storage.local.set({ [SITE_SETTINGS_KEY]: sites });
  }

  async list(): Promise<StoredSitePermission[]> {
    const sites = await this.all();
    return Object.entries(sites)
      .map(([origin, setting]) => ({ origin, setting }))
      .sort((left, right) => left.origin.localeCompare(right.origin));
  }

  private async all(): Promise<Record<string, SitePermission>> {
    const stored = await chrome.storage.local.get(SITE_SETTINGS_KEY);
    const value = stored[SITE_SETTINGS_KEY];
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
    const sites: Record<string, SitePermission> = {};
    for (const [origin, setting] of Object.entries(value)) {
      if ((setting === 'ask' || setting === 'allow') && isOriginKey(origin)) sites[origin] = setting;
    }
    return sites;
  }
}

const RESTRICTED_PROTOCOLS = new Set([
  'chrome:',
  'brave:',
  'edge:',
  'devtools:',
  'chrome-extension:',
  'view-source:',
]);

export function isOriginKey(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.origin === value;
  } catch {
    return false;
  }
}

/** The key used for one site's permission: scheme, host and non-default port. */
export function originOf(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

/** A page no T3-Tab tool may read or act on. */
export function restrictedPageReason(value: string): string | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return 'the URL is not valid';
  }
  if (RESTRICTED_PROTOCOLS.has(url.protocol)) return `the ${url.protocol.slice(0, -1)} scheme is restricted`;
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return `the ${url.protocol} scheme is not supported`;
  const host = url.hostname.toLowerCase();
  if (host === 'chromewebstore.google.com' || host.endsWith('.chromewebstore.google.com')) {
    return 'the Chrome Web Store is restricted';
  }
  if (host === 'chrome.google.com' && (url.pathname === '/webstore' || url.pathname.startsWith('/webstore/'))) {
    return 'the Chrome Web Store is restricted';
  }
  return undefined;
}

export function restrictedPageError(value: string): string | undefined {
  const reason = restrictedPageReason(value);
  return reason === undefined
    ? undefined
    : `T3-Tab cannot access this page: ${reason}. Use a regular http(s) page.`;
}
