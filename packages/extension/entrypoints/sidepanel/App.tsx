import type { AgentConversation } from '@t3-tab/protocol';
import { AlarmClock, ChevronDown, History, Pin, Plus, Search } from 'lucide-react';
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import type { PanelTab, TabThread } from '../../src/panel';

import { ApprovalCard, QuestionCard, QueuedMessages, Timeline } from './Thread';
import { Composer, RuntimeMenu, TabChip } from './Composer';
import { askerName, Banner, bindClaim, directRuns, TopBar, useCatalog, useNeedsOwner, useT3, useWakeClock, withdrawClaim, type Screen } from './Frame';
import { NewThread } from './NewThread';
import { PromptCards } from './PromptCards';
import { ActiveSessions } from './Sessions';
import { Setup } from './Setup';
import { errorText, panel } from './lib/api';
import { choiceLabel } from './lib/catalog';
import { headlessRender, refreshRunsNow, startPolling, useLive, useShareTargets, useStored, useTabStored, type LiveState } from './lib/store';
import { t3, type T3State } from './lib/t3-client';
import { syncT3Theme } from './lib/theme';
import { directThreadView, type ThreadView } from './lib/thread-model';
import { SETTLED_FIRST, SETTLED_MORE, SHELF_LABEL, STATUS_LABEL, threadSections, wakeLabel, type ListRow } from './lib/thread-sections';
import { IconButton, ProviderIcon, timeAgo } from './ui';

// Settings holds the theme editor and every site control, which a panel that is just running threads never opens.
const Settings = lazy(async () => ({ default: (await import('./Settings')).Settings }));

/** What this tab's panel was showing, so it comes back the same when the owner returns to the tab. */
type TabScreen = { name: 'home' } | ({ name: 'thread' } & TabThread);

const DIRECT_RUN_MS = 400;
const DIRECT_RETRY_MS = 3_000;

function useThreadView(screen: Extract<Screen, { name: 'thread' }>, listedAt: number | undefined): ThreadView | undefined {
  const [t3View, setT3View] = useState<ThreadView>();
  useEffect(() => {
    setT3View(undefined);
    if (screen.source !== 't3') return;
    return t3.watchThread(screen.id, setT3View);
  }, [screen.id, screen.source]);
  // The list poll leaves the steps out to stay small, so the open direct run is fetched on its own.
  const [conversation, setConversation] = useState<AgentConversation>();
  useEffect(() => setConversation(undefined), [screen.id, screen.source]);
  // Followed closely only while it runs. A finished run is fetched again when the list says it changed.
  useEffect(() => {
    if (screen.source !== 'direct') return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async (): Promise<void> => {
      const result = await panel<{ conversation: AgentConversation }>({ type: 'panel.agentGet', id: screen.id }).catch(() => undefined);
      if (!active) return;
      if (result !== undefined) setConversation(result.conversation);
      const status = result?.conversation.status;
      if (result === undefined) timer = setTimeout(() => void load(), DIRECT_RETRY_MS);
      else if (status === 'running' || status === 'waiting') timer = setTimeout(() => void load(), document.hidden ? DIRECT_RETRY_MS : DIRECT_RUN_MS);
    };
    void load();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [screen.id, screen.source, listedAt]);
  return useMemo(() => (screen.source === 't3' ? t3View : conversation === undefined ? undefined : directThreadView(conversation)), [screen.source, t3View, conversation]);
}

function ThreadScreen({ screen, live, state, onNav }: { screen: Extract<Screen, { name: 'thread' }>; live: LiveState; state: T3State; onNav: (screen: Screen) => void }): ReactNode {
  const view = useThreadView(screen, screen.source === 'direct' ? live.conversations.find((entry) => entry.id === screen.id)?.updatedAt : undefined);
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
  }, [loadTabs, live.changes]);
  const held = tab !== undefined && heldTabs.some((entry) => entry.id === tab.id);
  // A T3 thread can take another tab with a message; a direct run keeps the tabs it started with.
  const shareable = screen.source === 't3' && tab !== undefined && !held && /^https?:/.test(tab.url);
  const targets = useShareTargets(shareable ? tab : undefined, live.changes);
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
        await refreshRunsNow();
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
        await refreshRunsNow();
      }
    });
  };
  const provider = catalog.providers.find((entry) => entry.id === view?.provider);
  const modelLabel = view === undefined ? undefined : choiceLabel(catalog.providers, { provider: view.provider ?? '', model: view.model ?? '', options: view.modelOptions ?? {} });
  const directDriver = view?.provider === 'claude' ? 'claudeAgent' : view?.provider === 'codex' ? 'codex' : provider?.driver;
  // A browser request shows once here: the sidebar's own card carries the choices, and answering it closes T3's.
  const showApproval = view?.approval !== undefined && !(view.approval.kind === 'mcp-elicitation' && live.prompts.length > 0);
  const project = state.projects.find((entry) => entry.id === view?.projectId);
  const needsYou = useNeedsOwner(live, state);
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
        sessions={live.sessions.length}
        needsYou={needsYou}
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
        {view === undefined ? null : (
          <QueuedMessages
            queued={view.queued}
            running={view.running}
            onCancel={(runId) => void guard(async () => await t3.cancelQueued(screen.id, runId))}
            onStart={(runId) => void guard(async () => await t3.startQueued(screen.id, runId))}
          />
        )}
        <Composer
          value={text}
          onChange={setText}
          onSend={() => void send()}
          onStop={stop}
          running={view?.running === true}
          canQueue={screen.source === 't3'}
          busy={busy || view === undefined || (screen.source === 'direct' && view.running)}
          placeholder={view?.running !== true ? 'Ask anything' : screen.source === 't3' ? 'Queue a follow-up' : 'Working. You can reply when this turn ends.'}
          chip={
            <>
              {heldTabs.map((entry) => (
                <TabChip
                  key={entry.id}
                  title={entry.title}
                  state="held"
                  removeLabel={`Remove "${entry.title}" from this conversation`}
                  onToggle={() =>
                    void guard(async () => {
                      await panel({ type: 'panel.agentRemoveTab', id: conversationKey, tabId: entry.id });
                      await loadTabs();
                    })
                  }
                />
              ))}
              {shareable ? <TabChip title={tab.title} state={shareTab ? 'pending' : 'off'} tabs={targets.tabs} group={targets.groupTitle} nextMessage onToggle={() => setShareTab(!shareTab)} /> : null}
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

function Shelf({ id, label, count, open, onToggle, className }: { id: string; label: string; count: number; open: boolean; onToggle: () => void; className?: string }): ReactNode {
  return (
    <button type="button" className={className === undefined ? 'shelf' : `shelf ${className}`} data-shelf={id} aria-expanded={open} onClick={onToggle}>
      <span className="shelf-label">{label}</span>
      <span className="shelf-line" aria-hidden="true" />
      <span className="shelf-count">{count}</span>
      <ChevronDown size={12} className={open ? 'shelf-chevron' : 'shelf-chevron closed'} aria-hidden="true" />
    </button>
  );
}

function ThreadList({ live, state, onOpen, onClose }: { live: LiveState; state: T3State; onOpen: (screen: Screen) => void; onClose: () => void }): ReactNode {
  const [query, setQuery] = useState('');
  // T3 keeps its shelves closed until the owner opens them, and remembers that; so does the panel.
  const [workingOpen, setWorkingOpen] = useStored('threads.workingOpen', false);
  const [snoozedOpen, setSnoozedOpen] = useStored('threads.snoozedOpen', false);
  const [settledOpen, setSettledOpen] = useStored('threads.settledOpen', false);
  const [settledShown, setSettledShown] = useState(SETTLED_FIRST);
  const now = useWakeClock(state);
  const needle = query.trim().toLowerCase();
  const projects = new Map(state.projects.map((project) => [project.id, project]));
  const providers = new Map(state.providers.map((provider) => [provider.instanceId, provider]));
  const sections = threadSections(state.threads, directRuns(live), now);
  const describe = (row: ListRow): { title: string; project: string; driver: string | undefined } => {
    if (row.source === 'direct') {
      const via = live.conversations.find((conversation) => conversation.id === row.id)?.via;
      return { title: row.run.title, project: via === 'claude' ? 'Claude Code' : 'Codex', driver: via === 'claude' ? 'claudeAgent' : 'codex' };
    }
    const project = projects.get(row.shell.projectId);
    return {
      title: row.shell.title,
      project: project !== undefined && project.workspaceRoot === state.scratchRoot ? 'No project' : (project?.title ?? 'T3 Code'),
      driver: providers.get(row.shell.modelSelection?.instanceId ?? row.shell.providerInstanceId ?? '')?.driver,
    };
  };
  const renderRow = (row: ListRow): ReactNode => {
    const { title, project, driver } = describe(row);
    const lastAt = row.source === 'direct' ? row.run.updatedAt : Date.parse(row.shell.latestUserMessageAt ?? row.shell.updatedAt ?? '');
    return (
      <button
        type="button"
        className="thread-row"
        data-thread-item
        data-section={row.section}
        key={`${row.source}:${row.id}`}
        onClick={() => onOpen({ name: 'thread', id: row.id, source: row.source })}
      >
        <span className="thread-row-top">
          {row.pinned ? <Pin size={11} className="thread-pin" aria-label="Pinned" /> : null}
          <span className="thread-project">{project}</span>
          {row.status !== undefined ? (
            <span className={`thread-badge ${row.status}`}>{STATUS_LABEL[row.status]}</span>
          ) : row.source === 't3' && row.wakesAt !== undefined ? (
            <span className="thread-badge snoozed" title="Wakes">
              <AlarmClock size={11} aria-hidden="true" />
              {wakeLabel(row.wakesAt, now)}
            </span>
          ) : (
            <time>{timeAgo(lastAt)}</time>
          )}
        </span>
        <span className="thread-row-main">
          <span className="thread-title">{title}</span>
          <ProviderIcon driver={driver} size={14} />
        </span>
      </button>
    );
  };

  const searching = needle !== '';
  // A search looks through every section, in T3's order, whether its shelf is open or not.
  const matches = searching
    ? [...sections.pinned, ...sections.active, ...sections.working, ...sections.snoozed, ...sections.settled].filter((row) => {
        const { title, project } = describe(row);
        return title.toLowerCase().includes(needle) || project.toLowerCase().includes(needle);
      })
    : [];
  const total = sections.pinned.length + sections.active.length + sections.working.length + sections.snoozed.length + sections.settled.length;
  const settledRows = sections.settled.slice(0, settledShown);
  const settledHidden = sections.settled.length - settledRows.length;
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
        <ActiveSessions live={live} state={state} onOpen={onOpen} />
        {searching ? (
          <>
            {matches.map(renderRow)}
            {matches.length === 0 ? <p className="empty-line">No threads match.</p> : null}
          </>
        ) : (
          <>
            {sections.pinned.map(renderRow)}
            {sections.pinned.length > 0 && sections.active.length > 0 ? <div className="pinned-divider" aria-hidden="true" /> : null}
            {sections.active.map(renderRow)}
            {total === 0 ? <p className="empty-line">No threads yet.</p> : null}
            <div className="shelves">
              {sections.working.length > 0 ? (
                <section aria-label={SHELF_LABEL.working}>
                  <Shelf id="working" label={SHELF_LABEL.working} count={sections.working.length} open={workingOpen} onToggle={() => setWorkingOpen(!workingOpen)} />
                  {workingOpen ? sections.working.map(renderRow) : null}
                </section>
              ) : null}
              {sections.snoozed.length > 0 ? (
                <section aria-label={SHELF_LABEL.snoozed}>
                  <Shelf id="snoozed" label={SHELF_LABEL.snoozed} count={sections.snoozed.length} open={snoozedOpen} onToggle={() => setSnoozedOpen(!snoozedOpen)} />
                  {snoozedOpen ? sections.snoozed.map(renderRow) : null}
                </section>
              ) : null}
              {state.status === 'off' && sections.settled.length === 0 ? null : (
                <section aria-label={SHELF_LABEL.settled}>
                  <Shelf id="settled" label={SHELF_LABEL.settled} count={sections.settled.length} open={settledOpen} onToggle={() => setSettledOpen(!settledOpen)} />
                  {settledOpen ? settledRows.map(renderRow) : null}
                  {settledOpen && settledHidden > 0 ? (
                    <button type="button" className="shelf-more" onClick={() => setSettledShown(settledShown + SETTLED_MORE)}>
                      <ChevronDown size={14} aria-hidden="true" />
                      Show {Math.min(settledHidden, SETTLED_MORE)} more
                    </button>
                  ) : null}
                </section>
              )}
            </div>
          </>
        )}
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
    return (
      <Suspense fallback={<div className="screen" />}>
        <Settings live={live} state={state} tab={screen.tab} connections={screen.connections} onTab={(tab) => setScreen({ name: 'settings', tab })} onClose={() => setScreen(backRef.current)} />
      </Suspense>
    );
  }
  if (screen.name === 'threads') return <ThreadList live={live} state={state} onOpen={show} onClose={() => setScreen(backRef.current)} />;
  if (screen.name === 'thread') return <ThreadScreen key={screen.id} screen={screen} live={live} state={state} onNav={nav} />;
  return <NewThread live={live} state={state} onOpen={show} onNav={nav} />;
}
