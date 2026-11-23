/**
 * Appearance: follows T3's active theme by default; T3 theme files can be imported and themes edited in full.
 * Colours are T3's 61 roles, applied as the same `--app-theme-*` variables T3 Code uses.
 */
import { useSyncExternalStore } from 'react';

import { applyThemeCss } from '../../../src/t3/theme-css';
import {
  APP_THEME_VARIABLES,
  environmentThemeDefinition,
  getThemeColorsForMode,
  themeIdFromName,
  type EnvironmentTheme,
  type ThemeAppearance,
  type ThemeColors,
  type ThemeDefinition,
} from '../../../src/t3/theme-palette';
import { BUILT_IN_THEMES, T3_CODE_DARK_THEME_COLORS, T3_CODE_LIGHT_THEME_COLORS } from '../../../src/t3/theme-palettes';
import { readStored, writeStored } from './api';

export const STOCK_THEME: ThemeDefinition = {
  id: 't3-code',
  label: 'T3 Code',
  appearance: 'light',
  colors: T3_CODE_LIGHT_THEME_COLORS,
  variants: { dark: T3_CODE_DARK_THEME_COLORS },
};

export type SchemeChoice = 'system' | 'light' | 'dark';

export interface AppearanceState {
  /** `follow` uses T3's active theme; otherwise a theme id. */
  theme: string;
  scheme: SchemeChoice;
  custom: ThemeDefinition[];
}

const KEY = 'appearance.v1';
let state: AppearanceState = { theme: 'follow', scheme: 'system', custom: [] };
let t3Theme = '';
let t3Appearance = '';
let t3Themes: ThemeDefinition[] = [];
let preview: { colors: ThemeColors; appearance: ThemeAppearance; css?: string } | undefined;
const listeners = new Set<() => void>();
const media = window.matchMedia('(prefers-color-scheme: dark)');

const notify = (): void => {
  for (const listener of listeners) listener();
};

export function allThemes(): ThemeDefinition[] {
  const seen = new Set<string>();
  return [STOCK_THEME, ...BUILT_IN_THEMES, ...t3Themes, ...state.custom].filter((theme) => {
    if (seen.has(theme.id)) return false;
    seen.add(theme.id);
    return true;
  });
}

function resolvedTheme(): ThemeDefinition {
  const id = state.theme === 'follow' ? t3Theme : state.theme;
  return allThemes().find((theme) => theme.id === id) ?? STOCK_THEME;
}

function resolvedAppearance(theme: ThemeDefinition): ThemeAppearance {
  const wanted = state.theme === 'follow' && (t3Appearance === 'light' || t3Appearance === 'dark') && state.scheme === 'system' ? t3Appearance : state.scheme;
  const appearance: ThemeAppearance = wanted === 'system' ? (media.matches ? 'dark' : 'light') : wanted;
  return getThemeColorsForMode(theme, appearance) === null ? theme.appearance : appearance;
}

function paint(): void {
  const root = document.documentElement;
  let colors: ThemeColors;
  let appearance: ThemeAppearance;
  let css: string | undefined;
  if (preview !== undefined) {
    ({ colors, appearance, css } = preview);
  } else {
    const theme = resolvedTheme();
    appearance = resolvedAppearance(theme);
    colors = getThemeColorsForMode(theme, appearance) ?? theme.colors;
    css = theme.css;
  }
  root.classList.toggle('dark', appearance === 'dark');
  root.style.colorScheme = appearance;
  for (const [role, value] of Object.entries(colors)) {
    root.style.setProperty(APP_THEME_VARIABLES[role as keyof ThemeColors], value);
  }
  applyThemeCss(css);
}

export async function loadAppearance(): Promise<void> {
  const stored = await readStored<AppearanceState>(KEY);
  if (stored !== undefined) state = { ...state, ...stored };
  media.addEventListener('change', () => {
    paint();
    notify();
  });
  // A panel on another tab changed the theme.
  chrome.storage?.onChanged?.addListener((changes, area) => {
    const next = changes[KEY]?.newValue as AppearanceState | undefined;
    if (area !== 'local' || next === undefined || JSON.stringify(next) === JSON.stringify(state)) return;
    state = { ...state, ...next };
    paint();
    notify();
  });
  paint();
  notify();
}

function save(next: AppearanceState): void {
  state = next;
  void writeStored(KEY, next);
  paint();
  notify();
}

export const setTheme = (theme: string): void => save({ ...state, theme });
export const setScheme = (scheme: SchemeChoice): void => save({ ...state, scheme });

export function saveCustomTheme(theme: ThemeDefinition, select = true): void {
  const known = state.custom.findIndex((entry) => entry.id === theme.id);
  // An edit keeps the theme's place in the list.
  const custom = known === -1 ? [...state.custom, theme] : state.custom.map((entry, index) => (index === known ? theme : entry));
  save({ ...state, custom, theme: select ? theme.id : state.theme });
}

/**
 * A name and id no other theme has: `Name`, then `Name 2`, `Name 3`. `keepId` is the theme being edited, which may keep
 * its own.
 */
export function freeThemeName(wanted: string, keepId?: string): { id: string; label: string } {
  const taken = allThemes().filter((theme) => theme.id !== keepId);
  const base = wanted.trim().slice(0, 44) || 'My theme';
  // The slug is cut before the number goes on, so a long name still gets a different id each round.
  const slug = themeIdFromName(base).slice(0, 34);
  for (let number = 1; ; number += 1) {
    const label = number === 1 ? base : `${base} ${number}`;
    const id = keepId ?? (number === 1 ? `custom-${slug}` : `custom-${slug}-${number}`);
    if (!taken.some((theme) => theme.id === id || theme.label.toLowerCase() === label.toLowerCase())) return { id, label };
  }
}

/** Adds a theme from a file. The same file twice is one theme; a different theme under a used name gets a new one. */
export function importCustomTheme(theme: ThemeDefinition): string {
  const same = state.custom.find((entry) => entry.label === theme.label && JSON.stringify({ ...entry, id: '' }) === JSON.stringify({ ...theme, id: '' }));
  if (same !== undefined) {
    setTheme(same.id);
    return same.id;
  }
  const { id, label } = freeThemeName(theme.label);
  saveCustomTheme({ ...theme, id, label });
  return id;
}

export function removeCustomTheme(id: string): void {
  save({ ...state, custom: state.custom.filter((entry) => entry.id !== id), theme: state.theme === id ? 'follow' : state.theme });
}

/** Draws a draft without saving it. Pass nothing to go back to the saved theme. */
export function previewTheme(draft?: { colors: ThemeColors; appearance: ThemeAppearance; css?: string }): void {
  preview = draft;
  paint();
}

/** T3's active theme and its published themes, as they change. */
export function syncT3Theme(defaultTheme: string, defaultAppearance: string, themes: readonly EnvironmentTheme[]): void {
  const definitions = themes.map(environmentThemeDefinition);
  if (defaultTheme === t3Theme && defaultAppearance === t3Appearance && JSON.stringify(definitions) === JSON.stringify(t3Themes)) return;
  t3Theme = defaultTheme;
  t3Appearance = defaultAppearance;
  t3Themes = definitions;
  paint();
  notify();
}

let version = 0;
listeners.add(() => {
  version += 1;
});

export function useAppearance(): AppearanceState & { themes: ThemeDefinition[]; activeId: string } {
  useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => version,
  );
  return { ...state, themes: allThemes(), activeId: resolvedTheme().id };
}
