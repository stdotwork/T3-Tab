import { Check, ChevronDown, Copy, Download, Moon, Paintbrush, Pencil, Plus, Sun, Trash2, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import type { SitePermission } from '../../src/permissions';
import {
  createVividThemeColors,
  getThemeColorsForMode,
  parseThemeFile,
  serializeThemeFile,
  singleAppearanceOf,
  THEME_COLOR_ROLES,
  themeColorToHex,
  type ThemeAppearance,
  type ThemeColorRole,
  type ThemeColors,
  type ThemeDefinition,
} from '../../src/t3/theme-palette';
import { errorText, panel } from './lib/api';
import { DEFAULT_PROJECT_KEY, LAST_PROJECT, NO_PROJECT, pickableProjects } from './lib/new-thread';
import { refreshPanel, useFreshSetup, useStored, type LiveState } from './lib/store';
import { t3, type T3State } from './lib/t3-client';
import { freeThemeName, importCustomTheme, previewTheme, removeCustomTheme, saveCustomTheme, setScheme, setTheme, STOCK_THEME, useAppearance, type SchemeChoice } from './lib/theme';
import { SITE_CHOICES, siteStatus } from './prompt-choices';
import { AgentRow, HelperStep, T3Row } from './Setup';
import { IconButton, timeAgo, useDismiss } from './ui';

export type SettingsTab = 'general' | 'sites';

function Orb({ colors }: { colors: ThemeColors | null }): ReactNode {
  if (colors === null) return <span className="theme-orb empty" />;
  return <span className="theme-orb" style={{ background: `radial-gradient(circle at 32% 28%, ${colors.surfaceRaised}, ${colors.canvas} 48%, ${colors.accent} 130%)` }} />;
}

function SchemeCard({ scheme, active, label }: { scheme: SchemeChoice; active: boolean; label: string }): ReactNode {
  return (
    <button type="button" className={active ? 'scheme-card active' : 'scheme-card'} aria-pressed={active} onClick={() => setScheme(scheme)}>
      <span className={`scheme-art ${scheme}`}>
        <i />
        <b />
      </span>
      {label}
    </button>
  );
}

/** One mode of a theme being edited: its two seed colours, and every colour set by hand or carried over. */
interface ModeDraft {
  canvas: string;
  accent: string;
  overrides: Partial<Record<ThemeColorRole, string>>;
}

const generated = (mode: ThemeAppearance, canvas: string, accent: string): ThemeColors => {
  const vivid = createVividThemeColors(mode, canvas, accent);
  // The send button and other solid actions follow the accent the owner picked.
  return { ...vivid, messageAction: vivid.accent, messageActionForeground: vivid.accentForeground, messageActionHover: vivid.accent };
};

/** Starts from a theme's real colours: whatever differs from what its seeds would generate stays as an override. */
function draftFrom(colors: ThemeColors, mode: ThemeAppearance): ModeDraft {
  const canvas = themeColorToHex(colors.canvas) ?? '#ffffff';
  const accent = themeColorToHex(colors.accent) ?? '#5b5bd6';
  const seeded = generated(mode, canvas, accent);
  const overrides: Partial<Record<ThemeColorRole, string>> = {};
  for (const role of THEME_COLOR_ROLES) if (colors[role] !== seeded[role]) overrides[role] = colors[role];
  return { canvas, accent, overrides };
}

const stockDraft = (mode: ThemeAppearance): ModeDraft => {
  const colors = getThemeColorsForMode(STOCK_THEME, mode) ?? STOCK_THEME.colors;
  return { canvas: themeColorToHex(colors.canvas) ?? '#ffffff', accent: themeColorToHex(colors.accent) ?? '#5b5bd6', overrides: {} };
};

function ThemeEditor({ start, editing, onClose, onSaved }: { start: ThemeDefinition | undefined; editing: boolean; onClose: () => void; onSaved: (id: string) => void }): ReactNode {
  const [name, setName] = useState(start === undefined ? 'My theme' : editing ? start.label : `${start.label} copy`);
  const startMode = start === undefined ? (document.documentElement.classList.contains('dark') ? 'dark' : 'light') : (singleAppearanceOf(start) ?? (document.documentElement.classList.contains('dark') ? 'dark' : 'light'));
  const [appearance, setAppearance] = useState<ThemeAppearance>(startMode);
  const [both, setBoth] = useState(start !== undefined && singleAppearanceOf(start) === null);
  const [drafts, setDrafts] = useState<Partial<Record<ThemeAppearance, ModeDraft>>>(() => {
    if (start === undefined) return { [startMode]: stockDraft(startMode) };
    const out: Partial<Record<ThemeAppearance, ModeDraft>> = {};
    for (const mode of ['light', 'dark'] as const) {
      const colors = getThemeColorsForMode(start, mode);
      if (colors !== null) out[mode] = draftFrom(colors, mode);
    }
    return out;
  });
  const [css, setCss] = useState(start?.css ?? '');
  const [showAll, setShowAll] = useState(false);
  const draft = drafts[appearance] ?? stockDraft(appearance);
  const { canvas, accent, overrides } = draft;
  const update = (patch: Partial<ModeDraft>): void => setDrafts((current) => ({ ...current, [appearance]: { ...(current[appearance] ?? stockDraft(appearance)), ...patch } }));
  const colorsOf = (mode: ThemeAppearance): ThemeColors => {
    const entry = drafts[mode] ?? stockDraft(mode);
    return { ...generated(mode, entry.canvas, entry.accent), ...entry.overrides };
  };
  const colors = useMemo<ThemeColors>(() => ({ ...generated(appearance, canvas, accent), ...overrides }), [appearance, canvas, accent, overrides]);
  useEffect(() => {
    previewTheme({ colors, appearance, ...(css === '' ? {} : { css }) });
  }, [colors, appearance, css]);
  useEffect(() => () => previewTheme(), []);
  const save = (): void => {
    const { id, label } = freeThemeName(name, editing ? start?.id : undefined);
    const main: ThemeAppearance = both ? 'light' : appearance;
    const other: ThemeAppearance = main === 'light' ? 'dark' : 'light';
    saveCustomTheme({ id, label, appearance: main, colors: colorsOf(main), ...(both ? { variants: { [other]: colorsOf(other) } } : {}), ...(css === '' ? {} : { css }) });
    onSaved(id);
    onClose();
  };
  const heading = editing ? 'Edit theme' : start === undefined ? 'Create theme' : 'Duplicate theme';
  return (
    <div className="sheet" role="dialog" aria-label={heading}>
      <header className="sheet-head">
        <h2>{heading}</h2>
        <IconButton label="Close" onClick={onClose}>
          <X size={16} />
        </IconButton>
      </header>
      <div className="sheet-body">
        <label className="field">
          Name
          <input value={name} maxLength={48} onChange={(event) => setName(event.target.value)} />
        </label>
        <div className="segmented wide" role="radiogroup" aria-label="Appearance">
          {(['light', 'dark'] as const).map((value) => (
            <button
              type="button"
              role="radio"
              aria-checked={appearance === value}
              key={value}
              className={appearance === value ? 'active' : ''}
              onClick={() => {
                setAppearance(value);
                // T3's generator takes light or dark from the canvas, so each mode keeps its own colours.
                setDrafts((current) => (current[value] !== undefined ? current : { ...current, [value]: stockDraft(value) }));
              }}
            >
              {value === 'light' ? <Sun size={13} /> : <Moon size={13} />} {value === 'light' ? 'Light' : 'Dark'}
            </button>
          ))}
        </div>
        <label className="check-field">
          <input type="checkbox" checked={both} onChange={(event) => setBoth(event.target.checked)} />
          Save both light and dark
        </label>
        <div className="color-pair">
          <label className="color-field">
            <input type="color" value={canvas} onChange={(event) => update({ canvas: event.target.value })} />
            Canvas
          </label>
          <label className="color-field">
            <input type="color" value={accent} onChange={(event) => update({ accent: event.target.value })} />
            Accent
          </label>
        </div>
        <button type="button" className="link-btn" aria-expanded={showAll} onClick={() => setShowAll(!showAll)}>
          {showAll ? 'Hide' : 'Edit'} all {THEME_COLOR_ROLES.length} colors
        </button>
        {showAll ? (
          <div className="role-grid">
            {THEME_COLOR_ROLES.map((role) => (
              <label className="color-field small" key={role}>
                <input type="color" value={themeColorToHex(colors[role]) ?? '#000000'} onChange={(event) => update({ overrides: { ...overrides, [role]: event.target.value } })} />
                {role}
              </label>
            ))}
            {Object.keys(overrides).length === 0 ? null : (
              <button type="button" className="link-btn role-reset" onClick={() => update({ overrides: {} })}>
                Reset to colors made from Canvas and Accent
              </button>
            )}
          </div>
        ) : null}
        <label className="field">
          Custom CSS
          <textarea rows={5} spellCheck={false} placeholder={'[data-user-message-bubble] { border-radius: 8px; }'} value={css} onChange={(event) => setCss(event.target.value)} />
          <small>Rules that load remote files are removed.</small>
        </label>
      </div>
      <footer className="sheet-foot">
        <button type="button" className="primary-btn" onClick={save}>
          Save theme
        </button>
      </footer>
    </div>
  );
}

function ThemeImport({ onClose, onSaved }: { onClose: () => void; onSaved: (id: string) => void }): ReactNode {
  const [text, setText] = useState('');
  const [error, setError] = useState<string>();
  const file = useRef<HTMLInputElement>(null);
  const add = (raw: string): void => {
    try {
      onSaved(importCustomTheme(parseThemeFile(JSON.parse(raw))));
      onClose();
    } catch (failure) {
      setError(errorText(failure));
    }
  };
  return (
    <div className="sheet" role="dialog" aria-label="Add theme">
      <header className="sheet-head">
        <h2>Add theme</h2>
        <IconButton label="Close" onClick={onClose}>
          <X size={16} />
        </IconButton>
      </header>
      <div className="sheet-body">
        <p className="muted-line">Import a theme file exported from T3 Code.</p>
        <input
          ref={file}
          type="file"
          accept=".json,application/json"
          hidden
          onChange={(event) => {
            void event.target.files?.[0]?.text().then(add);
          }}
        />
        <button type="button" className="row-btn wide" onClick={() => file.current?.click()}>
          <Download size={14} aria-hidden="true" /> Choose a file
        </button>
        <label className="field">
          Or paste its JSON
          <textarea rows={9} spellCheck={false} value={text} onChange={(event) => setText(event.target.value)} />
        </label>
        {error === undefined ? null : <p className="error-line">{error}</p>}
      </div>
      <footer className="sheet-foot">
        <button type="button" className="primary-btn" disabled={text.trim() === ''} onClick={() => add(text)}>
          Add theme
        </button>
      </footer>
    </div>
  );
}

function Appearance({ state }: { state: T3State }): ReactNode {
  const appearance = useAppearance();
  const [sheet, setSheet] = useState<{ kind: 'create'; from?: ThemeDefinition; editing?: boolean } | { kind: 'add' }>();
  const [reveal, setReveal] = useState<string>();
  const list = useRef<HTMLDivElement>(null);
  const custom = new Set(appearance.custom.map((theme) => theme.id));
  const following = appearance.theme === 'follow';
  // The owner's own themes come first, so one just made or imported is in view.
  const themes = [...appearance.themes].sort((left, right) => Number(custom.has(right.id)) - Number(custom.has(left.id)));
  const activeTheme = appearance.themes.find((theme) => theme.id === appearance.activeId);
  const only = activeTheme === undefined ? null : singleAppearanceOf(activeTheme);
  const schemeMiss = only !== null && appearance.scheme !== 'system' && appearance.scheme !== only;
  useEffect(() => {
    if (reveal === undefined) return;
    list.current?.querySelector(`[data-theme-id="${CSS.escape(reveal)}"]`)?.scrollIntoView({ block: 'center' });
    setReveal(undefined);
  }, [reveal, appearance.themes]);
  return (
    <div className="settings-page">
      <h3>Color scheme</h3>
      <div className="scheme-grid">
        <SchemeCard scheme="system" label="System" active={appearance.scheme === 'system'} />
        <SchemeCard scheme="light" label="Light" active={appearance.scheme === 'light'} />
        <SchemeCard scheme="dark" label="Dark" active={appearance.scheme === 'dark'} />
      </div>
      {schemeMiss && activeTheme !== undefined ? <p className="muted-line">{activeTheme.label} has only a {only} version, so it stays {only}.</p> : null}
      <h3>Themes</h3>
      <div className="theme-actions">
        <button type="button" className="row-btn" onClick={() => setSheet({ kind: 'create' })}>
          <Paintbrush size={14} aria-hidden="true" /> Create theme
        </button>
        <button type="button" className="row-btn" onClick={() => setSheet({ kind: 'add' })}>
          <Plus size={14} aria-hidden="true" /> Add theme
        </button>
      </div>
      <button type="button" className={following ? 'theme-card follow active' : 'theme-card follow'} aria-pressed={following} onClick={() => setTheme('follow')}>
        <span className="theme-card-name">
          Follow T3 Code
          <small>{state.status === 'ready' ? 'Uses the theme active in T3 Code' : 'Uses T3 Code’s default until connected'}</small>
        </span>
        {following ? <Check size={15} aria-hidden="true" /> : null}
      </button>
      <div className="theme-list" ref={list}>
        {themes.map((theme) => {
          const active = !following && appearance.activeId === theme.id;
          const single = singleAppearanceOf(theme);
          return (
            <div className={active ? 'theme-card active' : 'theme-card'} key={theme.id} data-theme-id={theme.id}>
              <button type="button" className="theme-pick" aria-pressed={active} aria-label={`Use ${theme.label}`} onClick={() => setTheme(theme.id)}>
                <span className="theme-orbs">
                  <Orb colors={getThemeColorsForMode(theme, 'light')} />
                  <Orb colors={getThemeColorsForMode(theme, 'dark')} />
                </span>
                <span className="theme-card-name">
                  {theme.label}
                  {single === null ? null : <small>{single === 'dark' ? 'Dark only' : 'Light only'}</small>}
                </span>
              </button>
              <span className="theme-card-tools">
                {active ? <Check size={15} className="theme-card-check" aria-hidden="true" /> : null}
                {custom.has(theme.id) ? (
                  <IconButton label={`Edit ${theme.label}`} onClick={() => setSheet({ kind: 'create', from: theme, editing: true })}>
                    <Pencil size={14} />
                  </IconButton>
                ) : null}
                <IconButton label={`Duplicate ${theme.label}`} onClick={() => setSheet({ kind: 'create', from: theme })}>
                  <Copy size={14} />
                </IconButton>
                <IconButton
                  label={`Export ${theme.label}`}
                  onClick={() => {
                    const url = URL.createObjectURL(new Blob([serializeThemeFile(theme)], { type: 'application/json' }));
                    const link = document.createElement('a');
                    link.href = url;
                    link.download = `${theme.id}.json`;
                    link.click();
                    URL.revokeObjectURL(url);
                  }}
                >
                  <Download size={14} />
                </IconButton>
                {custom.has(theme.id) ? (
                  <IconButton label={`Remove ${theme.label}`} onClick={() => removeCustomTheme(theme.id)}>
                    <Trash2 size={14} />
                  </IconButton>
                ) : null}
              </span>
            </div>
          );
        })}
      </div>
      {sheet?.kind === 'create' ? <ThemeEditor start={sheet.from} editing={sheet.editing === true} onClose={() => setSheet(undefined)} onSaved={setReveal} /> : null}
      {sheet?.kind === 'add' ? <ThemeImport onClose={() => setSheet(undefined)} onSaved={setReveal} /> : null}
    </div>
  );
}

const hostOf = (origin: string): string => {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
};

const TOOL_WORDS: Record<string, string> = { read: 'Read', open: 'Opened', act: 'Acted on', run_js: 'Ran JavaScript on' };

function Sites({ live, state }: { live: LiveState; state: T3State }): ReactNode {
  const [error, setError] = useState<string>();
  const set = async (origin: string, setting: SitePermission): Promise<void> => {
    setError(undefined);
    try {
      await panel({ type: 'panel.setSite', origin, setting });
      await refreshPanel();
    } catch (failure) {
      setError(errorText(failure));
    }
  };
  const currentOrigin = (() => {
    try {
      return live.currentTab === undefined ? undefined : new URL(live.currentTab.url).origin;
    } catch {
      return undefined;
    }
  })();
  // A site left on "ask" is the same as one never seen, so only this tab's site and real grants are listed.
  const rows = live.sites
    .filter((site) => site.setting !== 'ask' || site.origin === currentOrigin)
    .sort((left, right) => Number(right.origin === currentOrigin) - Number(left.origin === currentOrigin));
  const recent = [...live.autoAllowed].reverse().slice(0, 5);
  return (
    <div className="settings-page">
      <h3>Site permissions</h3>
      <p className="muted-line">{state.status === 'ready' ? 'T3 threads in Full access are not asked. Everyone else asks first, unless a site is set here.' : 'Agents ask first, unless a site is set here.'}</p>
      {error === undefined ? null : <p className="error-line">{error}</p>}
      <ul id="site-permissions" className="site-list">
        {rows.map((site) => (
          <li key={site.origin}>
            <span className="site-name">
              <strong>{site.origin}</strong>
              {site.origin === currentOrigin ? <span className="site-here">This tab</span> : null}
            </span>
            <small>{siteStatus(site.setting)}</small>
            <div className="segmented wide" role="radiogroup" aria-label={`What agents may do on ${site.origin}`}>
              {SITE_CHOICES.map((choice) => (
                <button
                  type="button"
                  role="radio"
                  aria-checked={site.setting === choice.setting}
                  aria-label={choice.label}
                  title={choice.label}
                  key={choice.setting}
                  className={site.setting === choice.setting ? 'active' : ''}
                  onClick={() => void set(site.origin, choice.setting)}
                >
                  {choice.short}
                </button>
              ))}
            </div>
          </li>
        ))}
        {rows.length === 0 ? <li className="muted-line">No sites set. They appear here when you allow one.</li> : null}
      </ul>
      {recent.length === 0 ? null : (
        <>
          <h3>Recently allowed by Full access</h3>
          <ul className="auto-list">
            {recent.map((entry) => (
              <li key={`${entry.at}-${entry.tabId}-${entry.tool}`}>
                <span>
                  {TOOL_WORDS[entry.tool] ?? entry.tool} <strong>{hostOf(entry.origin)}</strong>
                </span>
                <time>{timeAgo(entry.at)}</time>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function FreshSetup(): ReactNode {
  useFreshSetup();
  return null;
}

function Connections({ live, state, startOpen }: { live: LiveState; state: T3State; startOpen: boolean }): ReactNode {
  const [open, setOpen] = useState(startOpen);
  const summary = `${live.helper.connected ? 'Helper connected' : 'Helper not connected'} · ${state.status === 'ready' ? 'T3 Code connected' : 'T3 Code not connected'}`;
  return (
    <section className="disclosure">
      <button type="button" className="disclosure-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span>
          Connections
          <small>{summary}</small>
        </span>
        <ChevronDown size={15} className={open ? 'disclosure-chev open' : 'disclosure-chev'} aria-hidden="true" />
      </button>
      {open ? (
        <div className="disclosure-body">
          <FreshSetup />
          <h3>Helper</h3>
          <HelperStep live={live} icon={false} />
          <h3>Your own agents</h3>
          <AgentRow id="claude" live={live} />
          <AgentRow id="codex" live={live} />
          <p className="muted-line">
            To take the browser tools out of them, run <code>npx t3-tab@latest uninstall</code>.
          </p>
          <h3>T3 Code</h3>
          <T3Row live={live} state={state} />
          {state.status === 'off' ? null : (
            <button type="button" className="link-btn danger" onClick={() => void t3.disconnect(() => panel({ type: 'panel.t3Unpair' }))}>
              Disconnect from T3 Code
            </button>
          )}
        </div>
      ) : null}
    </section>
  );
}

function DefaultProject({ state }: { state: T3State }): ReactNode {
  const [value, setValue] = useStored<string>(DEFAULT_PROJECT_KEY, NO_PROJECT);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useDismiss(box, open, () => setOpen(false));
  const options = [
    { id: NO_PROJECT, label: 'No project' },
    { id: LAST_PROJECT, label: 'Last used project' },
    ...pickableProjects(state.projects, state.scratchRoot).map((project) => ({ id: project.id, label: project.title })),
  ];
  const current = options.find((option) => option.id === value) ?? options[0];
  return (
    <div className="setting-row">
      <span className="setting-text">
        Project on a new tab
        <small>Where a thread starts when you open the panel on a tab</small>
      </span>
      <div className="picker" ref={box}>
        <button type="button" className="row-btn" aria-haspopup="listbox" aria-expanded={open} aria-label="Project on a new tab" onClick={() => setOpen(!open)}>
          <span className="setting-value">{current?.label}</span>
          <ChevronDown size={13} aria-hidden="true" />
        </button>
        {open ? (
          <div className="popover setting-popover" role="listbox" aria-label="Project on a new tab">
            {options.map((option, index) => (
              <div key={option.id}>
                {index === 2 ? <div className="picker-divider" /> : null}
                <button
                  type="button"
                  role="option"
                  aria-selected={option.id === current?.id}
                  className={option.id === current?.id ? 'model-row active' : 'model-row'}
                  onClick={() => {
                    setValue(option.id);
                    setOpen(false);
                  }}
                >
                  <span className="project-name">{option.label}</span>
                  {option.id === current?.id ? <Check size={14} className="row-check" aria-hidden="true" /> : null}
                </button>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

const TABS: Array<{ id: SettingsTab; label: string }> = [
  { id: 'general', label: 'General' },
  { id: 'sites', label: 'Sites' },
];

export function Settings({
  live,
  state,
  tab,
  connections,
  onTab,
  onClose,
}: {
  live: LiveState;
  state: T3State;
  tab: SettingsTab;
  connections?: boolean | undefined;
  onTab: (tab: SettingsTab) => void;
  onClose: () => void;
}): ReactNode {
  return (
    <div className="screen">
      <header className="topbar">
        <span className="crumbs">
          <strong>Settings</strong>
        </span>
        <span className="topbar-spacer" />
        <IconButton label="Close settings" id="btn-settings-back" onClick={onClose}>
          <X size={16} />
        </IconButton>
      </header>
      <nav className="settings-tabs" aria-label="Settings">
        {TABS.map((entry) => (
          <button type="button" key={entry.id} className={entry.id === tab ? 'active' : ''} aria-current={entry.id === tab ? 'page' : undefined} onClick={() => onTab(entry.id)}>
            {entry.label}
          </button>
        ))}
      </nav>
      <div className="settings-scroll" data-settings-page-scroll>
        {tab === 'general' ? (
          <>
            <div className="settings-page settings-top">
              {state.status === 'ready' ? <DefaultProject state={state} /> : null}
              <Connections live={live} state={state} startOpen={connections === true} />
            </div>
            <Appearance state={state} />
          </>
        ) : null}
        {tab === 'sites' ? <Sites live={live} state={state} /> : null}
      </div>
    </div>
  );
}
