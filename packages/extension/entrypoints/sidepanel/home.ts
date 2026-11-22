/*
 * Home view for the T3-Tab side panel (inbox structure).
 *
 * Top to bottom:
 * - Header: product name, compact daemon/T3 state, New, and Settings
 * - Error banner (only when disconnected, mismatched, or a request failed)
 * - "Needs you": all waiting permission prompts across sessions (collapses when none)
 * - Conversations: most recent first, with route and status
 * - Current tab: title, URL and sharing summary
 * - Connected sessions: name, tab group, shared tab count, share/unshare current tab
 */
import type { AgentPanelState, PanelState } from '../../src/panel';
import { icon } from './icons';
import { PromptListView } from './prompts';
import {
  el,
  headerStatus,
  isProtocolMismatch,
  plainText,
  sortConversations,
  STATUS_NAMES,
  VIA_NAMES,
  type PanelActions,
} from './shared';

export class HomeView {
  readonly element: HTMLElement;
  private readonly statusBadge: HTMLSpanElement;
  private readonly errorBanner: HTMLDivElement;
  private readonly errorBannerText: HTMLSpanElement;
  private readonly needsYouSection: HTMLElement;
  private readonly needsYouCount: HTMLSpanElement;
  private readonly promptList: PromptListView;
  private readonly conversationsCount: HTMLSpanElement;
  private readonly conversationsContainer: HTMLDivElement;
  private readonly currentTabContainer: HTMLDivElement;
  private readonly sessionsCount: HTMLSpanElement;
  private readonly sessionsContainer: HTMLDivElement;
  private readonly actionError: HTMLParagraphElement;

  private lastConversationsKey = '';
  private lastCurrentTabKey = '';
  private lastSessionsKey = '';

  constructor(private readonly actions: PanelActions) {
    this.element = el('section', 'panel-view');
    this.element.id = 'view-home';
    this.element.setAttribute('aria-label', 'T3-Tab home');

    // Header
    const header = el('header', 'panel-header');
    const left = el('div', 'header-left');
    const title = el('h1', 'brand-title', 'T3-Tab');
    this.statusBadge = el('span', 'badge badge-neutral', 'Checking…');
    this.statusBadge.id = 'header-status';
    left.append(title, this.statusBadge);

    const headerActions = el('div', 'header-actions');
    const newBtn = el('button', 'btn btn-primary btn-sm');
    newBtn.id = 'btn-new';
    newBtn.type = 'button';
    newBtn.append(icon('plus', 14), document.createTextNode('New'));
    newBtn.addEventListener('click', () => this.actions.openNewConversation(newBtn));

    const settingsBtn = el('button', 'btn btn-icon');
    settingsBtn.id = 'btn-settings';
    settingsBtn.type = 'button';
    settingsBtn.setAttribute('aria-label', 'Settings');
    settingsBtn.title = 'Settings';
    settingsBtn.append(icon('settings', 16));
    settingsBtn.addEventListener('click', () => this.actions.openSettings(settingsBtn));

    headerActions.append(newBtn, settingsBtn);
    header.append(left, headerActions);

    // Scrollable content
    const scroll = el('div', 'panel-scroll');

    // Error banner (hidden when healthy)
    this.errorBanner = el('div', 'banner banner-error');
    this.errorBanner.id = 'home-error-banner';
    this.errorBanner.setAttribute('role', 'alert');
    this.errorBanner.hidden = true;
    this.errorBannerText = el('span');
    this.errorBanner.append(icon('alert', 15), this.errorBannerText);

    // Needs you
    this.needsYouSection = el('section', 'section');
    this.needsYouSection.id = 'section-needs-you';
    this.needsYouSection.hidden = true;
    const needsHeader = el('div', 'section-header');
    this.needsYouCount = el('span', 'count-pill warning', '0');
    needsHeader.append(el('h2', 'section-title', 'Needs you'), this.needsYouCount);
    this.promptList = new PromptListView(this.actions);
    this.needsYouSection.append(needsHeader, this.promptList.element);

    // Conversations
    const convSection = el('section', 'section');
    convSection.id = 'section-conversations';
    const convHeader = el('div', 'section-header');
    this.conversationsCount = el('span', 'count-pill', '0');
    this.conversationsCount.hidden = true;
    convHeader.append(el('h2', 'section-title', 'Conversations'), this.conversationsCount);
    this.conversationsContainer = el('div');
    this.conversationsContainer.id = 'agent-conversations';
    convSection.append(convHeader, this.conversationsContainer);

    // Current tab
    const tabSection = el('section', 'section');
    tabSection.id = 'section-current-tab';
    const tabHeader = el('div', 'section-header');
    tabHeader.append(el('h2', 'section-title', 'Current tab'));
    this.currentTabContainer = el('div');
    tabSection.append(tabHeader, this.currentTabContainer);

    // Connected sessions
    const sessionsSection = el('section', 'section');
    sessionsSection.id = 'section-sessions';
    const sessionsHeader = el('div', 'section-header');
    this.sessionsCount = el('span', 'count-pill', '0');
    sessionsHeader.append(el('h2', 'section-title', 'Connected sessions'), this.sessionsCount);
    this.sessionsContainer = el('div');
    this.actionError = el('p', 'error-text');
    sessionsSection.append(sessionsHeader, this.sessionsContainer, this.actionError);

    scroll.append(this.errorBanner, this.needsYouSection, convSection, tabSection, sessionsSection);
    this.element.append(header, scroll);
  }

  update(
    panelState: PanelState | undefined,
    agentState: AgentPanelState | undefined,
    panelError: string | undefined,
    agentError: string | undefined,
  ): void {
    const errorMessage = panelError ?? agentError;
    const badge = headerStatus(agentState?.status, errorMessage);
    this.statusBadge.textContent = badge.label;
    this.statusBadge.className = `badge badge-${badge.tone}`;

    if (errorMessage !== undefined) {
      this.errorBanner.hidden = false;
      this.errorBannerText.textContent = isProtocolMismatch(errorMessage)
        ? 'T3-Tab extension and background program are different versions. Rebuild, run `t3-tab install`, and reload the extension.'
        : errorMessage;
    } else {
      this.errorBanner.hidden = true;
      this.errorBannerText.textContent = '';
    }

    // Prompts ("Needs you")
    const pending = panelState?.pending ?? [];
    this.promptList.update(pending);
    this.needsYouSection.hidden = pending.length === 0;
    this.needsYouCount.textContent = String(pending.length);

    // Conversations
    this.updateConversations(agentState, agentError);

    // Current tab
    this.updateCurrentTab(panelState);

    // Connected sessions
    this.updateSessions(panelState);
  }

  private updateConversations(agentState: AgentPanelState | undefined, agentError: string | undefined): void {
    if (agentState === undefined) {
      const key = agentError === undefined ? 'loading' : `error:${agentError}`;
      if (key === this.lastConversationsKey) return;
      this.lastConversationsKey = key;
      this.conversationsCount.hidden = true;
      const box = el('div', 'empty-card');
      box.append(el('p', '', agentError === undefined ? 'Loading conversations…' : 'Conversations unavailable until connected.'));
      this.conversationsContainer.replaceChildren(box);
      return;
    }

    const sorted = sortConversations(agentState.conversations);
    const key = JSON.stringify(sorted.map((c) => [c.id, c.title, c.via, c.status, c.updatedAt]));
    if (key === this.lastConversationsKey) return;
    this.lastConversationsKey = key;

    this.conversationsCount.hidden = sorted.length === 0;
    this.conversationsCount.textContent = String(sorted.length);

    if (sorted.length === 0) {
      const box = el('div', 'empty-card');
      box.append(
        el('p', '', 'No conversations yet.'),
        el('p', '', 'Start one with New. Conversations stay in memory while T3-Tab runs.'),
      );
      this.conversationsContainer.replaceChildren(box);
      return;
    }

    const list = el('ul', 'card-list');
    for (const conversation of sorted) {
      const item = document.createElement('li');
      const row = el('button', 'conv-row');
      row.type = 'button';
      row.dataset.conversationId = conversation.id;

      const dot = el('span', `status-dot ${conversation.status}`);
      dot.setAttribute('aria-hidden', 'true');

      const body = el('span', 'conv-row-body');
      const titleText = plainText(conversation.title) || '(untitled)';
      const titleEl = el('span', 'conv-row-title', titleText);
      titleEl.title = titleText;
      const subEl = el('span', 'conv-row-sub', `${VIA_NAMES[conversation.via]} · ${STATUS_NAMES[conversation.status]}`);
      body.append(titleEl, subEl);

      const chevron = icon('chevron-right', 15);
      chevron.classList.add('conv-row-chevron');

      row.append(dot, body, chevron);
      row.addEventListener('click', () => this.actions.openConversation(conversation.id, row));
      item.append(row);
      list.append(item);
    }
    this.conversationsContainer.replaceChildren(list);
  }

  private updateCurrentTab(panelState: PanelState | undefined): void {
    const current = panelState?.currentTab;
    const sessions = panelState?.sessions ?? [];
    const sharedWith =
      current === undefined
        ? []
        : sessions.filter((session) => session.sharedTabIds.includes(current.id)).map((session) => session.name);
    const key = JSON.stringify([panelState === undefined, current, sharedWith]);
    if (key === this.lastCurrentTabKey) return;
    this.lastCurrentTabKey = key;

    if (panelState === undefined) {
      const box = el('div', 'empty-card');
      box.append(el('p', '', 'Loading current tab…'));
      this.currentTabContainer.replaceChildren(box);
      return;
    }

    if (current === undefined) {
      const box = el('div', 'empty-card');
      box.append(el('p', '', 'No current tab.'));
      this.currentTabContainer.replaceChildren(box);
      return;
    }

    const card = el('div', 'surface-card');
    const row = el('div', 'current-tab-row');
    const textWrap = el('div', 'current-tab-text');
    const cleanTitle = plainText(current.title) || '(untitled)';
    const titleEl = el('p', 'card-title truncate', cleanTitle);
    titleEl.title = cleanTitle;
    const urlEl = el('p', 'muted-text truncate', current.url);
    urlEl.title = current.url;
    textWrap.append(titleEl, urlEl);
    row.append(icon('globe', 16), textWrap);
    card.append(row);

    if (sessions.length > 0) {
      const note =
        sharedWith.length === 0
          ? 'Not shared with any connected session.'
          : `Shared with ${sharedWith.map(plainText).join(', ')}.`;
      card.append(el('p', 'muted-text', note));
    }

    this.currentTabContainer.replaceChildren(card);
  }

  private updateSessions(panelState: PanelState | undefined): void {
    const sessions = panelState?.sessions ?? [];
    const currentId = panelState?.currentTab?.id;
    const key = JSON.stringify([
      panelState === undefined,
      currentId,
      sessions.map((s) => [s.id, s.name, s.groupId, s.sharedTabIds]),
    ]);
    if (key === this.lastSessionsKey) return;
    this.lastSessionsKey = key;

    this.sessionsCount.textContent = String(sessions.length);

    if (panelState === undefined) {
      const box = el('div', 'empty-card');
      box.append(el('p', '', 'Loading sessions…'));
      this.sessionsContainer.replaceChildren(box);
      return;
    }

    if (sessions.length === 0) {
      const box = el('div', 'empty-card');
      box.append(el('p', '', 'No MCP clients are connected.'));
      this.sessionsContainer.replaceChildren(box);
      return;
    }

    const list = el('ul', 'card-list');
    for (const session of sessions) {
      const item = el('li', 'surface-card');
      const top = el('div', 'card-top');
      const name = plainText(session.name);
      const nameEl = el('span', 'card-title truncate', name);
      nameEl.title = name;
      const sharedCount = session.sharedTabIds.length;
      const countLabel = `${sharedCount} shared ${sharedCount === 1 ? 'tab' : 'tabs'}`;
      top.append(nameEl, el('span', 'badge badge-neutral', countLabel));

      const groupText = session.groupId === undefined ? 'No tab group yet' : `Tab group ${session.groupId}`;
      item.append(top, el('p', 'muted-text', groupText));

      if (currentId !== undefined) {
        const shared = session.sharedTabIds.includes(currentId);
        const btnRow = el('div', 'btn-row');
        const toggleBtn = el('button', 'btn btn-sm', shared ? 'Unshare current tab' : 'Share current tab');
        toggleBtn.type = 'button';
        toggleBtn.addEventListener('click', () => {
          void this.toggleShare(session.id, shared, toggleBtn);
        });
        btnRow.append(toggleBtn);
        item.append(btnRow);
      }

      list.append(item);
    }
    this.sessionsContainer.replaceChildren(list);
  }

  private async toggleShare(sessionId: string, shared: boolean, button: HTMLButtonElement): Promise<void> {
    this.actionError.textContent = '';
    button.disabled = true;
    try {
      // Do not pass a tab id: the owner may have switched tabs since this list was rendered.
      await this.actions.send({ type: shared ? 'panel.unshareTab' : 'panel.shareTab', sessionId });
      this.actions.announce(shared ? 'Unshared current tab.' : 'Shared current tab.');
      await this.actions.refreshPanel();
    } catch (failure) {
      this.actionError.textContent = failure instanceof Error ? failure.message : String(failure);
      button.disabled = false;
    }
  }
}
