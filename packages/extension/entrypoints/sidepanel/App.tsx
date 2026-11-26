import type { AgentConversation } from '@t3-tab/protocol';
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import type { PanelTab, TabThread } from '../../src/panel';

import { ApprovalStack } from './Approval';
import { approvalInline, QuestionCard, QueuedMessages, T3ApprovalCard, t3CardId, Timeline } from './Thread';
import { Composer, dictateInto, TabChip, ThreadModelPicker, useComposerAttachments } from './Composer';
import { useDictation } from './Dictation';
import { askerName, Banner, bindClaim, TopBar, useCatalog, useNeedsOwner, useT3, withdrawClaim, type Screen } from './Frame';
import { NewThread } from './NewThread';
import { promptCardId, PromptCards } from './PromptCards';
import { ThreadList } from './ThreadList';
import { errorText, panel } from './lib/api';
import { choiceLabel } from './lib/catalog';
import { headlessRender, refreshRunsNow, startPolling, useLive, useShareTargets, useTabStored, type LiveState } from './lib/store';
import { t3, type T3State } from './lib/t3-client';
import { directThreadView, type ThreadView } from './lib/thread-model';

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
  const [notice, setNotice] = useState<string>();
  const latestText = useRef(text);
  latestText.current = text;
  const directAgent = view?.provider === 'codex' ? 'Codex' : 'Claude Code';
  const target = useMemo(() => (screen.source === 't3' ? ({ kind: 't3' } as const) : ({ kind: 'direct', agent: directAgent } as const)), [screen.source, directAgent]);
  const attachments = useComposerAttachments(target);
  const dictation = useDictation(state, (spoken) => setText(dictateInto(latestText.current, spoken)), setNotice);
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
        let uploaded: Awaited<ReturnType<typeof attachments.forT3>> = [];
        try {
          uploaded = await attachments.forT3();
          await t3.sendMessage(screen.id, `${message}${note}`, view.running, uploaded);
        } catch (failure) {
          for (const attachment of uploaded) await t3.discardAttachment(attachment.id);
          if (code !== undefined) await withdrawClaim(code);
          throw failure;
        }
        if (code !== undefined) await bindClaim(code, screen.id);
        setShareTab(false);
      } else {
        const images = await attachments.forDirect();
        await panel({ type: 'panel.agentSend', id: screen.id, message, ...(images.length === 0 ? {} : { images }) });
        await refreshRunsNow();
      }
      setText('');
      attachments.clear();
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
  const approval = showApproval ? view?.approval : undefined;
  // As T3 does, the thread's own approval is drawn at its row in the running work log, and above the composer only when
  // that row is not shown. All the screen's cards share one lock list: browser prompts, then this approval, which takes
  // clicks only, as in T3's own client.
  const inline = approval !== undefined && view !== undefined && approvalInline(view);
  const approvalCard =
    approval === undefined ? undefined : (
      <T3ApprovalCard
        key={approval.requestId}
        approval={approval}
        presentation={inline ? 'inline' : 'dock'}
        onAnswer={async (decision) => {
          await t3.respond(screen.id, approval.requestId, { decision });
        }}
      />
    );
  const project = state.projects.find((entry) => entry.id === view?.projectId);
  const needsYou = useNeedsOwner(live, state);
  return (
    <ApprovalStack
      order={[...live.prompts.map((prompt) => promptCardId(prompt.id)), ...(approval === undefined ? [] : [t3CardId(approval.requestId)])]}
      keys={live.prompts.map((prompt) => promptCardId(prompt.id))}
    >
    <div className="screen" data-thread-id={screen.id}>
      <TopBar
        crumbs={project === undefined ? [view?.title ?? 'Thread'] : [project.title, view?.title ?? 'Thread']}
        onThreads={() => onNav({ name: 'threads' })}
        onNew={() => onNav({ name: 'home' })}
        onSettings={() => onNav({ name: 'settings', tab: 'general' })}
        sessions={live.sessions.length}
        needsYou={needsYou}
      />
      <Banner live={live} state={state} onConnections={() => onNav({ name: 'settings', tab: 'general', connections: true })} />
      {view === undefined ? <div className="timeline" /> : <Timeline view={view} approval={inline && approval?.entryId !== undefined && approvalCard !== undefined ? { entryId: approval.entryId, card: approvalCard } : undefined} />}
      <div className="dock">
        <PromptCards prompts={live.prompts} currentTabId={tab?.id} askerName={askerName(live, state)} onManageSites={() => onNav({ name: 'settings', tab: 'sites' })} />
        {inline ? null : approvalCard}
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
            <ThreadModelPicker
              name={modelLabel?.name ?? ''}
              effort={modelLabel?.effort}
              driver={directDriver}
              access={
                screen.source === 't3' && view?.runtimeMode !== undefined
                  ? {
                      value: view.runtimeMode,
                      modes: provider?.runtimeModes,
                      onChange: (mode) =>
                        void guard(async () => {
                          await t3.setRuntimeMode(screen.id, mode);
                        }),
                    }
                  : undefined
              }
            />
          }
          attachments={attachments}
          dictation={dictation}
          notice={notice}
        />
      </div>
    </div>
    </ApprovalStack>
  );
}

export function App(): ReactNode {
  const live = useLive();
  const state = useT3();
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

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if (screen.name === 'settings' || screen.name === 'threads') setScreen(backRef.current);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [screen]);

  // No setup screen: the panel opens on the new-thread screen, which carries the setup card until the helper connects.
  if (!live.loaded) return <div className="screen" />;

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
  if (screen.name === 'threads') return <ThreadList live={live} state={state} onOpen={show} onClose={() => setScreen(backRef.current)} onSettings={() => nav({ name: 'settings', tab: 'general' })} />;
  if (screen.name === 'thread') return <ThreadScreen key={screen.id} screen={screen} live={live} state={state} onNav={nav} />;
  return <NewThread live={live} state={state} onOpen={show} onNav={nav} />;
}
