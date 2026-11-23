import { Check, ChevronDown, Copy, Download, Moon, Paintbrush, Plus, Sun, Trash2, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import type { SitePermission } from '../../src/permissions';
import {
  createVividThemeColors,
  getThemeColorsForMode,
  parseThemeFile,
  serializeThemeFile,
  THEME_COLOR_ROLES,
  themeColorToHex,
  themeIdFromName,
  type ThemeAppearance,
  type ThemeColorRole,
  type ThemeColors,
  type ThemeDefinition,
} from '../../src/t3/theme-palette';
import { errorText, panel } from './lib/api';
import { DEFAULT_PROJECT_KEY, LAST_PROJECT, NO_PROJECT, pickableProjects } from './lib/new-thread';
import { refreshPanel, useStored, type LiveState } from './lib/store';
import { t3, type T3State } from './lib/t3-client';
import { previewTheme, removeCustomTheme, saveCustomTheme, setScheme, setTheme, STOCK_THEME, useAppearance, type SchemeChoice } from './lib/theme';
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

function ThemeEditor({ start, onClose }: { start: ThemeDefinition | undefined; onClose: () => void }): ReactNode {
  const seedColors = start?.colors ?? STOCK_THEME.colors;
  const [name, setName] = useState(start === undefined ? 'My theme' : `${start.label} copy`);
  const [appearance, setAppearance] = useState<ThemeAppearance>(start?.appearance ?? (document.documentElement.classList.contains('dark') ? 'dark' : 'light'));
  const [canvas, setCanvas] = useState(themeColorToHex(seedColors.canvas) ?? '#ffffff');
  const [accent, setAccent] = useState(themeColorToHex(seedColors.accent) ?? '#5b5bd6');
  const [overrides, setOverrides] = useState<Partial<Record<ThemeColorRole, string>>>({});
  const [css, setCss] = useState(start?.css ?? '');
  const [showAll, setShowAll] = useState(false);
  const colors = useMemo<ThemeColors>(() => {
    const vivid = createVividThemeColors(appearance, canvas, accent);
    // The send button and other solid actions follow the accent the owner picked.
    return { ...vivid, messageAction: vivid.accent, messageActionForeground: vivid.accentForeground, messageActionHover: vivid.accent, ...overrides };
  }, [appearance, canvas, accent, overrides]);
  useEffect(() => {
    previewTheme({ colors, appearance, ...(css === '' ? {} : { css }) });
  }, [colors, appearance, css]);
  useEffect(() => () => previewTheme(), []);
  const save = (): void => {
    const label = name.trim().slice(0, 48) || 'My theme';
    saveCustomTheme({ id: `custom-${themeIdFromName(label)}`.slice(0, 48), label, appearance, colors, ...(css === '' ? {} : { css }) });
    onClose();
  };
  return (
    <div className="sheet" role="dialog" aria-label="Create theme">
      <header className="sheet-head">
        <h2>Create theme</h2>
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
                // T3's generator takes light or dark from the canvas, so the canvas has to change with the toggle.
                const seed = (start === undefined ? undefined : getThemeColorsForMode(start, value)) ?? getThemeColorsForMode(STOCK_THEME, value);
                if (seed !== null) setCanvas(themeColorToHex(seed.canvas) ?? canvas);
              }}
            >
              {value === 'light' ? <Sun size={13} /> : <Moon size={13} />} {value === 'light' ? 'Light' : 'Dark'}
            </button>
          ))}
        </div>
        <div className="color-pair">
          <label className="color-field">
            <input type="color" value={canvas} onChange={(event) => setCanvas(event.target.value)} />
            Canvas
          </label>
          <label className="color-field">
            <input type="color" value={accent} onChange={(event) => setAccent(event.target.value)} />
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
                <input type="color" value={themeColorToHex(colors[role]) ?? '#000000'} onChange={(event) => setOverrides({ ...overrides, [role]: event.target.value })} />
                {role}
              </label>
            ))}
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

function ThemeImport({ onClose }: { onClose: () => void }): ReactNode {
  const [text, setText] = useState('');
  const [error, setError] = useState<string>();
  const file = useRef<HTMLInputElement>(null);
  const add = (raw: string): void => {
    try {
      saveCustomTheme(parseThemeFile(JSON.parse(raw)));
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
  const [sheet, setSheet] = useState<{ kind: 'create'; from?: ThemeDefinition } | { kind: 'add' }>();
  const custom = new Set(appearance.custom.map((theme) => theme.id));
  const following = appearance.theme === 'follow';
  return (
    <div className="settings-page">
      <h3>Color scheme</h3>
      <div className="scheme-grid">
        <SchemeCard scheme="system" label="System" active={appearance.scheme === 'system'} />
        <SchemeCard scheme="light" label="Light" active={appearance.scheme === 'light'} />
        <SchemeCard scheme="dark" label="Dark" active={appearance.scheme === 'dark'} />
      </div>
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
      <div className="theme-list">
        {appearance.themes.map((theme) => {
          const active = !following && appearance.activeId === theme.id;
          return (
            <div className={active ? 'theme-card active' : 'theme-card'} key={theme.id}>
              <button type="button" className="theme-pick" aria-pressed={active} aria-label={`Use ${theme.label}`} onClick={() => setTheme(theme.id)}>
                <span className="theme-orbs">
                  <Orb colors={getThemeColorsForMode(theme, 'light')} />
                  <Orb colors={getThemeColorsForMode(theme, 'dark')} />
                </span>
                <span className="theme-card-name">{theme.label}</span>
              </button>
              <span className="theme-card-tools">
                {active ? <Check size={15} className="theme-card-check" aria-hidden="true" /> : null}
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
      {sheet?.kind === 'create' ? <ThemeEditor start={sheet.from} onClose={() => setSheet(undefined)} /> : null}
      {sheet?.kind === 'add' ? <ThemeImport onClose={() => setSheet(undefined)} /> : null}
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

function Sites({ live }: { live: LiveState }): ReactNode {
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
      <p className="muted-line">T3 threads in Full access are not asked. Everyone else asks first, unless a site is set here.</p>
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

function Sessions({ live }: { live: LiveState }): ReactNode {
  const [error, setError] = useState<string>();
  const tab = live.currentTab;
  const toggle = async (sessionId: string, shared: boolean): Promise<void> => {
    if (tab === undefined) return;
    setError(undefined);
    try {
      await panel({ type: shared ? 'panel.unshareTab' : 'panel.shareTab', sessionId, tabId: tab.id });
      await refreshPanel();
    } catch (failure) {
      setError(errorText(failure));
    }
  };
  return (
    <>
      <h3>Connected agents</h3>
      {error === undefined ? null : <p className="error-line">{error}</p>}
      <ul id="connected-sessions" className="site-list">
        {live.sessions.map((session) => {
          const shared = tab !== undefined && session.sharedTabIds.includes(tab.id);
          const count = session.sharedTabIds.length;
          return (
            <li key={session.id}>
              <strong>{session.name}</strong>
              <small>{count === 0 ? 'No shared tabs' : count === 1 ? '1 shared tab' : `${count} shared tabs`}</small>
              {tab === undefined ? null : (
                <span className="site-actions">
                  <button type="button" className="row-btn" onClick={() => void toggle(session.id, shared)}>
                    {shared ? 'Stop sharing this tab' : 'Share this tab'}
                  </button>
                </span>
              )}
            </li>
          );
        })}
        {live.sessions.length === 0 ? <li className="muted-line">No agents are using the browser.</li> : null}
      </ul>
    </>
  );
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
          <h3>Helper</h3>
          <HelperStep live={live} icon={false} />
          <h3>Agents</h3>
          <AgentRow id="claude" live={live} />
          <AgentRow id="codex" live={live} />
          <h3>T3 Code</h3>
          <T3Row live={live} state={state} />
          {state.status === 'off' ? null : (
            <button type="button" className="link-btn danger" onClick={() => void t3.disconnect(() => panel({ type: 'panel.t3Unpair' }))}>
              Disconnect from T3 Code
            </button>
          )}
          <Sessions live={live} />
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
              <DefaultProject state={state} />
              <Connections live={live} state={state} startOpen={connections === true} />
            </div>
            <Appearance state={state} />
          </>
        ) : null}
        {tab === 'sites' ? <Sites live={live} /> : null}
      </div>
    </div>
  );
}
