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
