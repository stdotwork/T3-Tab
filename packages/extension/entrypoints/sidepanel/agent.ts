import type { AgentConversation, AgentsStatus, AgentVia, T3Access, T3Catalog } from '@t3-tab/protocol';

import type { AgentPanelState, AgentStartRequest, PanelRequest, PanelTab } from '../../src/panel';

type Send = (request: PanelRequest) => Promise<unknown>;

const VIA_NAMES: Record<AgentVia, string> = { t3: 'T3 Code', claude: 'Claude Code', codex: 'Codex' };
const STATUS_NAMES: Record<AgentConversation['status'], string> = {
  running: 'Working…',
  waiting: 'Waiting for an answer in T3 Code',
  idle: 'Done',
  failed: 'Failed',
};
const FIELDS_KEY = 't3tab.agentFields';
/** List choices that are not a project or model: type the value instead, or use the project's default model. */
const TYPED = 'typed';
const DEFAULT = 'default';

/**
 * The agent half of the side panel: start a T3 thread or a direct Claude Code or Codex run with the current tab,
 * then follow and continue it. The form is built once, so a refresh never takes the owner's typing or focus.
 */
export function initAgentPanel(root: HTMLElement, send: Send): { render(state: AgentPanelState): void; refresh(force?: boolean): Promise<void> } {
  root.replaceChildren();
  const status = element('p', 'muted', 'Checking for T3 Code…');
  status.id = 'agent-status';
  const form = document.createElement('form');
  form.className = 'stack';
  const via = document.createElement('select');
  via.id = 'agent-via';
  for (const value of ['t3', 'claude', 'codex'] as const) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = value === 't3' ? 'T3 Code thread' : `${VIA_NAMES[value]} (direct)`;
    via.append(option);
  }
  const project = input('agent-project');
  const provider = input('agent-provider', 'Optional, such as claudeAgent');
  const model = input('agent-model', "Optional: the project's default");
  // T3's own lists, once T3-Tab is signed in to T3 (read only); the text fields stay for typing a value.
  const projectList = document.createElement('select');
  projectList.id = 'agent-project-list';
  const modelList = document.createElement('select');
  modelList.id = 'agent-model-list';
  const access = document.createElement('div');
  access.id = 't3-access';
  access.className = 'stack';
  const accessLine = element('p', 'muted', '');
  accessLine.id = 't3-access-line';
  const signIn = element('button', '', 'Sign in to T3 Code') as HTMLButtonElement;
  signIn.id = 't3-sign-in';
  signIn.type = 'button';
  const reload = element('button', '', 'Reload lists') as HTMLButtonElement;
  reload.id = 't3-reload';
  reload.type = 'button';
  const signOut = element('button', '', 'Sign out of T3') as HTMLButtonElement;
  signOut.id = 't3-sign-out';
  signOut.type = 'button';
  const accessButtons = document.createElement('div');
  accessButtons.className = 'buttons';
  accessButtons.append(signIn, reload, signOut);
  const accessError = element('p', 'error', '');
  access.append(accessLine, accessButtons, accessError);
  const projectListLabel = labelled('Project', projectList);
  const modelListLabel = labelled('Provider and model', modelList);
  const message = document.createElement('textarea');
  message.id = 'agent-message';
  message.rows = 3;
  message.placeholder = 'What should the agent do with this tab?';
  const projectLabel = labelled('Project', project);
  const providerLabel = labelled('Provider instance', provider);
  const modelLabel = labelled('Model', model);
  const share = element('p', 'muted line', '');
  share.id = 'agent-share';
  const start = element('button', '', 'Start') as HTMLButtonElement;
  start.type = 'submit';
  const error = element('p', 'error', '');
  error.id = 'agent-error';
  form.append(
    labelled('Run with', via),
    access,
    projectListLabel,
    projectLabel,
    modelListLabel,
    providerLabel,
    modelLabel,
    labelled('Message', message),
    share,
    start,
    error,
  );

  const list = document.createElement('ul');
  list.id = 'agent-conversations';
  const thread = document.createElement('div');
  thread.id = 'agent-thread';
  const messages = document.createElement('ol');
  messages.className = 'messages';
  const threadHeading = element('h2', '', '');
  const threadStatus = element('p', 'muted', '');
  const grants = document.createElement('ul');
  grants.id = 'agent-grants';
  const nextTurn = element('p', 'muted', '');
  nextTurn.id = 'agent-next-turn';
  const reply = document.createElement('textarea');
  reply.id = 'agent-reply';
  reply.rows = 2;
  reply.placeholder = 'Reply';
  const replyForm = document.createElement('form');
  replyForm.className = 'stack';
  const replyButton = element('button', '', 'Send') as HTMLButtonElement;
  replyButton.type = 'submit';
  const replyError = element('p', 'error', '');
  replyForm.append(reply, replyButton, replyError);
  thread.append(threadHeading, threadStatus, messages, grants, nextTurn, replyForm);
  thread.hidden = true;
  root.append(element('h1', '', 'Agent'), status, form, list, thread);

  let state: AgentPanelState | undefined;
  let selected: string | undefined;
  let chosenVia = false;
  let shownMessages = '';
  let catalog: T3Catalog | undefined;
  let shownGrants = '';
  const saved = restoreFields();

  const showFields = (): void => {
    const direct = via.value !== 't3';
    const lists = !direct && catalog !== undefined;
    const typedProject = !lists || projectList.value === TYPED;
    const typedModel = !lists || modelList.value === TYPED;
    access.hidden = direct;
    projectListLabel.hidden = !lists;
    modelListLabel.hidden = !lists;
    projectLabel.hidden = !typedProject;
    projectLabel.querySelector('span')!.textContent = direct ? 'Folder (optional)' : lists ? 'Project id or folder' : 'Project';
    project.placeholder = direct ? 'Absolute path; default: your home folder' : 'Project id, or a folder inside the project';
    providerLabel.hidden = direct || !typedModel;
    modelLabel.hidden = !direct && !typedModel;
    model.placeholder = direct ? "Optional: the CLI's default" : "Optional: the project's default";
    defaultOption(modelList, catalog, projectList.value);
    if (state !== undefined) status.textContent = statusLine(state.status, via.value as AgentVia);
  };
  via.addEventListener('change', () => {
    chosenVia = true;
    showFields();
  });
  projectList.addEventListener('change', showFields);
  modelList.addEventListener('change', showFields);

  const accessAction = (button: HTMLButtonElement, request: PanelRequest, force: boolean): void => {
    button.addEventListener('click', () => {
      void (async () => {
        accessError.textContent = '';
        button.disabled = true;
        try {
          await send(request);
          await refresh(force);
        } catch (failure) {
          accessError.textContent = failure instanceof Error ? failure.message : String(failure);
        } finally {
          button.disabled = false;
        }
      })();
    });
  };
  accessAction(signIn, { type: 'panel.t3SignIn' }, false);
  accessAction(signOut, { type: 'panel.t3SignOut' }, false);
  accessAction(reload, { type: 'panel.agents', refresh: true }, true);

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void (async () => {
      error.textContent = '';
      start.disabled = true;
      try {
        const request: AgentStartRequest = { type: 'panel.agentStart', via: via.value as AgentVia, message: message.value };
        const lists = via.value === 't3' && catalog !== undefined;
        const picked = lists ? choice(projectList.value, modelList.value) : {};
        if (lists && projectList.value !== TYPED) {
          if (picked.project !== undefined) request.project = picked.project;
        } else if (project.value.trim() !== '') request.project = project.value.trim();
        if (lists && modelList.value !== TYPED) {
          if (picked.provider !== undefined && picked.model !== undefined) {
            request.provider = picked.provider;
            request.model = picked.model;
          }
        } else {
          if (provider.value.trim() !== '' && via.value === 't3') request.provider = provider.value.trim();
          if (model.value.trim() !== '') request.model = model.value.trim();
        }
        const result = (await send(request)) as { conversation: AgentConversation };
        saveFields();
        message.value = '';
        selected = result.conversation.id;
        await refresh();
      } catch (failure) {
        error.textContent = failure instanceof Error ? failure.message : String(failure);
      } finally {
        start.disabled = false;
      }
    })();
  });

  replyForm.addEventListener('submit', (event) => {
    event.preventDefault();
    if (selected === undefined) return;
    const id = selected;
    void (async () => {
      replyError.textContent = '';
      replyButton.disabled = true;
      try {
        await send({ type: 'panel.agentSend', id, message: reply.value });
        reply.value = '';
        await refresh();
      } catch (failure) {
        replyError.textContent = failure instanceof Error ? failure.message : String(failure);
      } finally {
        replyButton.disabled = false;
      }
    })();
  });

  function render(next: AgentPanelState): void {
    state = next;
    accessLine.textContent = accessText(next.t3Access);
    signIn.hidden = next.t3Access.state === 'signed-in';
    signIn.textContent = next.t3Access.state === 'signing-in' ? 'Start the sign-in again' : 'Sign in to T3 Code';
    reload.hidden = next.t3Access.state !== 'signed-in';
    signOut.hidden = next.t3Access.state !== 'signed-in';
    const nextCatalog = next.t3Access.catalog;
    // Rebuilt only when T3's lists change, so a refresh never closes an open list or drops the owner's pick.
    if (nextCatalog?.fetchedAt !== catalog?.fetchedAt) {
      const projectPick = projectList.options.length > 0 ? projectList.value : saved.projectChoice;
      const modelPick = modelList.options.length > 0 ? modelList.value : saved.modelChoice;
      catalog = nextCatalog;
      if (catalog !== undefined) fillLists(projectList, modelList, catalog, projectPick, modelPick);
      else {
        projectList.replaceChildren();
        modelList.replaceChildren();
      }
    }
    if (!chosenVia) via.value = defaultVia(next.status);
    showFields();
    status.textContent = statusLine(next.status, via.value as AgentVia);
    share.textContent = shareLine(next.shareTabs);
    start.disabled = next.shareTabs.length === 0;

    list.replaceChildren(
      ...next.conversations.map((conversation) => {
        const item = document.createElement('li');
        const open = element('button', 'link', conversation.title) as HTMLButtonElement;
        open.type = 'button';
        open.setAttribute('aria-pressed', String(conversation.id === selected));
        open.addEventListener('click', () => {
          selected = conversation.id;
          if (state !== undefined) render(state);
        });
        item.append(open, element('div', 'muted', `${VIA_NAMES[conversation.via]} · ${STATUS_NAMES[conversation.status]}`));
        return item;
      }),
    );

    const conversation = next.conversations.find((candidate) => candidate.id === selected);
    thread.hidden = conversation === undefined;
    if (conversation === undefined) return;
    threadHeading.textContent = conversation.title;
    threadStatus.textContent = [
      VIA_NAMES[conversation.via],
      conversation.model === undefined ? undefined : `${conversation.provider === undefined ? '' : `${conversation.provider}/`}${conversation.model}`,
      conversation.threadId === undefined ? undefined : `id ${conversation.threadId}`,
      STATUS_NAMES[conversation.status],
    ]
      .filter((part) => part !== undefined)
      .join(' · ');
    const key = JSON.stringify([conversation.id, conversation.messages]);
    if (key !== shownMessages) {
      shownMessages = key;
      messages.replaceChildren(
        ...conversation.messages.map((entry) => {
          const item = document.createElement('li');
          item.className = `message ${entry.role}`;
          item.append(element('div', 'role', entry.role === 'user' ? 'You' : entry.role === 'error' ? 'Error' : 'Agent'), element('div', 'text', entry.text));
          return item;
        }),
      );
    }
    const held = next.conversationTabs[conversation.id] ?? [];
    nextTurn.textContent = nextTurnLine(conversation.via, held);
    const grantsKey = JSON.stringify([conversation.id, held]);
    if (grantsKey !== shownGrants) {
      shownGrants = grantsKey;
      grants.replaceChildren(...held.map((tab) => grantRow(conversation.id, tab)));
    }
    replyButton.disabled = conversation.via !== 't3' && conversation.status === 'running';
  }

  function grantRow(id: string, tab: PanelTab): HTMLElement {
    const item = document.createElement('li');
    item.className = 'row';
    const remove = element('button', '', 'Remove') as HTMLButtonElement;
    remove.type = 'button';
    remove.setAttribute('aria-label', `Remove tab ${tab.id} from this conversation`);
    remove.addEventListener('click', () => {
      void (async () => {
        replyError.textContent = '';
        remove.disabled = true;
        try {
          await send({ type: 'panel.agentRemoveTab', id, tabId: tab.id });
          await refresh();
        } catch (failure) {
          replyError.textContent = failure instanceof Error ? failure.message : String(failure);
          remove.disabled = false;
        }
      })();
    });
    item.append(element('div', 'muted', `${tabName(tab)} ${tab.url}`), remove);
    return item;
  }

  async function refresh(force = false): Promise<void> {
    try {
      const next = (await send(force ? { type: 'panel.agents', refresh: true } : { type: 'panel.agents' })) as AgentPanelState;
      render(next);
    } catch (failure) {
      status.textContent = failure instanceof Error ? failure.message : String(failure);
    }
  }

  function saveFields(): void {
    try {
      const fields: SavedFields = { project: project.value, provider: provider.value, model: model.value };
      if (projectList.options.length > 0) fields.projectChoice = projectList.value;
      if (modelList.options.length > 0) fields.modelChoice = modelList.value;
      localStorage.setItem(FIELDS_KEY, JSON.stringify(fields));
    } catch {
      // Storage may be unavailable; the fields just start empty next time.
    }
  }

  function restoreFields(): SavedFields {
    try {
      const stored: unknown = JSON.parse(localStorage.getItem(FIELDS_KEY) ?? '{}');
      if (typeof stored !== 'object' || stored === null) return {};
      const fields = stored as Record<string, unknown>;
      if (typeof fields.project === 'string') project.value = fields.project;
      if (typeof fields.provider === 'string') provider.value = fields.provider;
      if (typeof fields.model === 'string') model.value = fields.model;
      const restored: SavedFields = {};
      if (typeof fields.projectChoice === 'string') restored.projectChoice = fields.projectChoice;
      if (typeof fields.modelChoice === 'string') restored.modelChoice = fields.modelChoice;
      return restored;
    } catch {
      // Nothing saved, or storage is unavailable.
      return {};
    }
  }

  return { render, refresh };
}

interface SavedFields {
  project?: string;
  provider?: string;
  model?: string;
  projectChoice?: string;
  modelChoice?: string;
}

/** What the lists' values mean: a project id, a provider instance and model, or the project's default (neither). */
export function choice(projectValue: string, modelValue: string): { project?: string; provider?: string; model?: string } {
  const picked: { project?: string; provider?: string; model?: string } = {};
  if (projectValue.startsWith('p:')) picked.project = projectValue.slice(2);
  if (modelValue.startsWith('m:')) {
    try {
      const [provider, model] = JSON.parse(modelValue.slice(2)) as unknown[];
      if (typeof provider === 'string' && typeof model === 'string') {
        picked.provider = provider;
        picked.model = model;
      }
    } catch {
      // Not a model choice.
    }
  }
  return picked;
}

/** Fills the project and model lists from T3's catalog, keeping the earlier pick when it is still listed. */
export function fillLists(projectList: HTMLSelectElement, modelList: HTMLSelectElement, catalog: T3Catalog, projectPick?: string, modelPick?: string): void {
  projectList.replaceChildren(
    ...catalog.projects.map((project) => option(`p:${project.id}`, `${project.title} — ${project.workspaceRoot}`)),
    option(TYPED, 'Type a project id or folder…'),
  );
  const groups = catalog.providers.map((provider) => {
    const group = document.createElement('optgroup');
    group.label = provider.unavailable === undefined ? provider.name : `${provider.name} (unavailable: ${provider.unavailable})`;
    group.disabled = provider.unavailable !== undefined;
    group.append(...provider.models.map((model) => option(`m:${JSON.stringify([provider.instanceId, model.id])}`, model.label ?? model.id)));
    return group;
  });
  modelList.replaceChildren(option(DEFAULT, "The project's default"), ...groups, option(TYPED, 'Type a provider and model…'));
  pick(projectList, projectPick);
  pick(modelList, modelPick);
}

/** Names the project's default model on the "default" choice, when T3 reported one. */
function defaultOption(modelList: HTMLSelectElement, catalog: T3Catalog | undefined, projectValue: string): void {
  const first = modelList.options[0];
  if (first?.value !== DEFAULT) return;
  const project = catalog?.projects.find((candidate) => `p:${candidate.id}` === projectValue);
  first.textContent =
    project?.defaultModel === undefined ? "The project's default" : `The project's default (${project.defaultProvider ?? ''}/${project.defaultModel})`;
}

/** One line on T3-Tab's T3 sign-in and what it gives the panel. */
export function accessText(access: T3Access): string {
  const detail = access.detail === undefined ? '' : `${access.detail} `;
  if (access.state === 'signing-in') return `${detail}Approve T3-Tab in the T3 Code tab that opened, and choose Read only.`;
  if (access.state === 'signed-out') {
    return `${detail}Sign in to T3 Code once to pick projects and models from its lists. T3-Tab asks for read-only access.`;
  }
  const until = access.expiresAt === undefined ? '' : ` until ${new Date(access.expiresAt).toISOString().slice(0, 10)}`;
  const counts =
    access.catalog === undefined
      ? ''
      : ` ${access.catalog.projects.length} projects, ${access.catalog.providers.reduce((total, provider) => total + provider.models.length, 0)} models listed.`;
  return `Signed in to T3 Code${access.environment === undefined ? '' : ` at ${access.environment}`} (read only)${until}.${counts}${access.detail === undefined ? '' : ` ${access.detail}`}`;
}

function option(value: string, text: string): HTMLOptionElement {
  const node = document.createElement('option');
  node.value = value;
  node.textContent = text;
  return node;
}

function pick(list: HTMLSelectElement, value: string | undefined): void {
  if (value !== undefined && [...list.options].some((candidate) => candidate.value === value && !candidate.disabled)) list.value = value;
}

export function defaultVia(status: AgentsStatus): AgentVia {
  if (status.t3.state === 'running') return 't3';
  if (status.claude !== undefined) return 'claude';
  if (status.codex !== undefined) return 'codex';
  return 't3';
}

/** The T3 Code state, which decides whether a thread can start, plus a note when the chosen direct CLI is missing. */
export function statusLine(status: AgentsStatus, via: AgentVia): string {
  const t3 = t3Line(status);
  return via !== 't3' && status[via] === undefined ? `${t3} ${VIA_NAMES[via]} was not found on this machine.` : t3;
}

function t3Line(status: AgentsStatus): string {
  const direct = [status.claude === undefined ? undefined : 'Claude Code', status.codex === undefined ? undefined : 'Codex'].filter(
    (name) => name !== undefined,
  );
  const fallback = direct.length === 0 ? '' : ` You can run ${direct.join(' or ')} directly instead.`;
  if (status.t3.state === 'running') return 'T3 Code is running.';
  if (status.t3.state === 'missing') return `T3 Code was not found.${fallback}`;
  if (status.t3.state === 'stopped') return `T3 Code is not running.${fallback}`;
  return `T3 Code did not answer: ${status.t3.detail ?? 'unknown error'}.${fallback}`;
}

function tabName(tab: Pick<PanelTab, 'id' | 'title'>): string {
  return `tab ${tab.id} "${tab.title || '(untitled)'}"`;
}

/** What the owner's next message hands over. A direct turn is a new session; a T3 thread's session keeps its tabs. */
export function nextTurnLine(via: AgentVia, tabs: PanelTab[]): string {
  const names = tabs.map(tabName).join(', ');
  if (via === 't3') return tabs.length === 0 ? 'This thread has no tabs from you.' : `This thread can use ${names}.`;
  if (tabs.length === 0) return 'Your next message shares no tabs.';
  return tabs.length === 1 ? `Your next message shares ${names}.` : `Your next message shares ${tabs.length} tabs: ${names}.`;
}

export function shareLine(tabs: PanelTab[]): string {
  if (tabs.length === 0) return 'No current tab to share.';
  const first = tabs[0];
  const name = first === undefined ? '' : `tab ${first.id} "${first.title || '(untitled)'}"`;
  return tabs.length === 1 ? `Shares ${name}` : `Shares ${tabs.length} tabs of this tab group, starting with ${name}`;
}

function element(tag: string, className: string, text: string): HTMLElement {
  const node = document.createElement(tag);
  if (className !== '') node.className = className;
  node.textContent = text;
  return node;
}

function input(id: string, placeholder = ''): HTMLInputElement {
  const node = document.createElement('input');
  node.id = id;
  node.placeholder = placeholder;
  node.autocomplete = 'off';
  node.spellcheck = false;
  return node;
}

function labelled(text: string, control: HTMLElement): HTMLLabelElement {
  const label = document.createElement('label');
  label.append(element('span', '', text), control);
  return label;
}
