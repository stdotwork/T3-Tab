import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  panel: vi.fn(),
  readStored: vi.fn(),
  writeStored: vi.fn(),
  removeStored: vi.fn(),
  errorText: (error: unknown) => (error instanceof Error ? error.message : String(error)),
}));
vi.mock('../entrypoints/sidepanel/lib/api', () => api);
vi.mock('../src/build-id', () => ({ BUILD_ID: 'build-b' }));
vi.mock('react', () => ({
  useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
  useEffect: () => undefined,
  useState: (value: unknown) => [value, () => undefined],
}));

const reload = vi.fn();
type Store = typeof import('../entrypoints/sidepanel/lib/store');
const load = async (): Promise<Store> => await import('../entrypoints/sidepanel/lib/store');

beforeEach(() => {
  vi.resetModules();
  for (const mock of [api.panel, api.readStored, api.writeStored, api.removeStored, reload]) mock.mockReset();
  vi.stubGlobal('location', { href: 'chrome-extension://x/sidepanel.html' });
  vi.stubGlobal('window', {});
  vi.stubGlobal('chrome', { runtime: { reload } });
});

describe('the panel and the service worker being different builds', () => {
  it('does nothing when the worker is the same build, and forgets an earlier reload', async () => {
    api.panel.mockResolvedValue({ buildId: 'build-b' });
    const store = await load();
    await store.checkWorkerBuild();
    expect(reload).not.toHaveBeenCalled();
    expect(api.removeStored).toHaveBeenCalledWith('t3tab.workerReload');
    expect(store.useLive().build).toBe('current');
  });

  it('writes the attempt down, then reloads the extension, when the worker is another build', async () => {
    api.panel.mockResolvedValue({ buildId: 'build-a' });
    api.readStored.mockResolvedValue(undefined);
    const store = await load();
    await store.checkWorkerBuild();
    expect(api.writeStored).toHaveBeenCalledWith('t3tab.workerReload', { buildId: 'build-b', at: expect.any(Number) });
    expect(reload).toHaveBeenCalledTimes(1);
    expect(api.writeStored.mock.invocationCallOrder[0]).toBeLessThan(reload.mock.invocationCallOrder[0] as number);
    expect(store.useLive().build).toBe('reloading');
  });

  it('counts a worker that does not know the question as another build', async () => {
    api.panel.mockRejectedValue(new Error('Invalid panel request'));
    api.readStored.mockResolvedValue(undefined);
    const store = await load();
    await store.checkWorkerBuild();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('does not reload in a loop: a reload tried for this build in the last five minutes is not repeated', async () => {
    api.panel.mockResolvedValue({ buildId: 'build-a' });
    api.readStored.mockResolvedValue({ buildId: 'build-b', at: Date.now() - 60_000 });
    const store = await load();
    await store.checkWorkerBuild();
    expect(reload).not.toHaveBeenCalled();
    expect(store.useLive().build).toBe('stuck');
  });

  it('tries again once five minutes have passed, or for another panel build', async () => {
    api.panel.mockResolvedValue({ buildId: 'build-a' });
    api.readStored.mockResolvedValue({ buildId: 'build-b', at: Date.now() - 6 * 60_000 });
    await (await load()).checkWorkerBuild();
    expect(reload).toHaveBeenCalledTimes(1);
    reload.mockReset();
    vi.resetModules();
    api.readStored.mockResolvedValue({ buildId: 'build-older', at: Date.now() });
    await (await load()).checkWorkerBuild();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('asks again later, and reloads nothing, when no answer came at all', async () => {
    api.panel.mockRejectedValue(new Error('Could not establish connection. Receiving end does not exist.'));
    const store = await load();
    await store.checkWorkerBuild();
    expect(reload).not.toHaveBeenCalled();
    expect(store.useLive().build).toBeUndefined();
  });
});
