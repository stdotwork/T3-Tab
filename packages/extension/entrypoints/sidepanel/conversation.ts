/*
 * Conversation detail view for the T3-Tab side panel (pushed from Home, with Back).
 *
 * References:
 * - Nanobrowser TabBar.tsx (Apache-2.0, pattern only): tab chips above composer with × unshare
 * - Nanobrowser Activity.tsx (Apache-2.0, pattern only): compact run status line in composer
 */
import type { AgentConversation } from '@t3-tab/protocol';

import type { PanelTab } from '../../src/panel';
import { icon } from './icons';
import { el, nextTurnLine, plainText, STATUS_NAMES, VIA_NAMES, type PanelActions } from './shared';

export class ConversationView {
  readonly element: HTMLElement;
  readonly heading: HTMLHeadingElement;
  private readonly metaStrip: HTMLDivElement;
  private readonly scrollArea: HTMLDivElement;
  private readonly messagesList: HTMLOListElement;
  private readonly tabsList: HTMLUListElement;
  private readonly nextTurnEl: HTMLParagraphElement;
  private readonly replyInput: HTMLTextAreaElement;
  private readonly statusDot: HTMLSpanElement;
  private readonly statusText: HTMLSpanElement;
  private readonly sendBtn: HTMLButtonElement;
  private readonly errorEl: HTMLParagraphElement;

  private conversationId: string | undefined;
  private lastMessagesKey = '';
  private lastTabsKey = '';
  private sending = false;
  /** Unsent replies per conversation, so a draft never follows the owner into another conversation. */
  private readonly drafts = new Map<string, string>();

  constructor(private readonly actions: PanelActions) {
    this.element = el('section', 'panel-view pushed');
    this.element.id = 'agent-thread';
    this.element.hidden = true;
    this.element.setAttribute('aria-label', 'Conversation');

    // Header
    const header = el('header', 'panel-header');
    const left = el('div', 'header-left');
    const backBtn = el('button', 'btn btn-ghost btn-sm');
    backBtn.id = 'btn-conv-back';
    backBtn.type = 'button';
    backBtn.append(icon('arrow-left', 14), document.createTextNode('Back'));
    backBtn.addEventListener('click', () => this.actions.goBack());

    this.heading = el('h1', 'view-title', 'Conversation');
    this.heading.tabIndex = -1;
    left.append(backBtn, this.heading);
    header.append(left);

    // Route & model meta
    this.metaStrip = el('div', 'conv-meta-strip');

    // Scrollable messages
    this.scrollArea = el('div', 'panel-scroll');
    this.messagesList = el('ol', 'message-list');
    this.scrollArea.append(this.messagesList);

    // Sticky composer dock
    const dock = el('div', 'composer-dock');
    this.tabsList = el('ul', 'tab-chips');
    this.tabsList.id = 'agent-grants';
    this.tabsList.setAttribute('aria-label', 'Tabs held by this conversation');

    this.nextTurnEl = el('p', 'muted-text');
    this.nextTurnEl.id = 'agent-next-turn';

    const form = document.createElement('form');
    form.className = 'composer-box';

    this.replyInput = document.createElement('textarea');
    this.replyInput.id = 'agent-reply';
    this.replyInput.className = 'composer-input';
    this.replyInput.rows = 2;
    this.replyInput.placeholder = 'Reply… (Enter to send, Shift+Enter for new line)';
    this.replyInput.setAttribute('aria-label', 'Reply message');
    this.replyInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        form.requestSubmit();
      }
    });

    const footer = el('div', 'composer-footer');
    const statusWrap = el('div', 'composer-status');
    this.statusDot = el('span', 'status-dot idle');
    this.statusDot.setAttribute('aria-hidden', 'true');
    this.statusText = el('span', '', 'Done');
    statusWrap.append(this.statusDot, this.statusText);

    this.sendBtn = el('button', 'btn btn-primary composer-send');
    this.sendBtn.type = 'submit';
    this.sendBtn.setAttribute('aria-label', 'Send message');
    this.sendBtn.title = 'Send message';
    this.sendBtn.append(icon('arrow-up', 15));

    footer.append(statusWrap, this.sendBtn);
    form.append(this.replyInput, footer);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      void this.submit();
    });

    this.errorEl = el('p', 'error-text');
    dock.append(this.tabsList, this.nextTurnEl, form, this.errorEl);

    this.element.append(header, this.metaStrip, this.scrollArea, dock);
  }

  /** Updates the view for the given conversation. Only touches the message or tab DOM when data changed. */
  update(conversation: AgentConversation | undefined, heldTabs: readonly PanelTab[]): boolean {
    if (conversation === undefined) {
      if (this.conversationId !== undefined) this.drafts.set(this.conversationId, this.replyInput.value);
      this.replyInput.value = '';
      this.conversationId = undefined;
      return false;
    }

    const switched = this.conversationId !== conversation.id;
    if (switched) {
      if (this.conversationId !== undefined) this.drafts.set(this.conversationId, this.replyInput.value);
      this.replyInput.value = this.drafts.get(conversation.id) ?? '';
    }
    this.conversationId = conversation.id;

    const cleanTitle = plainText(conversation.title) || 'Conversation';
    this.heading.textContent = cleanTitle;
    this.heading.title = cleanTitle;

    const metaParts = [
      VIA_NAMES[conversation.via],
      conversation.model === undefined
        ? undefined
        : `${conversation.provider === undefined ? '' : `${conversation.provider}/`}${conversation.model}`,
      conversation.threadId === undefined ? undefined : conversation.threadId,
    ].filter((part): part is string => part !== undefined);
    this.metaStrip.textContent = metaParts.join(' · ');

    this.statusDot.className = `status-dot ${conversation.status}`;
    this.statusText.textContent = STATUS_NAMES[conversation.status];

    // Messages: render only when changed
    const messagesKey = JSON.stringify([conversation.id, conversation.messages]);
    const messagesChanged = messagesKey !== this.lastMessagesKey;
    if (messagesChanged) {
      const wasNearBottom =
        switched || this.scrollArea.scrollHeight - this.scrollArea.scrollTop - this.scrollArea.clientHeight < 64;
      this.lastMessagesKey = messagesKey;
      const items = conversation.messages.map((entry) => {
        const item = el('li', `message ${entry.role}`);
        if (entry.role !== 'user') {
          const roleLabel = entry.role === 'error' ? 'Error' : VIA_NAMES[conversation.via];
          item.append(el('div', 'message-role', roleLabel));
        }
        item.append(el('p', 'message-text', entry.text));
        return item;
      });
      this.messagesList.replaceChildren(...items);
      const lastItem = items.at(-1);
      if (wasNearBottom && lastItem !== undefined && typeof lastItem.scrollIntoView === 'function') {
        lastItem.scrollIntoView({ block: 'start' });
      }
    }

    // Held tabs as chips: render only when changed
    this.nextTurnEl.textContent = nextTurnLine(conversation.via, [...heldTabs]);
    const tabsKey = JSON.stringify([conversation.id, heldTabs]);
    if (tabsKey !== this.lastTabsKey) {
      this.lastTabsKey = tabsKey;
      this.tabsList.replaceChildren(...heldTabs.map((tab) => this.createTabChip(conversation.id, tab)));
    }

    this.sendBtn.disabled = this.sending || (conversation.via !== 't3' && conversation.status === 'running');
    return messagesChanged;
  }

  private createTabChip(conversationId: string, tab: PanelTab): HTMLLIElement {
    const item = el('li', 'tab-chip');
    const cleanTitle = plainText(tab.title) || '(untitled)';
    item.title = `${cleanTitle}\n${tab.url}`;

    const label = el('span', 'tab-chip-label', cleanTitle);
    const removeBtn = el('button', 'tab-chip-remove');
    removeBtn.type = 'button';
    removeBtn.dataset.tabId = String(tab.id);
    removeBtn.setAttribute('aria-label', `Remove "${cleanTitle}" from this conversation`);
    removeBtn.title = 'Remove from conversation (keeps tab open)';
    removeBtn.append(icon('x', 12));
    removeBtn.addEventListener('click', () => {
      void this.removeTab(conversationId, tab.id, cleanTitle, removeBtn);
    });

    item.append(icon('globe', 12), label, removeBtn);
    return item;
  }

  private async removeTab(conversationId: string, tabId: number, title: string, button: HTMLButtonElement): Promise<void> {
    this.errorEl.textContent = '';
    button.disabled = true;
    try {
      await this.actions.send({ type: 'panel.agentRemoveTab', id: conversationId, tabId });
      this.actions.announce(`Removed "${title}" from this conversation.`);
      await this.actions.refreshAgents();
    } catch (failure) {
      this.errorEl.textContent = failure instanceof Error ? failure.message : String(failure);
      button.disabled = false;
    }
  }

  private async submit(): Promise<void> {
    if (this.conversationId === undefined || this.sending) return;
    const text = this.replyInput.value;
    if (text.trim() === '') return;
    const id = this.conversationId;
    this.sending = true;
    this.errorEl.textContent = '';
    this.sendBtn.disabled = true;
    try {
      await this.actions.send({ type: 'panel.agentSend', id, message: text });
      this.drafts.delete(id);
      if (this.conversationId === id) this.replyInput.value = '';
      this.actions.announce('Message sent.');
      await this.actions.refreshAgents();
    } catch (failure) {
      this.errorEl.textContent = failure instanceof Error ? failure.message : String(failure);
    } finally {
      this.sending = false;
      this.sendBtn.disabled = false;
    }
  }
}
