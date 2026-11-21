import type { PanelRequest, PanelState } from '../../src/panel';
import { initAgentPanel } from './agent';
import { promptChoices, rowsShifted, siteChoices, siteStatus } from '../../src/panel-prompts';
import type { PermissionDecision, PermissionPrompt, SitePermission } from '../../src/permissions';

interface PromptNode {
  item: HTMLLIElement;
  description: HTMLElement;
  controls: HTMLElement;
  timer: ReturnType<typeof setTimeout> | undefined;
}

const BUTTON_DELAY_MS = 500;
const app = document.querySelector<HTMLElement>('#app');
const agentRoot = document.querySelector<HTMLElement>('#agent');
const tabIdParam = new URL(location.href).searchParams.get('tabId');
const fixedTabId = tabIdParam === null ? undefined : Number(tabIdParam);
const stateRequest: PanelRequest =
  fixedTabId !== undefined && Number.isInteger(fixedTabId)
    ? { type: 'panel.state', tabId: fixedTabId }
    : { type: 'panel.state' };
const headless = new URL(location.href).searchParams.get('headless') === '1';
const promptNodes = new Map<string, PromptNode>();
/** The prompt ids in the order the list last showed them. */
let shownOrder: string[] = [];

async function refresh(): Promise<void> {
  if (app === null) return;
  try {
    const state = (await send(stateRequest)) as PanelState | { ok: true };
    if (!('sessions' in state)) throw new Error('Unexpected panel state');
    render(state);
  } catch (error) {
    app.replaceChildren(
      heading('Permissions'),
      text('p', error instanceof Error ? error.message : String(error), 'muted'),
    );
  }
}

async function send(request: PanelRequest): Promise<unknown> {
  const result: unknown = await chrome.runtime.sendMessage(request);
  if (typeof result === 'object' && result !== null && (result as { ok?: unknown }).ok === false) {
    throw new Error(String((result as { error?: unknown }).error ?? 'The request failed'));
  }
  return result;
}

function render(state: PanelState): void {
  if (app === null) return;
  const children: Node[] = [heading('Permissions')];
  const current = state.currentTab;
  children.push(
    heading('Current tab', 2),
    // One line each, whatever the page's title: a block that changed height would move the prompt rows below.
    text('p', current === undefined ? 'No current tab' : current.title || '(untitled)', 'muted line'),
    text('p', current?.url ?? '', 'muted line'),
  );

  children.push(heading('Waiting for you', 2));
  const prompts = promptList(state.pending);
  children.push(state.pending.length === 0 ? text('p', 'No permission requests.', 'muted') : prompts);

  children.push(heading('Connected sessions', 2));
  if (state.sessions.length === 0) children.push(text('p', 'No MCP clients are connected.', 'muted'));
  else {
    const list = document.createElement('ul');
    for (const session of state.sessions) {
      const shared = current !== undefined && session.sharedTabIds.includes(current.id);
      const item = document.createElement('li');
      item.append(
        text('div', session.name),
        text('div', session.groupId === undefined ? 'No tab group yet' : `Tab group ${session.groupId}`, 'muted'),
      );
      if (current !== undefined) {
        item.append(buttons([[shared ? 'Unshare current tab' : 'Share current tab', () => toggleShare(session.id, shared)]]));
      }
      list.append(item);
    }
    children.push(list);
  }

  children.push(heading('Site permissions', 2));
  if (state.sites.length === 0) children.push(text('p', 'No sites yet. Sites default to ask.', 'muted'));
  else {
    const list = document.createElement('ul');
    for (const site of state.sites) {
      const item = document.createElement('li');
      item.append(
        text('div', site.origin),
        text('div', siteStatus(site.setting), 'muted'),
        buttons(siteChoices(site.setting).map((choice) => [choice.label, () => setSite(site.origin, choice.setting)])),
      );
      list.append(item);
    }
    children.push(list);
  }
  app.replaceChildren(...children);
}

function promptList(pending: PermissionPrompt[]): HTMLElement {
  const list = document.createElement('ul');
  const order = pending.map((prompt) => prompt.id);
  const ids = new Set(order);
  for (const [id, node] of promptNodes) {
    if (ids.has(id)) continue;
    clearTimeout(node.timer);
    node.item.remove();
    promptNodes.delete(id);
  }
  for (const prompt of pending) {
    let node = promptNodes.get(prompt.id);
    if (node === undefined) {
      const item = document.createElement('li');
      const description = text('div', '', 'prompt-text');
      const controls = buttons(
        promptChoices(prompt.tool).map((choice): [string, () => Promise<void>, (string | null)?] => [
          choice.label,
          () => decide(prompt.id, choice.decision),
          choice.danger === true ? 'danger' : null,
        ]),
      );
      item.append(description, controls);
      node = { item, description, controls, timer: undefined };
      promptNodes.set(prompt.id, node);
      lock(node);
    }
    node.description.textContent = promptDescription(prompt);
    list.append(node.item);
  }
  // A row that went away or came in above another moves the buttons under the owner's pointer.
  if (rowsShifted(shownOrder, order)) for (const node of promptNodes.values()) lock(node);
  shownOrder = order;
  return list;
}

/** Disables a prompt's buttons and enables them again once the pointer has had time to settle. */
function lock(node: PromptNode): void {
  clearTimeout(node.timer);
  for (const button of node.controls.querySelectorAll('button')) button.disabled = true;
  node.timer = setTimeout(() => {
    for (const button of node.controls.querySelectorAll('button')) button.disabled = false;
  }, BUTTON_DELAY_MS);
}

function promptDescription(prompt: PermissionPrompt): string {
  const action = prompt.tool === 'open' ? 'open' : prompt.tool === 'read' ? 'read' : `use ${prompt.tool} on`;
  return `${prompt.session.name} wants to ${action} tab ${prompt.tab.id} "${prompt.tab.title}" at ${prompt.origin}.`;
}

async function decide(promptId: string, decision: PermissionDecision): Promise<void> {
  await send({ type: 'panel.decide', promptId, decision });
  await refresh();
}

async function toggleShare(sessionId: string, shared: boolean): Promise<void> {
  // Do not pass a tab id: the owner may have switched tabs since this list was rendered.
  await send({ type: shared ? 'panel.unshareTab' : 'panel.shareTab', sessionId });
  await refresh();
}

async function setSite(origin: string, setting: SitePermission): Promise<void> {
  await send({ type: 'panel.setSite', origin, setting });
  await refresh();
}

function heading(value: string, level = 1): HTMLElement {
  return text(`h${level}`, value);
}

function text(tag: string, value: string, className?: string): HTMLElement {
  const element = document.createElement(tag);
  element.textContent = value;
  if (className !== undefined) element.className = className;
  return element;
}

function buttons(items: Array<[string, () => Promise<void>, (string | null)?]>): HTMLElement {
  const row = document.createElement('div');
  row.className = 'buttons';
  for (const [label, action, className] of items) {
    const button = document.createElement('button');
    button.textContent = label;
    if (className !== undefined && className !== null) button.className = className;
    button.addEventListener('click', () => void action());
    row.append(button);
  }
  return row;
}

const agentPanel = agentRoot === null ? undefined : initAgentPanel(agentRoot, send);

if (headless) {
  const hooks = globalThis as typeof globalThis & {
    __t3tabRenderPanelState?: typeof render;
    __t3tabRenderAgentState?: (state: Parameters<NonNullable<typeof agentPanel>['render']>[0]) => void;
  };
  hooks.__t3tabRenderPanelState = render;
  hooks.__t3tabRenderAgentState = (state) => agentPanel?.render(state);
} else {
  void refresh();
  setInterval(() => void refresh(), 1_000);
  void agentPanel?.refresh(true);
  setInterval(() => void agentPanel?.refresh(), 2_000);
}
