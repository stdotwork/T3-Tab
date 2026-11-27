import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ panel: vi.fn(), readStored: vi.fn(), writeStored: vi.fn() }));
vi.mock('../entrypoints/sidepanel/lib/api', () => api);
// Reading the module's state without rendering: the hook returns the current value.
vi.mock('react', () => ({
  useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
  useEffect: () => undefined,
  useState: (value: unknown) => [value, () => undefined],
}));

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

type Store = typeof import('../entrypoints/sidepanel/lib/store');
async function load(): Promise<Store> {
  return await import('../entrypoints/sidepanel/lib/store');
}

const setupOf = (origin: string) => ({ agents: [], t3: { state: 'running', origin } });
const tick = async (): Promise<void> => {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
};

beforeEach(() => {
  vi.resetModules();
  api.panel.mockReset();
  vi.stubGlobal('location', { href: 'chrome-extension://x/sidepanel.html' });
  vi.stubGlobal('window', {});
});

describe('refreshing the setup state', () => {
  it('drops an older reply that arrives after a newer refresh', async () => {
    const store = await load();
    const olderSetup = deferred<unknown>();
    api.panel.mockImplementation(async (request: { type: string; refresh?: boolean }) => {
      if (request.type === 'panel.helper') return { connected: true };
      return request.refresh === true ? setupOf('new') : await olderSetup.promise;
    });
    const older = store.refreshSetup();
    await tick();
    const newer = store.refreshSetup(true);
    await newer;
    expect(store.useLive().setup).toEqual(setupOf('new'));
    olderSetup.resolve(setupOf('old'));
    await older;
    expect(store.useLive().setup).toEqual(setupOf('new'));
  });

  it('drops an older helper answer too, and an older failure', async () => {
    const store = await load();
    const olderHelper = deferred<unknown>();
    let first = true;
    api.panel.mockImplementation(async (request: { type: string }) => {
      if (request.type === 'panel.helper') {
        if (first) {
          first = false;
          return await olderHelper.promise;
        }
        return { connected: true };
      }
      return setupOf('new');
    });
    const older = store.refreshSetup();
    await tick();
    await store.refreshSetup(true);
    olderHelper.resolve({ connected: false, error: 'stale' });
    await older;
    expect(store.useLive().helper).toEqual({ connected: true });
    expect(store.useLive().setup).toEqual(setupOf('new'));

    const failing = deferred<unknown>();
    api.panel.mockReset().mockImplementation(async (request: { type: string; refresh?: boolean }) => {
      if (request.type === 'panel.helper') return { connected: true };
      if (request.refresh === true) return setupOf('newest');
      return await failing.promise;
    });
    // A minute on, so this timed poll asks for the setup again and is still waiting for it.
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 61_000);
    const stale = store.refreshSetup();
    await tick();
    expect(api.panel).toHaveBeenCalledWith({ type: 'panel.setup', refresh: false });
    await store.refreshSetup(true);
    failing.resolve(Promise.reject(new Error('worker restarting')));
    await stale;
    clock.mockRestore();
    expect(store.useLive().helper).toEqual({ connected: true });
  });

  it('does not start a timed poll while one is running, and starts the next one after it ends', async () => {
    const store = await load();
    const helper = deferred<unknown>();
    api.panel.mockImplementation(async (request: { type: string }) => (request.type === 'panel.helper' ? await helper.promise : setupOf('a')));
    const running = store.refreshSetup();
    await tick();
    await store.refreshSetup();
    await store.refreshSetup();
    expect(api.panel).toHaveBeenCalledTimes(1);
    helper.resolve({ connected: true });
    await running;
    api.panel.mockClear();
    api.panel.mockImplementation(async (request: { type: string }) => (request.type === 'panel.helper' ? { connected: true } : setupOf('b')));
    // With no screen showing setup details, the helper is asked and its agent and T3 checks wait a minute.
    await store.refreshSetup();
    expect(api.panel.mock.calls.map(([request]) => (request as { type: string }).type)).toEqual(['panel.helper']);
    api.panel.mockClear();
    const later = Date.now() + 61_000;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(later);
    await store.refreshSetup();
    clock.mockRestore();
    expect(api.panel).toHaveBeenCalledTimes(2);
    expect(store.useLive().setup).toEqual(setupOf('b'));
  });

  it('lets an explicit refresh run while a poll is in flight and ends with the newest answer', async () => {
    const store = await load();
    const pollSetup = deferred<unknown>();
    api.panel.mockImplementation(async (request: { type: string; refresh?: boolean }) => {
      if (request.type === 'panel.helper') return { connected: true };
      return request.refresh === true ? setupOf('explicit') : await pollSetup.promise;
    });
    const poll = store.refreshSetup();
    await tick();
    await store.refreshSetup(true);
    expect(api.panel.mock.calls.filter(([request]) => (request as { type: string }).type === 'panel.setup')).toHaveLength(2);
    pollSetup.resolve(setupOf('poll'));
    await poll;
    expect(store.useLive().setup).toEqual(setupOf('explicit'));
    // The poll's end did not leave the guard stuck: the next timed poll runs.
    api.panel.mockClear();
    await store.refreshSetup();
    expect(api.panel).toHaveBeenCalled();
  });
});

describe('the pace of the timed poll of direct runs', () => {
  const agentCalls = (): number => api.panel.mock.calls.filter(([request]) => (request as { type: string }).type === 'panel.agents').length;
  /** Direct-run lists asked for while the panel starts (before the first timed poll). */
  let startup = 0;

  /** `statusOf(k)` is what the k-th timed poll (1-based) of the list answers. */
  async function start(statusOf: (k: number) => 'running' | 'completed' | undefined): Promise<Store> {
    vi.useFakeTimers();
    vi.stubGlobal('document', { hidden: false, addEventListener: () => undefined });
    vi.stubGlobal('chrome', { runtime: { id: 'x', onMessage: { addListener: () => undefined } }, storage: { onChanged: { addListener: () => undefined } }, tabs: {} });
    api.readStored.mockResolvedValue(undefined);
    api.writeStored.mockResolvedValue(undefined);
    api.panel.mockImplementation(async (request: { type: string }) => {
      if (request.type === 'panel.helper') return { connected: true };
      if (request.type === 'panel.setup') return setupOf('a');
      if (request.type === 'panel.build') return { buildId: 'x' };
      if (request.type === 'panel.agents') {
        const status = statusOf(agentCalls() - startup);
        return { conversations: status === undefined ? [] : [{ id: 'c', status }] };
      }
      return { pending: [], sites: [] };
    });
    const store = await load();
    startup = 1_000;
    store.startPolling();
    await vi.advanceTimersByTimeAsync(0);
    startup = agentCalls();
    return store;
  }
  const since = (): number => agentCalls() - startup;

  it('asks again after 1.5 s when the poll has just seen a run running', async () => {
    const store = await start((k) => (k >= 1 ? 'running' : undefined));
    await vi.advanceTimersByTimeAsync(15_000);
    expect(since()).toBe(1);
    expect(store.useLive().conversations).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_499);
    expect(since()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(since()).toBe(2);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(since()).toBe(3);
    vi.useRealTimers();
  });

  it('shows a run as finished 1.5 s after the poll that saw it running, then slows to 15 s', async () => {
    const store = await start((k) => (k <= 1 ? 'running' : 'completed'));
    await vi.advanceTimersByTimeAsync(15_000);
    expect(store.useLive().conversations[0]?.status).toBe('running');
    await vi.advanceTimersByTimeAsync(1_500);
    expect(store.useLive().conversations[0]?.status).toBe('completed');
    expect(since()).toBe(2);
    await vi.advanceTimersByTimeAsync(14_999);
    expect(since()).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(since()).toBe(3);
    vi.useRealTimers();
  });

  it('asks again after 15 s when the poll sees no run', async () => {
    await start(() => undefined);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(since()).toBe(1);
    await vi.advanceTimersByTimeAsync(14_999);
    expect(since()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(since()).toBe(2);
    vi.useRealTimers();
  });
});
