/*
 * New conversation view for the T3-Tab side panel (pushed from Home, with Back).
 * Supports T3 Code threads (with T3's project/model lists when signed in, or typed fields)
 * and direct Claude Code / Codex runs.
 */
import type { AgentConversation, AgentVia, T3Catalog } from '@t3-tab/protocol';

import type { AgentPanelState, AgentStartRequest } from '../../src/panel';
import { icon } from './icons';
import {
  choice,
  defaultVia,
  el,
  fillLists,
  shareLine,
  statusLine,
  TYPED_CHOICE,
  updateDefaultModelOption,
  VIA_NAMES,
  type PanelActions,
} from './shared';

const FIELDS_KEY = 't3tab.agentFields';

interface SavedFields {
  project?: string;
  provider?: string;
  model?: string;
  projectChoice?: string;
  modelChoice?: string;
}

export class NewConversationView {
  readonly element: HTMLElement;
  readonly heading: HTMLHeadingElement;
  private readonly statusEl: HTMLParagraphElement;
  private readonly viaSelect: HTMLSelectElement;
  private readonly signInHint: HTMLDivElement;
  private readonly projectListField: HTMLLabelElement;
  private readonly projectList: HTMLSelectElement;
  private readonly modelListField: HTMLLabelElement;
  private readonly modelList: HTMLSelectElement;
  private readonly projectField: HTMLLabelElement;
  private readonly projectFieldLabel: HTMLSpanElement;
  private readonly projectInput: HTMLInputElement;
  private readonly providerField: HTMLLabelElement;
  private readonly providerInput: HTMLInputElement;
  private readonly modelField: HTMLLabelElement;
  private readonly modelInput: HTMLInputElement;
  private readonly shareText: HTMLSpanElement;
  private readonly messageInput: HTMLTextAreaElement;
  private readonly startBtn: HTMLButtonElement;
  private readonly errorEl: HTMLParagraphElement;

  private lastState: AgentPanelState | undefined;
  private catalog: T3Catalog | undefined;
  private chosenVia = false;
  private submitting = false;
  private readonly saved: SavedFields;

  constructor(private readonly actions: PanelActions) {
    this.element = el('section', 'panel-view pushed');
    this.element.id = 'view-new';
    this.element.hidden = true;
    this.element.setAttribute('aria-label', 'New conversation');

    // Header
    const header = el('header', 'panel-header');
    const left = el('div', 'header-left');
    const backBtn = el('button', 'btn btn-ghost btn-sm');
    backBtn.id = 'btn-new-back';
    backBtn.type = 'button';
    backBtn.append(icon('arrow-left', 14), document.createTextNode('Back'));
    backBtn.addEventListener('click', () => this.actions.goBack());

    this.heading = el('h1', 'view-title', 'New conversation');
    this.heading.tabIndex = -1;
    left.append(backBtn, this.heading);
    header.append(left);

    // Body
    const scroll = el('div', 'panel-scroll');

    this.statusEl = el('p', 'muted-text', 'Checking for T3 Code…');
    this.statusEl.id = 'agent-status';

    const form = document.createElement('form');
    form.className = 'form-stack';

    this.viaSelect = document.createElement('select');
    this.viaSelect.id = 'agent-via';
    this.viaSelect.className = 'control';
    for (const value of ['t3', 'claude', 'codex'] as const) {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = value === 't3' ? 'T3 Code thread' : `${VIA_NAMES[value]} (direct)`;
      this.viaSelect.append(opt);
    }

    this.signInHint = el('div', 'share-note');
    const signInText = el('span', 'share-note-text', 'Sign in to T3 Code in Settings to pick from your projects and models.');
    const openSettingsLink = el('button', 'inline-link', 'Open Settings');
    openSettingsLink.type = 'button';
    openSettingsLink.addEventListener('click', () => this.actions.openSettings(openSettingsLink));
    const hintBody = el('div', 'form-stack');
    hintBody.style.gap = 'var(--space-1)';
    hintBody.append(signInText, openSettingsLink);
    this.signInHint.append(hintBody);
    this.signInHint.hidden = true;

    this.projectList = document.createElement('select');
    this.projectList.id = 'agent-project-list';
    this.projectList.className = 'control';
    this.projectListField = labelledField('Project', this.projectList);

    this.modelList = document.createElement('select');
    this.modelList.id = 'agent-model-list';
    this.modelList.className = 'control';
    this.modelListField = labelledField('Provider and model', this.modelList);

    this.projectInput = textInput('agent-project', 'Project id, or a folder inside the project');
    this.projectFieldLabel = el('span', 'field-label', 'Project');
    this.projectField = document.createElement('label');
    this.projectField.className = 'field';
    this.projectField.append(this.projectFieldLabel, this.projectInput);

    this.providerInput = textInput('agent-provider', 'Optional, such as claudeAgent');
    this.providerField = labelledField('Provider instance', this.providerInput);

    this.modelInput = textInput('agent-model', "Optional: the project's default");
    this.modelField = labelledField('Model', this.modelInput);

    const shareBox = el('div', 'share-note');
    shareBox.id = 'agent-share';
    this.shareText = el('span', 'share-note-text', 'No current tab to share.');
    shareBox.append(icon('globe', 14), this.shareText);

    this.messageInput = document.createElement('textarea');
    this.messageInput.id = 'agent-message';
    this.messageInput.className = 'control';
    this.messageInput.rows = 3;
    this.messageInput.placeholder = 'What should the agent do with this tab?';
    this.messageInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        form.requestSubmit();
      }
    });

    this.startBtn = el('button', 'btn btn-primary', 'Start conversation');
    this.startBtn.id = 'btn-start';
    this.startBtn.type = 'submit';

    this.errorEl = el('p', 'error-text');
    this.errorEl.id = 'agent-error';

    form.append(
      labelledField('Run with', this.viaSelect),
      this.signInHint,
      this.projectListField,
      this.projectField,
      this.modelListField,
      this.providerField,
      this.modelField,
      shareBox,
      labelledField('Message', this.messageInput),
      this.startBtn,
      this.errorEl,
    );

    scroll.append(this.statusEl, form);
    this.element.append(header, scroll);

    this.saved = this.restoreFields();

    this.viaSelect.addEventListener('change', () => {
      this.chosenVia = true;
      this.syncFields();
    });
    this.projectList.addEventListener('change', () => this.syncFields());
    this.modelList.addEventListener('change', () => this.syncFields());
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      void this.submit();
    });
  }

  update(state: AgentPanelState | undefined, errorMessage?: string): void {
    this.lastState = state;
    if (state === undefined) {
      this.statusEl.textContent = errorMessage ?? 'Checking for T3 Code…';
      this.startBtn.disabled = true;
      return;
    }

    const nextCatalog = state.t3Access.catalog;
    // Rebuilt only when T3's lists change, so a refresh never closes an open list or drops the owner's pick.
    if (nextCatalog?.fetchedAt !== this.catalog?.fetchedAt) {
      const projectPick = this.projectList.options.length > 0 ? this.projectList.value : this.saved.projectChoice;
      const modelPick = this.modelList.options.length > 0 ? this.modelList.value : this.saved.modelChoice;
      this.catalog = nextCatalog;
      if (this.catalog !== undefined) {
        fillLists(this.projectList, this.modelList, this.catalog, projectPick, modelPick);
      } else {
        this.projectList.replaceChildren();
        this.modelList.replaceChildren();
      }
    }

    if (!this.chosenVia) this.viaSelect.value = defaultVia(state.status);
    this.syncFields();
    this.shareText.textContent = shareLine(state.shareTabs);
    this.startBtn.disabled = this.submitting || state.shareTabs.length === 0;
  }

  private syncFields(): void {
    const direct = this.viaSelect.value !== 't3';
    const lists = !direct && this.catalog !== undefined;
    const typedProject = !lists || this.projectList.value === TYPED_CHOICE;
    const typedModel = !lists || this.modelList.value === TYPED_CHOICE;

    this.signInHint.hidden = direct || lists || this.lastState?.t3Access.state === 'signed-in';
    this.projectListField.hidden = !lists;
    this.modelListField.hidden = !lists;
    this.projectField.hidden = !typedProject;
    this.projectFieldLabel.textContent = direct ? 'Folder (optional)' : lists ? 'Project id or folder' : 'Project';
    this.projectInput.placeholder = direct ? 'Absolute path; default: your home folder' : 'Project id, or a folder inside the project';
    this.providerField.hidden = direct || !typedModel;
    this.modelField.hidden = !direct && !typedModel;
    this.modelInput.placeholder = direct ? "Optional: the CLI's default" : "Optional: the project's default";

    updateDefaultModelOption(this.modelList, this.catalog, this.projectList.value);
    if (this.lastState !== undefined) {
      this.statusEl.textContent = statusLine(this.lastState.status, this.viaSelect.value as AgentVia);
    }
  }

  private async submit(): Promise<void> {
    if (this.submitting) return;
    this.submitting = true;
    this.errorEl.textContent = '';
    this.startBtn.disabled = true;
    try {
      const via = this.viaSelect.value as AgentVia;
      const request: AgentStartRequest = { type: 'panel.agentStart', via, message: this.messageInput.value };
      const lists = via === 't3' && this.catalog !== undefined;
      const picked = lists ? choice(this.projectList.value, this.modelList.value) : {};
      if (lists && this.projectList.value !== TYPED_CHOICE) {
        if (picked.project !== undefined) request.project = picked.project;
      } else if (this.projectInput.value.trim() !== '') {
        request.project = this.projectInput.value.trim();
      }
      if (lists && this.modelList.value !== TYPED_CHOICE) {
        if (picked.provider !== undefined && picked.model !== undefined) {
          request.provider = picked.provider;
          request.model = picked.model;
        }
      } else {
        if (this.providerInput.value.trim() !== '' && via === 't3') request.provider = this.providerInput.value.trim();
        if (this.modelInput.value.trim() !== '') request.model = this.modelInput.value.trim();
      }

      const result = (await this.actions.send(request)) as { conversation: AgentConversation };
      this.saveFields();
      this.messageInput.value = '';
      this.actions.announce('Conversation started.');
      await this.actions.refreshAgents();
      this.actions.openConversation(result.conversation.id);
    } catch (failure) {
      this.errorEl.textContent = failure instanceof Error ? failure.message : String(failure);
    } finally {
      this.submitting = false;
      this.startBtn.disabled = (this.lastState?.shareTabs.length ?? 0) === 0;
    }
  }

  private saveFields(): void {
    try {
      const fields: SavedFields = {
        project: this.projectInput.value,
        provider: this.providerInput.value,
        model: this.modelInput.value,
      };
      if (this.projectList.options.length > 0) fields.projectChoice = this.projectList.value;
      if (this.modelList.options.length > 0) fields.modelChoice = this.modelList.value;
      localStorage.setItem(FIELDS_KEY, JSON.stringify(fields));
    } catch {
      // Storage may be unavailable; fields start empty next time.
    }
  }

  private restoreFields(): SavedFields {
    try {
      const stored: unknown = JSON.parse(localStorage.getItem(FIELDS_KEY) ?? '{}');
      if (typeof stored !== 'object' || stored === null) return {};
      const fields = stored as Record<string, unknown>;
      if (typeof fields.project === 'string') this.projectInput.value = fields.project;
      if (typeof fields.provider === 'string') this.providerInput.value = fields.provider;
      if (typeof fields.model === 'string') this.modelInput.value = fields.model;
      const restored: SavedFields = {};
      if (typeof fields.projectChoice === 'string') restored.projectChoice = fields.projectChoice;
      if (typeof fields.modelChoice === 'string') restored.modelChoice = fields.modelChoice;
      return restored;
    } catch {
      return {};
    }
  }
}

function textInput(id: string, placeholder: string): HTMLInputElement {
  const node = document.createElement('input');
  node.id = id;
  node.className = 'control';
  node.placeholder = placeholder;
  node.autocomplete = 'off';
  node.spellcheck = false;
  return node;
}

function labelledField(labelText: string, control: HTMLElement): HTMLLabelElement {
  const label = document.createElement('label');
  label.className = 'field';
  label.append(el('span', 'field-label', labelText), control);
  return label;
}
