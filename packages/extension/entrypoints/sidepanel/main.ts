/*
 * Entry point and view controller for the T3-Tab side panel (inbox structure).
 *
 * Manages:
 * - Performance marks (`panel-start`, `panel-ready`)
 * - View stack (Home -> Conversation / New conversation / Settings) with Escape to go Back
 *   and focus restoration
 * - Single polite live region for completed replies and status changes
 * - Polling via the extension service worker (never talking to the daemon or T3 directly)
 * - Headless render hooks used by the end-to-end suite
 */
performance.mark('panel-start');

import type { AgentStatus } from '@t3-tab/protocol';

import type { AgentPanelState, PanelRequest, PanelState } from '../../src/panel';
import { ConversationView } from './conversation';
import { HomeView } from './home';
import { NewConversationView } from './new-conversation';
import { SettingsView } from './settings';
import { plainText, type PanelActions } from './shared';

type Screen = 'home' | 'conversation' | 'new' | 'settings';

const app = document.querySelector<HTMLElement>('#app');
const liveStatus = document.querySelector<HTMLElement>('#live-status');
const params = new URL(location.href).searchParams;
const tabIdParam = params.get('tabId');
const fixedTabId = tabIdParam === null ? undefined : Number(tabIdParam);
const stateRequest: PanelRequest =
  fixedTabId !== undefined && Number.isInteger(fixedTabId)
    ? { type: 'panel.state', tabId: fixedTabId }
    : { type: 'panel.state' };
const headless = params.get('headless') === '1';

let panelState: PanelState | undefined;
let agentState: AgentPanelState | undefined;
let panelError: string | undefined;
let agentError: string | undefined;
let currentScreen: Screen = 'home';
let selectedConversationId: string | undefined;
let returnFocusEl: HTMLElement | undefined;
let readyMarked = false;

/** Last observed status and assistant message count per conversation, for polite live announcements. */
const observedConversations = new Map<string, { status: AgentStatus; assistantCount: number }>();

function announce(message: string): void {
  if (liveStatus === null) return;
  liveStatus.textContent = '';
  requestAnimationFrame(() => {
    liveStatus.textContent = message;
  });
}

async function send(request: PanelRequest): Promise<unknown> {
  const result: unknown = await chrome.runtime.sendMessage(request);
  if (typeof result === 'object' && result !== null && (result as { ok?: unknown }).ok === false) {
    throw new Error(String((result as { error?: unknown }).error ?? 'The request failed'));
  }
  return result;
}

const actions: PanelActions = {
  send,
  refreshPanel,
  refreshAgents,
  announce,
  openConversation(id, trigger) {
    selectedConversationId = id;
    pushScreen('conversation', trigger);
  },
  openNewConversation(trigger) {
    pushScreen('new', trigger);
  },
  openSettings(trigger) {
    pushScreen('settings', trigger);
  },
  goBack() {
    if (currentScreen === 'home') return;
    currentScreen = 'home';
    syncVisibleScreen();
    renderAll();
    const target = returnFocusEl;
    returnFocusEl = undefined;
    if (target !== undefined && target.isConnected) {
      target.focus();
    } else if (selectedConversationId !== undefined) {
      const row = homeView.element.querySelector<HTMLButtonElement>(`[data-conversation-id="${CSS.escape(selectedConversationId)}"]`);
      row?.focus();
    }
  },
};

const homeView = new HomeView(actions);
const conversationView = new ConversationView(actions);
const newConversationView = new NewConversationView(actions);
const settingsView = new SettingsView(actions);

if (app !== null) {
  app.replaceChildren(homeView.element, conversationView.element, newConversationView.element, settingsView.element);
}

function pushScreen(screen: Exclude<Screen, 'home'>, trigger?: HTMLElement): void {
  if (currentScreen === 'home' && trigger !== undefined) {
    returnFocusEl = trigger;
  }
  currentScreen = screen;
  syncVisibleScreen();
  renderAll();
  const heading =
    screen === 'conversation'
      ? conversationView.heading
      : screen === 'new'
        ? newConversationView.heading
        : settingsView.heading;
  heading.focus();
}

function syncVisibleScreen(): void {
  homeView.element.hidden = currentScreen !== 'home';
  conversationView.element.hidden = currentScreen !== 'conversation';
  newConversationView.element.hidden = currentScreen !== 'new';
  settingsView.element.hidden = currentScreen !== 'settings';
}

function renderAll(): void {
  homeView.update(panelState, agentState, panelError, agentError);
  if (currentScreen === 'conversation') {
    const conv = agentState?.conversations.find((candidate) => candidate.id === selectedConversationId);
    const held = conv === undefined ? [] : (agentState?.conversationTabs[conv.id] ?? []);
    conversationView.update(conv, held);
  }
  newConversationView.update(agentState, agentError ?? panelError);
  settingsView.update(panelState, agentState?.t3Access);

  if (!readyMarked && (panelState !== undefined || agentState !== undefined)) {
    readyMarked = true;
    performance.mark('panel-ready');
  }
}

function noteConversationUpdates(next: AgentPanelState): void {
  for (const conv of next.conversations) {
    const assistantCount = conv.messages.filter((m) => m.role === 'assistant').length;
    const prev = observedConversations.get(conv.id);
    if (prev !== undefined) {
      const title = plainText(conv.title) || 'conversation';
      if (assistantCount > prev.assistantCount) {
        announce(`New reply in ${title}.`);
      } else if (prev.status !== conv.status) {
        if (conv.status === 'idle') announce(`${title} finished.`);
        else if (conv.status === 'failed') announce(`${title} failed.`);
        else if (conv.status === 'waiting') announce(`${title} is waiting for an answer in T3 Code.`);
      }
    }
    observedConversations.set(conv.id, { status: conv.status, assistantCount });
  }
}

function renderPanelState(next: PanelState): void {
  panelState = next;
  panelError = undefined;
  renderAll();
}

function renderAgentState(next: AgentPanelState): void {
  agentState = next;
  agentError = undefined;
  noteConversationUpdates(next);
  renderAll();
}

async function refreshPanel(): Promise<void> {
  try {
    const result = (await send(stateRequest)) as PanelState | { ok: true };
    if (!('sessions' in result)) throw new Error('Unexpected panel state');
    renderPanelState(result);
  } catch (failure) {
    panelError = failure instanceof Error ? failure.message : String(failure);
    renderAll();
  }
}

async function refreshAgents(force = false): Promise<void> {
  try {
    const req: PanelRequest =
      fixedTabId !== undefined && Number.isInteger(fixedTabId)
        ? { type: 'panel.agents', ...(force ? { refresh: true } : {}), tabId: fixedTabId }
        : { type: 'panel.agents', ...(force ? { refresh: true } : {}) };
    const result = (await send(req)) as AgentPanelState;
    renderAgentState(result);
  } catch (failure) {
    agentError = failure instanceof Error ? failure.message : String(failure);
    renderAll();
  }
}

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing) return;
  if (currentScreen !== 'home') {
    event.preventDefault();
    actions.goBack();
  }
});

if (headless) {
  const hooks = globalThis as typeof globalThis & {
    __t3tabRenderPanelState?: typeof renderPanelState;
    __t3tabRenderAgentState?: typeof renderAgentState;
  };
  hooks.__t3tabRenderPanelState = renderPanelState;
  hooks.__t3tabRenderAgentState = renderAgentState;
} else {
  void refreshPanel();
  setInterval(() => void refreshPanel(), 1_000);
  void refreshAgents(true);
  setInterval(() => void refreshAgents(), 2_000);
}
