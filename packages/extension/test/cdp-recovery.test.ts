import { beforeEach, describe, expect, it, vi } from 'vitest';

type Listener = (...args: never[]) => void;

const TAB = 7;
const FOREIGN = 'Cannot access a chrome-extension:// URL of different extension';

/** The browser's debugger API, the edge these tests stub. Commands answer from `reply`. */
function stubChrome() {
  const listeners: Record<string, Listener[]> = {};
  const event = (name: string) => ({ addListener: (listener: Listener) => (listeners[name] ??= []).push(listener) });
  const fire = (name: string, ...args: unknown[]) => {
    for (const listener of listeners[name] ?? []) (listener as (...values: unknown[]) => void)(...args);
  };
  const state = {
    loaderId: 'L1',
    url: 'http://a.test/login',
    tabUrl: 'http://a.test/login',
    attachErrors: [] as string[],
    sent: [] as Array<{ method: string; params?: Record<string, unknown> }>,
    reply: undefined as undefined | ((method: string, params?: Record<string, unknown>) => unknown),
  };
  const executeScript = vi.fn(async () => []);
  vi.stubGlobal('chrome', {
    runtime: { id: 'own' },
    scripting: { executeScript },
    tabs: { onRemoved: event('removed'), get: async () => ({ id: TAB, url: state.tabUrl }) },
    webNavigation: { onCommitted: event('committed') },
    debugger: {
      onEvent: event('event'),
      onDetach: event('detach'),
      detach: async () => undefined,
      attach: async () => {
        const error = state.attachErrors.shift();
        if (error !== undefined) throw new Error(error);
      },
      sendCommand: async (_target: unknown, method: string, params?: Record<string, unknown>) => {
        state.sent.push({ method, ...(params === undefined ? {} : { params }) });
        const custom = state.reply?.(method, params);
        if (custom !== undefined) return await custom;
        if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main', loaderId: state.loaderId, url: state.url } } };
        if (method === 'Runtime.evaluate') return { result: { value: 'hidden' } };
        return {};
      },
    },
  });
  return { state, fire, executeScript };
}

const dialog = (message: string, url = 'http://a.test/login') => ({ type: 'prompt', message, defaultPrompt: '', url });

describe('debugger recovery', () => {
  let browser: ReturnType<typeof stubChrome>;
  let cdp: typeof import('../src/cdp');

  beforeEach(async () => {
    vi.resetModules();
    browser = stubChrome();
    cdp = await import('../src/cdp');
    cdp.initCdp();
    await cdp.ensureAttached(TAB);
  });

  it('keeps a newer dialog when the answer to an older one completes', async () => {
    browser.fire('event', { tabId: TAB }, 'Page.javascriptDialogOpening', dialog('first'));
    browser.state.reply = (method) => {
      if (method !== 'Page.handleJavaScriptDialog') return undefined;
      browser.fire('event', { tabId: TAB }, 'Page.javascriptDialogClosed', {});
      browser.fire('event', { tabId: TAB }, 'Page.javascriptDialogOpening', dialog('second'));
      return {};
    };
    await cdp.answerDialog(TAB, true);
    expect(cdp.openDialog(TAB)?.message).toBe('second');
  });

  it('runs one answer at a time and does not send a second for a dialog already answered', async () => {
    browser.fire('event', { tabId: TAB }, 'Page.javascriptDialogOpening', dialog('only'));
    const opened = cdp.openDialog(TAB);
    browser.state.reply = (method) => {
      if (method !== 'Page.handleJavaScriptDialog') return undefined;
      browser.fire('event', { tabId: TAB }, 'Page.javascriptDialogClosed', {});
      return {};
    };
    await Promise.all([cdp.answerDialog(TAB, false, undefined, opened), cdp.answerDialog(TAB, true, 'text', opened)]);
    expect(browser.state.sent.filter((command) => command.method === 'Page.handleJavaScriptDialog')).toHaveLength(1);
  });

  it('keeps refs across a reattach to the same document', async () => {
    const before = cdp.documentEpoch(TAB);
    browser.fire('detach', { tabId: TAB }, 'target_closed');
    await cdp.ensureAttached(TAB);
    expect(cdp.documentEpoch(TAB)).toBe(before);
  });

  it('treats a page that came and went while detached as a new document, even with the same loader', async () => {
    const before = cdp.documentEpoch(TAB);
    browser.fire('detach', { tabId: TAB }, 'target_closed');
    browser.fire('committed', { tabId: TAB, frameId: 0, url: 'http://b.test/' });
    browser.fire('committed', { tabId: TAB, frameId: 0, url: 'http://a.test/login' });
    await cdp.ensureAttached(TAB);
    expect(cdp.documentEpoch(TAB)).toBeGreaterThan(before);
  });

  it('does not touch frames on a page whose origin the caller did not approve', async () => {
    (cdp as { setRecoveryOrigin?: (tab: number, origin: string) => void }).setRecoveryOrigin?.(TAB, 'http://a.test');
    browser.state.tabUrl = 'http://b.test/inbox';
    browser.state.attachErrors = [FOREIGN];
    browser.fire('detach', { tabId: TAB }, 'target_closed');
    await expect(cdp.ensureAttached(TAB)).rejects.toThrow(/moved/);
    expect(browser.executeScript).not.toHaveBeenCalled();
  });

  it('clears frames on the approved origin', async () => {
    (cdp as { setRecoveryOrigin?: (tab: number, origin: string) => void }).setRecoveryOrigin?.(TAB, 'http://a.test');
    browser.state.attachErrors = [FOREIGN];
    browser.fire('detach', { tabId: TAB }, 'target_closed');
    await cdp.ensureAttached(TAB);
    expect(browser.executeScript).toHaveBeenCalledTimes(1);
  });

  it('turns focus emulation off after a dialog that opened during the release', async () => {
    const release = await cdp.holdInputFocus(TAB);
    browser.state.reply = (method, params) => {
      if (method !== 'Emulation.setFocusEmulationEnabled' || params?.enabled !== false) return undefined;
      browser.state.reply = undefined;
      browser.fire('event', { tabId: TAB }, 'Page.javascriptDialogOpening', dialog('during release'));
      return new Promise(() => undefined);
    };
    await release();
    browser.state.sent.length = 0;
    browser.fire('event', { tabId: TAB }, 'Page.javascriptDialogClosed', {});
    await Promise.resolve();
    expect(browser.state.sent).toContainEqual({ method: 'Emulation.setFocusEmulationEnabled', params: { enabled: false } });
  });
});
