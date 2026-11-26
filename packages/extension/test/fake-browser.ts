import vm from 'node:vm';

/**
 * A stand-in for the browser at the edge the extension talks to: `chrome.debugger`, `chrome.tabs` and
 * `chrome.tabGroups`. Pages are a URL and a text; `Runtime.evaluate` really runs the expression, against a
 * `document` and `location` built from the tab's current page, so an expression behaves as it would there.
 */
export interface FakeTab {
  id: number;
  groupId: number;
  url: string;
  title: string;
  text: string;
  frameId: string;
  context: { id: number; uniqueId: string };
  /** Whether the tab is the active one of its window. Left out, the tab does not say. */
  active?: boolean;
  /** What the browser says of its loading: `complete` unless set. */
  status?: 'loading' | 'complete';
  /** The address a tab that has not committed yet is loading. */
  pendingUrl?: string;
}

type EventListener = (source: { tabId?: number }, method: string, params?: unknown) => void;

export class FakeBrowser {
  readonly tabs = new Map<number, FakeTab>();
  readonly commands: Array<{ tabId: number; method: string; params: Record<string, unknown> | undefined }> = [];
  /** Every expression that actually ran, and the origin of the page it ran in. */
  readonly evaluated: Array<{ tabId: number; origin: string; expression: string }> = [];
  readonly groupCalls: Array<{ tabIds: number[]; groupId?: number }> = [];
  /** Runs when a command reaches the browser, before it is handled: the place for a navigation to land. */
  beforeCommand: ((tabId: number, method: string) => Promise<void> | void) | undefined;
  /** Answers an expression before the page would run it: the place to say what a script in the real page would find. */
  evaluateHook: ((params: Record<string, unknown>) => unknown) | undefined;
  /**
   * Where `Page.navigate` lands: the address it was given unless this names another (a redirect). A change of fragment
   * only stays in the document, as in the browser, and reports no loader.
   */
  redirect: ((url: string) => string) | undefined;
  /** What the one window says about itself. */
  windowFocused = true;
  windowState = 'normal';
  private readonly listeners: EventListener[] = [];
  private contextSeq = 0;
  private nextTabId = 500;
  private loaderSeq = 0;

  reset(): void {
    this.tabs.clear();
    this.commands.length = 0;
    this.evaluated.length = 0;
    this.groupCalls.length = 0;
    this.beforeCommand = undefined;
    this.evaluateHook = undefined;
    this.redirect = undefined;
    this.windowFocused = true;
    this.windowState = 'normal';
  }

  addTab(fields: { id: number; url: string; text?: string; title?: string; groupId?: number; active?: boolean }): FakeTab {
    const tab: FakeTab = {
      id: fields.id,
      groupId: fields.groupId ?? -1,
      url: fields.url,
      title: fields.title ?? '',
      text: fields.text ?? '',
      frameId: `frame-${fields.id}`,
      context: this.newContext(),
      ...(fields.active === undefined ? {} : { active: fields.active }),
    };
    this.tabs.set(tab.id, tab);
    return tab;
  }

  /** Replaces the tab's document, as a committed navigation does: its context goes, a new one is created. */
  navigate(tabId: number, url: string, text: string): void {
    const tab = this.mustTab(tabId);
    const old = tab.context;
    this.emit(tabId, 'Runtime.executionContextDestroyed', {
      executionContextId: old.id,
      executionContextUniqueId: old.uniqueId,
    });
    tab.url = url;
    tab.text = text;
    tab.context = this.newContext();
    this.emit(tabId, 'Page.frameNavigated', { frame: { id: tab.frameId, url } });
    this.emitContext(tab);
  }

  /** A network request the page started, as the debugger reports it. */
  request(tabId: number): void {
    this.emit(tabId, 'Network.requestWillBeSent', { type: 'XHR', loaderId: 'x', request: { method: 'GET' } });
  }

  install(): void {
    const fake = {
      debugger: {
        onEvent: { addListener: (listener: EventListener) => void this.listeners.push(listener) },
        onDetach: { addListener: () => undefined },
        attach: async () => undefined,
        detach: async () => undefined,
        sendCommand: async (target: { tabId: number }, method: string, params?: Record<string, unknown>) =>
          await this.command(target.tabId, method, params),
      },
      tabs: {
        onRemoved: { addListener: () => undefined },
        get: async (id: number) => {
          const tab = this.tabs.get(id);
          if (tab === undefined) throw new Error(`No tab with id: ${id}.`);
          return this.snapshot(tab);
        },
        query: async () => [...this.tabs.values()].map((tab) => this.snapshot(tab)),
        create: async (options: { url?: string }) => {
          this.nextTabId += 1;
          return this.snapshot(this.addTab({ id: this.nextTabId, url: options.url ?? 'about:blank' }));
        },
        remove: async (id: number) => void this.tabs.delete(id),
        group: async (options: { tabIds: number[]; groupId?: number }) => {
          this.groupCalls.push(options);
          const groupId = options.groupId ?? 1000;
          for (const id of options.tabIds) this.mustTab(id).groupId = groupId;
          return groupId;
        },
      },
      windows: { get: async () => ({ id: 1, focused: this.windowFocused, state: this.windowState }) },
      tabGroups: { TAB_GROUP_ID_NONE: -1, update: async () => undefined },
      webNavigation: { onCommitted: { addListener: () => undefined } },
    };
    (globalThis as unknown as { chrome: unknown }).chrome = fake;
  }

  private async command(tabId: number, method: string, params?: Record<string, unknown>): Promise<unknown> {
    this.commands.push({ tabId, method, params });
    await this.beforeCommand?.(tabId, method);
    const tab = this.mustTab(tabId);
    switch (method) {
      case 'Runtime.enable':
        this.emitContext(tab);
        return {};
      case 'Page.getFrameTree':
        return { frameTree: { frame: { id: tab.frameId, securityOrigin: new URL(tab.url).origin } } };
      case 'Runtime.evaluate':
        return await this.evaluate(tab, params ?? {});
      case 'Page.createIsolatedWorld':
        return { executionContextId: 900 + tab.id };
      case 'Page.getLayoutMetrics':
        return { cssVisualViewport: { clientWidth: 800, clientHeight: 600 } };
      case 'Page.captureScreenshot':
        return { data: 'AAAA' };
      case 'Page.navigate': {
        const url = String(params?.url);
        const sameDocument = tab.url !== 'about:blank' && new URL(url).href.split('#')[0] === new URL(tab.url).href.split('#')[0];
        if (sameDocument) {
          tab.url = url;
          return {};
        }
        this.navigate(tabId, this.redirect?.(url) ?? url, '');
        this.emit(tabId, 'Page.loadEventFired', {});
        this.loaderSeq += 1;
        return { loaderId: `loader-${this.loaderSeq}` };
      }
      default:
        return {};
    }
  }

  private async evaluate(tab: FakeTab, params: Record<string, unknown>): Promise<unknown> {
    const hooked = this.evaluateHook?.(params);
    if (hooked !== undefined) return { result: { type: typeof hooked, value: hooked } };
    const wanted = params.uniqueContextId;
    // Without a context id the browser evaluates in whatever document the tab shows now.
    if (wanted !== undefined && wanted !== tab.context.uniqueId) {
      // The text Chromium answers with, as seen from the real browser in the end-to-end run.
      throw new Error('{"code":-32602,"message":"uniqueContextId not found"}');
    }
    const origin = new URL(tab.url).origin;
    const expression = String(params.expression);
    this.evaluated.push({ tabId: tab.id, origin, expression });
    try {
      const sandbox = { document: { title: tab.title, body: { innerText: tab.text } }, location: { origin } };
      const value: unknown = await vm.runInNewContext(expression, sandbox);
      return { result: { type: typeof value, value: value === undefined ? undefined : JSON.parse(JSON.stringify(value)) } };
    } catch (error) {
      return { exceptionDetails: { text: 'Uncaught', exception: { description: String(error) } } };
    }
  }

  private newContext(): { id: number; uniqueId: string } {
    this.contextSeq += 1;
    return { id: this.contextSeq, uniqueId: `unique-${this.contextSeq}` };
  }

  private emitContext(tab: FakeTab): void {
    this.emit(tab.id, 'Runtime.executionContextCreated', {
      context: {
        id: tab.context.id,
        uniqueId: tab.context.uniqueId,
        origin: new URL(tab.url).origin,
        name: '',
        auxData: { isDefault: true, type: 'default', frameId: tab.frameId },
      },
    });
  }

  private emit(tabId: number, method: string, params: unknown): void {
    for (const listener of this.listeners) listener({ tabId }, method, params);
  }

  private snapshot(tab: FakeTab): chrome.tabs.Tab {
    return {
      id: tab.id,
      groupId: tab.groupId,
      url: tab.url,
      title: tab.title,
      status: tab.status ?? 'complete',
      ...(tab.pendingUrl === undefined ? {} : { pendingUrl: tab.pendingUrl }),
      ...(tab.active === undefined ? {} : { active: tab.active, windowId: 1 }),
    } as chrome.tabs.Tab;
  }

  private mustTab(id: number): FakeTab {
    const tab = this.tabs.get(id);
    if (tab === undefined) throw new Error(`No tab with id: ${id}.`);
    return tab;
  }
}
