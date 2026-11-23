import type { AgentConversation } from '@t3-tab/protocol';
import { AlertCircle, Check, ChevronDown, FolderPlus, History, Plus, Search, Settings as SettingsIcon, SquarePen } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';

import type { PanelTab } from '../../src/panel';

import { ApprovalCard, QuestionCard, Timeline } from './Thread';
import { Composer, ModelPicker, RuntimeMenu, TabChip } from './Composer';
import { PromptCards } from './PromptCards';
import { Settings, type SettingsTab } from './Settings';
import { Setup } from './Setup';
import { errorText, panel } from './lib/api';
import { directProviders, resolveChoice, selectionFor, t3Providers, type Choice, type PickerProvider } from './lib/catalog';
import { headlessRender, refreshConversations, startPolling, useLive, useStored, type LiveState } from './lib/store';
import { t3, type T3State } from './lib/t3-client';
import { syncT3Theme } from './lib/theme';
import { directThreadView, type ThreadView } from './lib/thread-model';
import { IconButton, ProviderIcon, timeAgo, useDismiss } from './ui';

type Screen =
  | { name: 'home' }
  | { name: 'thread'; id: string; source: 't3' | 'direct' }
  | { name: 'threads' }
  | { name: 'settings'; tab: SettingsTab };

const useT3 = (): T3State => useSyncExternalStore(t3.subscribe, t3.snapshot);

function ProjectPicker({
  state,
  value,
  onChange,
}: {
  state: T3State;
  value: string | undefined;
  onChange: (id: string) => void;
}): ReactNode {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [adding, setAdding] = useState(false);
  const [folder, setFolder] = useState('');
  const [error, setError] = useState<string>();
  const box = useRef<HTMLDivElement>(null);
  useDismiss(box, open, () => setOpen(false));
  const current = state.projects.find((project) => project.id === value);
  const needle = query.trim().toLowerCase();
  const projects = state.projects.filter((project) => needle === '' || project.title.toLowerCase().includes(needle) || project.workspaceRoot.toLowerCase().includes(needle));
  const add = async (): Promise<void> => {
    setError(undefined);
    try {
      onChange(await t3.createProject(folder.trim()));
      setAdding(false);
      setFolder('');
      setOpen(false);
    } catch (failure) {
      setError(errorText(failure));
    }
  };
  return (
    <div className="picker hero-picker" ref={box}>
      <button type="button" className="project-btn" aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen(!open)}>
        {current?.title ?? 'Choose a project'}
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      {open ? (
        <div className="popover project-popover">
          <label className="model-search">
            <Search size={14} aria-hidden="true" />
            <input autoFocus placeholder="Search projects…" value={query} onChange={(event) => setQuery(event.target.value)} />
          </label>
          <div className="project-list" role="listbox" aria-label="Projects">
            {projects.map((project) => (
              <button
                type="button"
                role="option"
                aria-selected={project.id === value}
                key={project.id}
                className="model-row"
                onClick={() => {
                  onChange(project.id);
                  setOpen(false);
                }}
              >
                <span className="project-badge">{project.title.slice(0, 2).toUpperCase()}</span>
                <span className="project-name">{project.title}</span>
                {project.id === value ? <Check size={14} className="row-check" aria-hidden="true" /> : null}
              </button>
            ))}
            {projects.length === 0 ? <p className="model-note">No projects found.</p> : null}
          </div>
          {adding ? (
            <form
              className="project-add"
              onSubmit={(event) => {
                event.preventDefault();
                if (folder.trim() !== '') void add();
              }}
            >
              <input autoFocus placeholder="/path/to/folder" value={folder} onChange={(event) => setFolder(event.target.value)} />
              <button type="submit" className="row-btn" disabled={folder.trim() === ''}>
                Add
              </button>
            </form>
          ) : (
            <button type="button" className="model-row add" onClick={() => setAdding(true)}>
              <FolderPlus size={15} aria-hidden="true" />
              Add a project
            </button>
          )}
          {error === undefined ? null : <p className="error-line">{error}</p>}
        </div>
      ) : null}
    </div>
  );
}

function FolderPicker({ value, onChange }: { value: string; onChange: (folder: string) => void }): ReactNode {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(value);
  const box = useRef<HTMLDivElement>(null);
  useDismiss(box, open, () => setOpen(false));
  return (
    <div className="picker hero-picker" ref={box}>
      <button
        type="button"
        className="project-btn"
        aria-expanded={open}
        onClick={() => {
          setDraft(value);
          setOpen(!open);
        }}
      >
        {value === '' ? 'Home folder' : (value.replace(/\/+$/, '').split('/').at(-1) ?? value)}
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      {open ? (
        <form
          className="popover project-popover project-add"
          onSubmit={(event) => {
            event.preventDefault();
            onChange(draft.trim());
            setOpen(false);
          }}
        >
          <input autoFocus placeholder="/path/to/folder (blank for home)" value={draft} onChange={(event) => setDraft(event.target.value)} />
          <button type="submit" className="row-btn">
            Use
          </button>
        </form>
      ) : null}
    </div>
  );
}

function TopBar({ title, onThreads, onNew, onSettings }: { title: ReactNode; onThreads: () => void; onNew: () => void; onSettings: () => void }): ReactNode {
  return (
    <header className="topbar" data-chat-header>
      <IconButton label="Threads" id="btn-threads" onClick={onThreads}>
        <History size={16} />
      </IconButton>
      <span className="crumbs">{title}</span>
      <span className="topbar-spacer" />
      <IconButton label="New thread" id="btn-new" onClick={onNew}>
        <SquarePen size={16} />
      </IconButton>
      <IconButton label="Settings" id="btn-settings" onClick={onSettings}>
        <SettingsIcon size={16} />
      </IconButton>
    </header>
  );
}

function Banner({ live, state, onConnections }: { live: LiveState; state: T3State; onConnections: () => void }): ReactNode {
  let text: string | undefined;
  if (!live.helper.connected) text = 'The T3-Tab helper is not connected.';
  else if (state.status === 'lost') text = 'Reconnecting to T3 Code…';
  if (text === undefined) return null;
  return (
    <button type="button" className="banner" onClick={onConnections}>
      <AlertCircle size={13} aria-hidden="true" />
      {text}
    </button>
  );
}

interface Catalog {
  source: 't3' | 'direct';
  providers: PickerProvider[];
}

function useCatalog(live: LiveState, state: T3State): Catalog {
  return useMemo(() => {
    if (state.status === 'ready') {
      const providers = t3Providers(state);
      if (providers.length > 0) return { source: 't3', providers };
    }
    return { source: 'direct', providers: directProviders(live.setup?.agents ?? []) };
  }, [state, live.setup]);
}

function Home({ live, state, onOpen, onNav }: { live: LiveState; state: T3State; onOpen: (screen: Screen) => void; onNav: (screen: Screen) => void }): ReactNode {
  const catalog = useCatalog(live, state);
  const [text, setText] = useStored('composer.draft', '');
  const [savedChoice, setSavedChoice] = useStored<Choice | undefined>(`composer.choice.${catalog.source}`, undefined);
  const [projectId, setProjectId] = useStored<string | undefined>('composer.project', undefined);
  const [folder, setFolder] = useStored('composer.folder', '');
  const [runtimeMode, setRuntimeMode] = useStored('composer.runtime', 'full-access');
  const [shareTab, setShareTab] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const choice = resolveChoice(catalog.providers, savedChoice);
  const project = state.projects.find((entry) => entry.id === projectId) ?? state.projects[0];
  const provider = catalog.providers.find((entry) => entry.id === choice?.provider);
  const tab = live.currentTab;
  const shareable = tab !== undefined && /^https?:/.test(tab.url);

  const send = async (): Promise<void> => {
    if (choice === undefined) return;
    setBusy(true);
    setError(undefined);
    const message = text.trim();
    try {
      if (catalog.source === 't3') {
        if (project === undefined) throw new Error('Choose a project first.');
        let code: string | undefined;
        let note = '';
        if (shareTab && shareable) {
          const claim = await panel<{ code: string; note: string }>({ type: 'panel.t3Claim', tabId: tab.id, fullAccess: runtimeMode === 'full-access' });
          code = claim.code;
          note = claim.note;
        }
        try {
          const threadId = await t3.launchThread({ projectId: project.id, model: selectionFor(choice), runtimeMode, text: `${message}${note}` });
          if (code !== undefined) await panel({ type: 'panel.t3ClaimBind', code, threadId });
          setText('');
          onOpen({ name: 'thread', id: threadId, source: 't3' });
        } catch (failure) {
          if (code !== undefined) await panel({ type: 'panel.t3ClaimRevoke', code }).catch(() => undefined);
          throw failure;
        }
      } else {
        const { conversation } = await panel<{ conversation: AgentConversation }>({
          type: 'panel.agentStart',
          via: choice.provider,
          message,
          ...(folder === '' ? {} : { project: folder }),
          ...(choice.model === '' ? {} : { model: choice.model }),
          ...(tab === undefined ? {} : { tabId: tab.id }),
          ...(shareTab && shareable ? {} : { noTabs: true }),
        });
        setText('');
        await refreshConversations();
        onOpen({ name: 'thread', id: conversation.id, source: 'direct' });
      }
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="screen">
      <TopBar title={<strong>New thread</strong>} onThreads={() => onNav({ name: 'threads' })} onNew={() => undefined} onSettings={() => onNav({ name: 'settings', tab: 'appearance' })} />
      <Banner live={live} state={state} onConnections={() => onNav({ name: 'settings', tab: 'connections' })} />
      <main className="home">
        <div className="hero">
          <h1>What should we build?</h1>
          {catalog.source === 't3' ? <ProjectPicker state={state} value={project?.id} onChange={setProjectId} /> : <FolderPicker value={folder} onChange={setFolder} />}
        </div>
        <PromptCards prompts={live.prompts} currentTabId={tab?.id} />
        <Composer
          value={text}
          onChange={setText}
          onSend={() => void send()}
          running={false}
          busy={busy || choice === undefined}
          autoFocus
          placeholder="Ask anything"
          chip={shareable ? <TabChip title={tab.title} shared={shareTab} onToggle={() => setShareTab(!shareTab)} /> : null}
          picker={<ModelPicker providers={catalog.providers} choice={choice} onChoice={setSavedChoice} />}
        />
        <div className="under-composer">
          {error === undefined ? <span /> : <p className="error-line">{error}</p>}
          {catalog.source === 't3' ? <RuntimeMenu value={runtimeMode} modes={provider?.runtimeModes} onChange={setRuntimeMode} /> : null}
        </div>
      </main>
    </div>
  );
}

function useThreadView(screen: Extract<Screen, { name: 'thread' }>): ThreadView | undefined {
  const [t3View, setT3View] = useState<ThreadView>();
  useEffect(() => {
    setT3View(undefined);
    if (screen.source !== 't3') return;
    return t3.watchThread(screen.id, setT3View);
  }, [screen.id, screen.source]);
  // The list poll leaves the steps out to stay small, so the open direct run is fetched on its own.
  const [conversation, setConversation] = useState<AgentConversation>();
  useEffect(() => {
    setConversation(undefined);
    if (screen.source !== 'direct') return;
    let active = true;
    const load = (): void => {
      void panel<{ conversation: AgentConversation }>({ type: 'panel.agentGet', id: screen.id })
        .then((result) => {
          if (active) setConversation(result.conversation);
        })
        .catch(() => undefined);
    };
    load();
    const timer = setInterval(load, 400);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [screen.id, screen.source]);
  return useMemo(() => (screen.source === 't3' ? t3View : conversation === undefined ? undefined : directThreadView(conversation)), [screen.source, t3View, conversation]);
}

function ThreadScreen({ screen, live, state, onNav }: { screen: Extract<Screen, { name: 'thread' }>; live: LiveState; state: T3State; onNav: (screen: Screen) => void }): ReactNode {
  const view = useThreadView(screen);
  const conversationKey = screen.source === 't3' ? `t3:${screen.id}` : screen.id;
  const [heldTabs, setHeldTabs] = useState<PanelTab[]>([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const catalog = useCatalog(live, state);
  const [shareTab, setShareTab] = useState(false);
  const tab = live.currentTab;
  const loadTabs = useCallback(async (): Promise<void> => {
    const { tabs } = await panel<{ tabs: PanelTab[] }>({ type: 'panel.conversationTabs', id: conversationKey });
    setHeldTabs(tabs);
  }, [conversationKey]);
  useEffect(() => {
    void loadTabs().catch(() => undefined);
    const timer = setInterval(() => void loadTabs().catch(() => undefined), 1_500);
    return () => clearInterval(timer);
  }, [loadTabs]);
  const held = tab !== undefined && heldTabs.some((entry) => entry.id === tab.id);
  // A T3 thread can take another tab with a message; a direct run keeps the tabs it started with.
  const shareable = screen.source === 't3' && tab !== undefined && !held && /^https?:/.test(tab.url);
  const guard = async (action: () => Promise<unknown>): Promise<void> => {
    setError(undefined);
    try {
      await action();
    } catch (failure) {
      setError(errorText(failure));
    }
  };
  const send = async (): Promise<void> => {
    if (view === undefined) return;
    setBusy(true);
    await guard(async () => {
      const message = text.trim();
      if (screen.source === 't3') {
        let note = '';
        let code: string | undefined;
        if (shareTab && shareable) {
          const claim = await panel<{ code: string; note: string }>({ type: 'panel.t3Claim', tabId: tab.id, fullAccess: view.runtimeMode === 'full-access' });
          code = claim.code;
          note = claim.note;
        }
        try {
          await t3.sendMessage(screen.id, `${message}${note}`, view.running);
          if (code !== undefined) await panel({ type: 'panel.t3ClaimBind', code, threadId: screen.id });
          setShareTab(false);
        } catch (failure) {
          if (code !== undefined) await panel({ type: 'panel.t3ClaimRevoke', code }).catch(() => undefined);
          throw failure;
        }
      } else {
        await panel({ type: 'panel.agentSend', id: screen.id, message });
        await refreshConversations();
      }
      setText('');
    });
    setBusy(false);
  };
  const stop = (): void => {
    if (view === undefined) return;
    void guard(async () => {
      if (screen.source === 't3') await t3.stop(screen.id, view.activeRunId);
      else {
        await panel({ type: 'panel.agentStop', id: screen.id });
        await refreshConversations();
      }
    });
  };
  const provider = catalog.providers.find((entry) => entry.id === view?.provider);
  const model = provider?.models.find((entry) => entry.slug === view?.model);
  const directDriver = view?.provider === 'claude' ? 'claudeAgent' : view?.provider === 'codex' ? 'codex' : provider?.driver;
  // A browser request shows once here: the sidebar's own card carries the choices, and answering it closes T3's.
  const showApproval = view?.approval !== undefined && !(view.approval.kind === 'mcp-elicitation' && live.prompts.length > 0);
  const project = state.projects.find((entry) => entry.id === view?.projectId);
  return (
    <div className="screen" data-thread-id={screen.id}>
      <TopBar
        title={
          <>
            {project === undefined ? null : (
              <>
                <span className="crumb-muted">{project.title}</span>
                <span className="sep">/</span>
              </>
            )}
            <strong>{view?.title ?? 'Thread'}</strong>
          </>
        }
        onThreads={() => onNav({ name: 'threads' })}
        onNew={() => onNav({ name: 'home' })}
        onSettings={() => onNav({ name: 'settings', tab: 'appearance' })}
      />
      <Banner live={live} state={state} onConnections={() => onNav({ name: 'settings', tab: 'connections' })} />
      {view === undefined ? <div className="timeline" /> : <Timeline view={view} />}
      <div className="dock">
        <PromptCards prompts={live.prompts} currentTabId={tab?.id} />
        {showApproval && view?.approval !== undefined ? (
          <ApprovalCard
            approval={view.approval}
            onAnswer={(decision) => {
              const requestId = view.approval?.requestId;
              if (requestId !== undefined) void guard(async () => await t3.respond(screen.id, requestId, { decision }));
            }}
          />
        ) : null}
        {view?.question === undefined ? null : (
          <QuestionCard
            key={view.question.requestId}
            pending={view.question}
            onSubmit={(answers) => {
              const requestId = view.question?.requestId;
              if (requestId !== undefined) void guard(async () => await t3.respond(screen.id, requestId, { answers }));
            }}
          />
        )}
        {error === undefined ? null : <p className="error-line">{error}</p>}
        <Composer
          value={text}
          onChange={setText}
          onSend={() => void send()}
          onStop={stop}
          running={view?.running === true}
          busy={busy || view === undefined || (screen.source === 'direct' && view.running)}
          placeholder={view?.running === true ? 'Queue a follow-up' : 'Ask anything'}
          chip={
            <>
              {heldTabs.map((entry) => (
                <TabChip
                  key={entry.id}
                  title={entry.title}
                  shared
                  removeLabel={`Remove "${entry.title}" from this conversation`}
                  onToggle={() =>
                    void guard(async () => {
                      await panel({ type: 'panel.agentRemoveTab', id: conversationKey, tabId: entry.id });
                      await loadTabs();
                    })
                  }
                />
              ))}
              {shareable ? <TabChip title={tab.title} shared={shareTab} onToggle={() => setShareTab(!shareTab)} /> : null}
              {heldTabs.length === 0 && !shareable ? <span className="tab-chip off static">No tabs shared</span> : null}
            </>
          }
          picker={
            <span className="model-chip static">
              <ProviderIcon driver={directDriver} size={15} />
              <span className="model-chip-name">{model?.shortName ?? model?.name ?? (view?.model || (screen.source === 'direct' ? 'Default' : ''))}</span>
            </span>
          }
        />
        {screen.source === 't3' && view?.runtimeMode !== undefined ? (
          <div className="under-composer">
            <span />
            <RuntimeMenu
              value={view.runtimeMode}
              modes={provider?.runtimeModes}
              onChange={(mode) =>
                void guard(async () => {
                  await t3.setRuntimeMode(screen.id, mode);
                  await panel({ type: 'panel.t3SetFullAccess', threadId: screen.id, fullAccess: mode === 'full-access' });
                })
              }
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}

function ThreadList({ live, state, onOpen, onClose }: { live: LiveState; state: T3State; onOpen: (screen: Screen) => void; onClose: () => void }): ReactNode {
  const [query, setQuery] = useState('');
  const needle = query.trim().toLowerCase();
  const projects = new Map(state.projects.map((project) => [project.id, project]));
  const providers = new Map(state.providers.map((provider) => [provider.instanceId, provider]));
  const rows = [
    ...state.threads.map((thread) => {
      const project = projects.get(thread.projectId);
      const running = thread.status !== undefined && ['preparing', 'queued', 'starting', 'running'].includes(thread.status);
      const pendingKind = thread.pendingRuntimeRequest?.kind;
      return {
        key: `t3:${thread.id}`,
        screen: { name: 'thread', id: thread.id, source: 't3' } as Screen,
        title: thread.title,
        project: project?.title ?? 'T3 Code',
        driver: providers.get(thread.modelSelection?.instanceId ?? thread.providerInstanceId ?? '')?.driver,
        at: Date.parse(thread.latestUserMessageAt ?? thread.updatedAt ?? ''),
        badge: pendingKind === undefined ? undefined : pendingKind === 'user_input' ? 'Input' : 'Approval',
        running,
      };
    }),
    ...live.conversations
      .filter((conversation) => conversation.via !== 't3')
      .map((conversation) => ({
        key: `direct:${conversation.id}`,
        screen: { name: 'thread', id: conversation.id, source: 'direct' } as Screen,
        title: conversation.title,
        project: conversation.via === 'claude' ? 'Claude Code' : 'Codex',
        driver: conversation.via === 'claude' ? 'claudeAgent' : 'codex',
        at: conversation.updatedAt,
        badge: undefined,
        running: conversation.status === 'running',
      })),
  ]
    .filter((row) => needle === '' || row.title.toLowerCase().includes(needle) || row.project.toLowerCase().includes(needle))
    .sort((a, b) => (Number.isNaN(b.at) ? 0 : b.at) - (Number.isNaN(a.at) ? 0 : a.at));
  return (
    <div className="screen thread-list-screen" data-slot="sidebar">
      <header className="topbar">
        <IconButton label="Close threads" onClick={onClose}>
          <History size={16} />
        </IconButton>
        <label className="list-search">
          <Search size={14} aria-hidden="true" />
          <input autoFocus placeholder="Search" value={query} onChange={(event) => setQuery(event.target.value)} />
        </label>
        <IconButton label="New thread" onClick={() => onOpen({ name: 'home' })}>
          <Plus size={16} />
        </IconButton>
      </header>
      <div className="thread-list">
        {rows.map((row) => (
          <button type="button" className="thread-row" data-thread-item key={row.key} onClick={() => onOpen(row.screen)}>
            <span className="thread-row-top">
              <span className="project-badge">{row.project.slice(0, 2).toUpperCase()}</span>
              <span className="thread-project">{row.project}</span>
              {row.badge !== undefined ? <span className={`thread-badge ${row.badge.toLowerCase()}`}>{row.badge}</span> : row.running ? <span className="thread-badge working">Working</span> : <time>{timeAgo(row.at)}</time>}
            </span>
            <span className="thread-row-main">
              <span className="thread-title">{row.title}</span>
              <ProviderIcon driver={row.driver} size={14} />
            </span>
          </button>
        ))}
        {rows.length === 0 ? <p className="empty-line">{needle === '' ? 'No threads yet.' : 'No threads match.'}</p> : null}
      </div>
    </div>
  );
}

export function App(): ReactNode {
  const live = useLive();
  const state = useT3();
  const [setupDone, setSetupDone, setupLoaded] = useStored('setup.done', false);
  const [screen, setScreen] = useState<Screen>({ name: 'home' });
  const backRef = useRef<Screen>({ name: 'home' });

  useEffect(() => {
    startPolling();
    void t3.start();
  }, []);
  useEffect(() => syncT3Theme(state.defaultTheme, state.defaultAppearance, state.themes), [state.defaultTheme, state.defaultAppearance, state.themes]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if (screen.name === 'settings' || screen.name === 'threads') setScreen(backRef.current);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [screen]);

  if (!setupLoaded || !live.loaded) return <div className="screen" />;
  if (!setupDone && !headlessRender) return <Setup live={live} state={state} onDone={() => setSetupDone(true)} />;

  const nav = (next: Screen): void => {
    if (next.name === 'settings' || next.name === 'threads') {
      if (screen.name !== 'settings' && screen.name !== 'threads') backRef.current = screen;
    }
    setScreen(next);
  };
  if (screen.name === 'settings') return <Settings live={live} state={state} tab={screen.tab} onTab={(tab) => setScreen({ name: 'settings', tab })} onClose={() => setScreen(backRef.current)} />;
  if (screen.name === 'threads') return <ThreadList live={live} state={state} onOpen={setScreen} onClose={() => setScreen(backRef.current)} />;
  if (screen.name === 'thread') return <ThreadScreen key={screen.id} screen={screen} live={live} state={state} onNav={nav} />;
  return <Home live={live} state={state} onOpen={setScreen} onNav={nav} />;
}
