import type { AgentConversation } from '@t3-tab/protocol';
import { History, Plus, Search } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import type { PanelTab, TabThread } from '../../src/panel';

import { ApprovalCard, QuestionCard, Timeline } from './Thread';
import { Composer, RuntimeMenu, TabChip } from './Composer';
import { askerName, Banner, bindClaim, isRunningStatus, TopBar, useCatalog, useT3, withdrawClaim, type Screen } from './Frame';
import { NewThread } from './NewThread';
import { PromptCards } from './PromptCards';
import { Settings } from './Settings';
import { Setup } from './Setup';
import { errorText, panel } from './lib/api';
import { choiceLabel } from './lib/catalog';
import { headlessRender, refreshConversations, startPolling, useLive, useStored, useTabStored, type LiveState } from './lib/store';
import { t3, type T3State } from './lib/t3-client';
import { syncT3Theme } from './lib/theme';
import { directThreadView, type ThreadView } from './lib/thread-model';
import { IconButton, ProviderIcon, timeAgo } from './ui';

/** What this tab's panel was showing, so it comes back the same when the owner returns to the tab. */
type TabScreen = { name: 'home' } | ({ name: 'thread' } & TabThread);

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
          const claim = await panel<{ code: string; note: string }>({ type: 'panel.t3Claim', tabId: tab.id });
          code = claim.code;
          note = claim.note;
        }
        try {
          await t3.sendMessage(screen.id, `${message}${note}`, view.running);
        } catch (failure) {
          if (code !== undefined) await withdrawClaim(code);
          throw failure;
        }
        if (code !== undefined) await bindClaim(code, screen.id);
        setShareTab(false);
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
  const modelLabel = view === undefined ? undefined : choiceLabel(catalog.providers, { provider: view.provider ?? '', model: view.model ?? '', options: view.modelOptions ?? {} });
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
        onSettings={() => onNav({ name: 'settings', tab: 'general' })}
      />
      <Banner live={live} state={state} onConnections={() => onNav({ name: 'settings', tab: 'general', connections: true })} />
      {view === undefined ? <div className="timeline" /> : <Timeline view={view} />}
      <div className="dock">
        <PromptCards prompts={live.prompts} currentTabId={tab?.id} askerName={askerName(live, state)} onManageSites={() => onNav({ name: 'settings', tab: 'sites' })} />
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
              <span className="model-chip-name">{modelLabel?.name ?? ''}</span>
              {modelLabel?.effort === undefined ? null : <span className="model-chip-effort">{modelLabel.effort}</span>}
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
      const running = isRunningStatus(thread.status);
      const pendingKind = thread.pendingRuntimeRequest?.kind;
      return {
        key: `t3:${thread.id}`,
        screen: { name: 'thread', id: thread.id, source: 't3' } as Screen,
        title: thread.title,
        project: project !== undefined && project.workspaceRoot === state.scratchRoot ? 'No project' : (project?.title ?? 'T3 Code'),
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
  const [tabScreen, setTabScreen, tabScreenReady] = useTabStored<TabScreen | undefined>('screen', undefined);
  const backRef = useRef<Screen>({ name: 'home' });
  const restored = useRef(headlessRender);
  const restoredT3Thread = useRef<string>(undefined);

  /** Shows a screen and, for a thread or the new-thread screen, remembers it for this tab. */
  const show = (next: Screen): void => {
    setScreen(next);
    if (next.name === 'home') setTabScreen({ name: 'home' });
    else if (next.name === 'thread') setTabScreen({ name: 'thread', id: next.id, source: next.source });
  };

  // Once per panel: back to what this tab was showing, or to the thread that holds this tab.
  useEffect(() => {
    if (restored.current || !tabScreenReady || live.tabLoaded !== true) return;
    restored.current = true;
    const target = tabScreen === undefined ? live.tabThread : tabScreen.name === 'thread' ? tabScreen : undefined;
    if (target === undefined) return;
    setScreen({ name: 'thread', id: target.id, source: target.source });
    if (target.source === 't3') restoredT3Thread.current = target.id;
    else void panel({ type: 'panel.agentGet', id: target.id }).catch(() => show({ name: 'home' }));
  }, [tabScreenReady, live.tabLoaded]);

  // A remembered T3 thread that T3 no longer lists falls back to a new thread.
  useEffect(() => {
    const id = restoredT3Thread.current;
    if (id === undefined || state.status !== 'ready') return;
    restoredT3Thread.current = undefined;
    if (screen.name === 'thread' && screen.id === id && !state.threads.some((thread) => thread.id === id)) show({ name: 'home' });
  }, [state.status, state.threads]);

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
    show(next);
  };
  if (screen.name === 'settings') {
    return <Settings live={live} state={state} tab={screen.tab} connections={screen.connections} onTab={(tab) => setScreen({ name: 'settings', tab })} onClose={() => setScreen(backRef.current)} />;
  }
  if (screen.name === 'threads') return <ThreadList live={live} state={state} onOpen={show} onClose={() => setScreen(backRef.current)} />;
  if (screen.name === 'thread') return <ThreadScreen key={screen.id} screen={screen} live={live} state={state} onNav={nav} />;
  return <NewThread live={live} state={state} onOpen={show} onNav={nav} />;
}
