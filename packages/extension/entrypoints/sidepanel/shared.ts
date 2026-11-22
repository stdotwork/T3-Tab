/*
 * Shared formatting, state and DOM helpers for the T3-Tab side panel.
 *
 * References:
 * - Nanobrowser src/side-panel/Cards.tsx (Apache-2.0, pattern only): plainText strips control
 *   and bidi-override characters before showing page or session strings inside cards.
 */
import { PROTOCOL_MISMATCH, type AgentConversation, type AgentsStatus, type AgentVia, type T3Access, type T3Catalog } from '@t3-tab/protocol';

import type { PanelRequest, PanelTab } from '../../src/panel';
import type { PermissionPrompt, PromptKind } from '../../src/permissions';

export type SendRequest = (request: PanelRequest) => Promise<unknown>;

export interface PanelActions {
  send: SendRequest;
  refreshPanel: () => Promise<void>;
  refreshAgents: (force?: boolean) => Promise<void>;
  announce: (message: string) => void;
  openConversation: (id: string, returnFocusTo?: HTMLElement) => void;
  openNewConversation: (returnFocusTo?: HTMLElement) => void;
  openSettings: (returnFocusTo?: HTMLElement) => void;
  goBack: () => void;
}

export const VIA_NAMES: Record<AgentVia, string> = {
  t3: 'T3 Code',
  claude: 'Claude Code',
  codex: 'Codex',
};

export const STATUS_NAMES: Record<AgentConversation['status'], string> = {
  running: 'Working…',
  waiting: 'Waiting in T3',
  idle: 'Done',
  failed: 'Failed',
};

export const TYPED_CHOICE = 'typed';
export const DEFAULT_CHOICE = 'default';

export type BadgeTone = 'neutral' | 'accent' | 'warning' | 'success' | 'danger';

/** Strips ASCII control characters and bidi/zero-width overrides from untrusted page or session strings. */
export function plainText(value: string): string {
  let out = '';
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    const invisible =
      code <= 0x1f ||
      (code >= 0x7f && code <= 0x9f) ||
      (code >= 0x200b && code <= 0x200f) ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069);
    out += invisible ? ' ' : value[i];
  }
  return out.replace(/\s+/g, ' ').trim();
}

export function isProtocolMismatch(errorText: string | undefined): boolean {
  return errorText !== undefined && (errorText.includes(PROTOCOL_MISMATCH) || errorText.includes('different versions'));
}

/** Compact header status badge text and tone summarizing the daemon / T3 state. */
export function headerStatus(status: AgentsStatus | undefined, errorText: string | undefined): { label: string; tone: BadgeTone } {
  if (isProtocolMismatch(errorText)) return { label: 'Update needed', tone: 'danger' };
  if (errorText !== undefined) return { label: 'Disconnected', tone: 'danger' };
  if (status === undefined) return { label: 'Checking…', tone: 'neutral' };
  if (status.t3.state === 'running') return { label: 'T3 ready', tone: 'success' };
  if (status.t3.state === 'stopped') return { label: 'T3 stopped', tone: 'warning' };
  if (status.t3.state === 'missing') {
    return status.claude !== undefined || status.codex !== undefined
      ? { label: 'Direct mode', tone: 'neutral' }
      : { label: 'T3 not found', tone: 'warning' };
  }
  return { label: 'T3 error', tone: 'danger' };
}

/** Eyebrow label for a permission prompt card. */
export function promptEyebrow(tool: PromptKind): string {
  if (tool === 'read') return 'Read request';
  if (tool === 'open') return 'Open tab request';
  if (tool === 'run_js') return 'JavaScript request';
  return 'Action request';
}

/** Main sentence for a permission prompt card: who wants to do what, and where. */
export function promptSentence(prompt: PermissionPrompt): string {
  const action = prompt.tool === 'open' ? 'open a tab' : prompt.tool === 'read' ? 'read this tab' : `use ${prompt.tool}`;
  return `${plainText(prompt.session.name)} wants to ${action} at ${plainText(prompt.origin)}.`;
}

/** Muted metadata line for a permission prompt card: names the tab id and title as required by AGENTS.md. */
export function promptMeta(prompt: PermissionPrompt): string {
  const title = plainText(prompt.tab.title || '(untitled)');
  return `tab ${prompt.tab.id} "${title}"`;
}

export function defaultVia(status: AgentsStatus): AgentVia {
  if (status.t3.state === 'running') return 't3';
  if (status.claude !== undefined) return 'claude';
  if (status.codex !== undefined) return 'codex';
  return 't3';
}

/** The T3 Code state, plus a note when the chosen direct CLI is missing. */
export function statusLine(status: AgentsStatus, via: AgentVia): string {
  const t3 = t3Line(status);
  return via !== 't3' && status[via] === undefined ? `${t3} ${VIA_NAMES[via]} was not found on this machine.` : t3;
}

function t3Line(status: AgentsStatus): string {
  const direct = [status.claude === undefined ? undefined : 'Claude Code', status.codex === undefined ? undefined : 'Codex'].filter(
    (name): name is string => name !== undefined,
  );
  const fallback = direct.length === 0 ? '' : ` You can run ${direct.join(' or ')} directly instead.`;
  if (status.t3.state === 'running') return 'T3 Code is running.';
  if (status.t3.state === 'missing') return `T3 Code was not found.${fallback}`;
  if (status.t3.state === 'stopped') return `T3 Code is not running.${fallback}`;
  return `T3 Code did not answer: ${status.t3.detail ?? 'unknown error'}.${fallback}`;
}

/** One line on T3-Tab's read-only T3 sign-in and what it gives the panel. */
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
export function fillLists(
  projectList: HTMLSelectElement,
  modelList: HTMLSelectElement,
  catalog: T3Catalog,
  projectPick?: string,
  modelPick?: string,
): void {
  projectList.replaceChildren(
    ...catalog.projects.map((project) => option(`p:${project.id}`, `${project.title} — ${project.workspaceRoot}`)),
    option(TYPED_CHOICE, 'Type a project id or folder…'),
  );
  const groups = catalog.providers.map((provider) => {
    const group = document.createElement('optgroup');
    group.label = provider.unavailable === undefined ? provider.name : `${provider.name} (unavailable: ${provider.unavailable})`;
    group.disabled = provider.unavailable !== undefined;
    group.append(...provider.models.map((model) => option(`m:${JSON.stringify([provider.instanceId, model.id])}`, model.label ?? model.id)));
    return group;
  });
  modelList.replaceChildren(option(DEFAULT_CHOICE, "The project's default"), ...groups, option(TYPED_CHOICE, 'Type a provider and model…'));
  pick(projectList, projectPick);
  pick(modelList, modelPick);
}

/** Names the project's default model on the "default" choice, when T3 reported one. */
export function updateDefaultModelOption(modelList: HTMLSelectElement, catalog: T3Catalog | undefined, projectValue: string): void {
  const first = modelList.options[0];
  if (first?.value !== DEFAULT_CHOICE) return;
  const project = catalog?.projects.find((candidate) => `p:${candidate.id}` === projectValue);
  first.textContent =
    project?.defaultModel === undefined ? "The project's default" : `The project's default (${project.defaultProvider ?? ''}/${project.defaultModel})`;
}

function tabTitle(tab: Pick<PanelTab, 'title'>): string {
  const clean = plainText(tab.title);
  return `"${clean || '(untitled)'}"`;
}

/** What the owner's next message hands over. A direct turn is a new session; a T3 thread's session keeps its tabs. */
export function nextTurnLine(via: AgentVia, tabs: PanelTab[]): string {
  const names = tabs.map(tabTitle).join(', ');
  if (via === 't3') return tabs.length === 0 ? 'This thread has no tabs from you.' : `This thread can use ${names}.`;
  if (tabs.length === 0) return 'Your next message shares no tabs.';
  return tabs.length === 1 ? `Your next message shares ${names}.` : `Your next message shares ${tabs.length} tabs: ${names}.`;
}

/** What starting a new conversation will share. */
export function shareLine(tabs: PanelTab[]): string {
  if (tabs.length === 0) return 'No current tab to share.';
  const first = tabs[0];
  const name = first === undefined ? '' : tabTitle(first);
  return tabs.length === 1 ? `Shares ${name}` : `Shares ${tabs.length} tabs of this tab group, starting with ${name}`;
}

/** Conversations ordered most recent first, preserving relative order on ties. */
export function sortConversations(conversations: readonly AgentConversation[]): AgentConversation[] {
  return [...conversations].sort((left, right) => right.updatedAt - left.updatedAt);
}

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== '') node.className = className;
  if (text !== '') node.textContent = text;
  return node;
}

function option(value: string, text: string): HTMLOptionElement {
  const node = document.createElement('option');
  node.value = value;
  node.textContent = text;
  return node;
}

function pick(list: HTMLSelectElement, value: string | undefined): void {
  if (value !== undefined && [...list.options].some((candidate) => candidate.value === value && !candidate.disabled)) {
    list.value = value;
  }
}
