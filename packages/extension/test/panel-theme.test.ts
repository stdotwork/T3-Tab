import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ panel: vi.fn(), readStored: vi.fn(), writeStored: vi.fn() }));
vi.mock('../entrypoints/sidepanel/lib/api', () => api);
vi.mock('../src/t3/theme-css', () => ({ applyThemeCss: () => undefined }));
// Reading the module's state without rendering: the hook returns the current value.
vi.mock('react', () => ({ useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot() }));

type Theme = typeof import('../entrypoints/sidepanel/lib/theme');
const painted = new Map<string, string>();

async function load(stored: unknown): Promise<Theme> {
  api.readStored.mockResolvedValue(stored);
  const theme = await import('../entrypoints/sidepanel/lib/theme');
  await theme.loadAppearance();
  return theme;
}

const own = {
  id: 'custom-mine',
  label: 'Mine',
  appearance: 'dark' as const,
  colors: { canvas: '#101820' } as never,
};

beforeEach(() => {
  vi.resetModules();
  api.readStored.mockReset();
  api.writeStored.mockReset();
  painted.clear();
  vi.stubGlobal('window', { matchMedia: () => ({ matches: false, addEventListener: () => undefined }) });
  vi.stubGlobal('document', {
    documentElement: { classList: { toggle: () => undefined }, style: { setProperty: (name: string, value: string) => painted.set(name, value) } },
  });
  vi.stubGlobal('chrome', {});
});

describe('the panel theme', () => {
  it("starts on T3 Code's built-in theme with the system scheme", async () => {
    const theme = await load(undefined);
    const now = theme.useAppearance();
    expect(now.activeId).toBe('t3-code');
    expect(now.scheme).toBe('system');
    expect(painted.size).toBeGreaterThan(0);
  });

  it('turns a stored "follow T3 Code" into the built-in theme and keeps everything else', async () => {
    const theme = await load({ theme: 'follow', scheme: 'dark', custom: [own] });
    const now = theme.useAppearance();
    expect(now.activeId).toBe('t3-code');
    expect(now.theme).toBe('t3-code');
    expect(now.scheme).toBe('dark');
    expect(now.themes.map((entry) => entry.id)).toContain('custom-mine');
  });

  it('turns a stored theme that is gone, such as one T3 used to share, into the built-in theme', async () => {
    const theme = await load({ theme: 'environment-shared', scheme: 'system', custom: [] });
    expect(theme.useAppearance().activeId).toBe('t3-code');
  });

  it("keeps the owner's own theme and a built-in one", async () => {
    expect((await load({ theme: 'custom-mine', scheme: 'system', custom: [own] })).useAppearance().activeId).toBe('custom-mine');
    vi.resetModules();
    expect((await load({ theme: 'ember', scheme: 'system', custom: [] })).useAppearance().activeId).toBe('ember');
  });

  it('lists only the built-in themes and the owner\'s, with no "follow" entry', async () => {
    const theme = await load({ theme: 'custom-mine', scheme: 'system', custom: [own] });
    const ids = theme.useAppearance().themes.map((entry) => entry.id);
    expect(ids[0]).toBe('t3-code');
    expect(ids).not.toContain('follow');
    expect(ids.at(-1)).toBe('custom-mine');
  });

  it("paints the built-in theme as T3 Code does: the thread list lighter than the canvas in dark, darker in light", async () => {
    const grey = (hex: string | undefined): number => Number.parseInt((hex ?? '').slice(1, 3), 16);
    await load({ theme: 't3-code', scheme: 'dark', custom: [] });
    // T3's own app: a black canvas and the sidebar on the card surface (#111111), not the palette file's #0a0a0a and #000000.
    expect(painted.get('--app-theme-canvas')).toBe('#000000');
    expect(painted.get('--app-theme-sidebar')).toBe('#111111');
    expect(grey(painted.get('--app-theme-sidebar-row-hover'))).toBeGreaterThan(grey(painted.get('--app-theme-sidebar')));
    vi.resetModules();
    painted.clear();
    await load({ theme: 't3-code', scheme: 'light', custom: [] });
    expect(grey(painted.get('--app-theme-sidebar'))).toBeLessThan(grey(painted.get('--app-theme-canvas')));
  });

  it('goes back to the built-in theme when the theme in use is removed', async () => {
    const theme = await load({ theme: 'custom-mine', scheme: 'system', custom: [own] });
    theme.removeCustomTheme('custom-mine');
    expect(theme.useAppearance().activeId).toBe('t3-code');
    expect(api.writeStored).toHaveBeenLastCalledWith('appearance.v1', { theme: 't3-code', scheme: 'system', custom: [] });
  });
});
