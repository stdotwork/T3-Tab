import type { ToolSession } from '@t3-tab/protocol';

/**
 * What the owner has granted a site: `ask` prompts for everything, `read` lets sessions read it without a
 * prompt, `allow` also lets them open pages, act and run JavaScript there.
 */
export type SitePermission = 'ask' | 'read' | 'allow';
/** `always-allow-read` is offered only on a read prompt and `always-allow` only on the others. */
export type PermissionDecision = 'allow-once' | 'always-allow-read' | 'always-allow' | 'decline';
export type PromptKind = 'read' | 'act' | 'run_js' | 'open';

export interface StoredSitePermission {
  origin: string;
  setting: SitePermission;
}

export interface PromptTab {
  id: number;
  title: string;
}

export interface PermissionPrompt {
  id: string;
  origin: string;
  tool: PromptKind;
  session: ToolSession;
  tab: PromptTab;
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

/** A request let through without a prompt because the session's thread has full access in T3 Code. */
export interface AutoAllowed {
  tool: PromptKind;
  origin: string;
  tabId: number;
  tabTitle: string;
  /** Milliseconds since the epoch. */
  at: number;
}

export interface PermissionPromptsOptions {
  timeoutMs?: number | (() => number | Promise<number>);
  onChange?: (pending: PermissionPrompt[]) => void;
  /** Called once when a prompt starts waiting, and once when it ends, however it ends. */
  onOpen?: (prompt: PermissionPrompt) => void;
  onClose?: (promptId: string) => void;
  /**
   * Whether a session's thread has full access in T3 Code, which counts as yes for a request the site's setting does
   * not cover. It never changes a site's setting and every other check still runs.
   */
  fullAccess?: (sessionId: string) => Promise<boolean>;
  makeId?: () => string;
}

const MAX_PENDING_PER_SESSION = 3;
const MAX_AUTO_ALLOWED = 20;

/** Whether a site's setting lets a tool call through without a prompt. A read grant never covers more than reading. */
function settingCovers(setting: SitePermission | undefined, tool: PromptKind): boolean {
  return setting === 'allow' || (setting === 'read' && tool === 'read');
}

/**
 * Enforces the per-origin permission and read approval. "Allow once" covers one tool call; the lasting
 * choices write the origin setting, a read prompt's only the read grant. A prompt that is declined or
 * times out rejects the call.
 */
export class PermissionPrompts {
  private readonly pending = new Map<string, Pending>();
  private readonly timeoutMs: number | (() => number | Promise<number>);
  private readonly onChange: (pending: PermissionPrompt[]) => void;
  private readonly makeId: () => string;
  private readonly autoAllowedLog: AutoAllowed[] = [];
  private readonly options: PermissionPromptsOptions;

  constructor(
    private readonly store: SitePermissionStore,
    options: PermissionPromptsOptions = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.onChange = options.onChange ?? (() => undefined);
    this.makeId = options.makeId ?? (() => crypto.randomUUID());
    this.options = options;
  }

  /** The last requests a full-access thread had allowed without a prompt, oldest first. Kept in memory only. */
  autoAllowed(): AutoAllowed[] {
    return [...this.autoAllowedLog];
  }

  async authorize(origin: string, tool: PromptKind, session: ToolSession, tab: PromptTab): Promise<void> {
    const setting = await this.store.get(origin);
    if (settingCovers(setting, tool)) return;
    if ((await this.options.fullAccess?.(session.id)) === true) {
      this.autoAllowedLog.push({ tool, origin, tabId: tab.id, tabTitle: tab.title, at: Date.now() });
      if (this.autoAllowedLog.length > MAX_AUTO_ALLOWED) this.autoAllowedLog.splice(0, this.autoAllowedLog.length - MAX_AUTO_ALLOWED);
      return;
    }
    if (this.pendingFor(session.id).length >= MAX_PENDING_PER_SESSION) {
      throw new Error(`Too many permission requests for this session (maximum ${MAX_PENDING_PER_SESSION}). Decide one first.`);
    }
    if (setting === undefined) await this.store.set(origin, 'ask');

    const id = this.makeId();
    const timeoutMs = typeof this.timeoutMs === 'function' ? await this.timeoutMs() : this.timeoutMs;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('The permission timeout is invalid');
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.settle(id);
        reject(new Error(`Permission for ${origin} timed out and was declined.`));
      }, timeoutMs);
      this.pending.set(id, { id, origin, tool, session, tab, resolve, reject, timer });
      this.emit();
      this.notify(() => this.options.onOpen?.({ id, origin, tool, session, tab }));
    });
  }

  async decide(id: string, decision: PermissionDecision): Promise<void> {
    const prompt = this.pending.get(id);
    if (prompt === undefined) throw new Error('That permission request is no longer waiting');
    if (decision === 'always-allow-read' && prompt.tool !== 'read') {
      throw new Error('Reading on a site can be allowed for good only from a read request');
    }
    if (decision === 'always-allow' && prompt.tool === 'read') {
      throw new Error('A read request can be allowed for good only for reading on the site');
    }
    if (decision === 'always-allow' || decision === 'always-allow-read') {
      this.remove(id);
      try {
        // A read grant never lowers a site the owner has allowed fully in the meantime.
        if (decision === 'always-allow' || (await this.store.get(prompt.origin)) !== 'allow') {
          await this.store.set(prompt.origin, decision === 'always-allow' ? 'allow' : 'read');
        }
        prompt.resolve();
      } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error));
        prompt.reject(failure);
        throw failure;
      }
      return;
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
      .map(({ id, origin, tool, session, tab }) => ({ id, origin, tool, session, tab }));
  }

  private settle(id: string, allowed?: boolean): void {
    const prompt = this.remove(id);
    if (prompt === undefined) return;
    if (allowed === true) prompt.resolve();
    else if (allowed === false) prompt.reject(new Error(`Permission declined for ${prompt.origin}.`));
  }

  private remove(id: string): Pending | undefined {
    const prompt = this.pending.get(id);
    if (prompt === undefined) return undefined;
    clearTimeout(prompt.timer);
    this.pending.delete(id);
    this.emit();
    this.notify(() => this.options.onClose?.(id));
    return prompt;
  }

  private pendingFor(sessionId: string): Pending[] {
    return [...this.pending.values()].filter((prompt) => prompt.session.id === sessionId);
  }

  /** A hook that fails must not fail the prompt it reports on. */
  private notify(hook: () => void): void {
    try {
      hook();
    } catch {
      // The prompt still works in the side panel.
    }
  }

  private emit(): void {
    this.onChange(this.list());
  }
}

const SITE_SETTINGS_KEY = 'sitePermissions';

interface LocalStorageArea {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

/** Site settings are extension-local, one entry per HTTP(S) origin. */
export class ChromeSitePermissionStore implements SitePermissionStore {
  private mutation = Promise.resolve();

  constructor(private readonly storage: LocalStorageArea = chrome.storage.local) {}

  async get(origin: string): Promise<SitePermission | undefined> {
    await this.mutation;
    return (await this.all())[origin];
  }

  async set(origin: string, setting: SitePermission): Promise<void> {
    await this.mutate((sites) => {
      sites[origin] = setting;
    });
  }

  async list(): Promise<StoredSitePermission[]> {
    await this.mutation;
    return Object.entries(await this.all())
      .map(([origin, setting]) => ({ origin, setting }))
      .sort((left, right) => left.origin.localeCompare(right.origin));
  }

  private async mutate(change: (sites: Record<string, SitePermission>) => void): Promise<void> {
    const next = this.mutation.then(async () => {
      const sites = await this.all();
      change(sites);
      await this.storage.set({ [SITE_SETTINGS_KEY]: sites });
    });
    this.mutation = next.catch(() => undefined);
    await next;
  }

  private async all(): Promise<Record<string, SitePermission>> {
    const stored = await this.storage.get(SITE_SETTINGS_KEY);
    const value = stored[SITE_SETTINGS_KEY];
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
    const sites: Record<string, SitePermission> = {};
    for (const [origin, setting] of Object.entries(value)) {
      if ((setting === 'ask' || setting === 'read' || setting === 'allow') && isOriginKey(origin)) sites[origin] = setting;
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
