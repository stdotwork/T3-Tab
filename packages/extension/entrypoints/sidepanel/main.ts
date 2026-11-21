import type { PanelRequest, PanelState } from '../../src/panel';
import type { PermissionDecision, PermissionPrompt } from '../../src/permissions';

interface PromptNode {
  item: HTMLLIElement;
  description: HTMLElement;
}

const BUTTON_DELAY_MS = 500;
const app = document.querySelector<HTMLElement>('#app');
const tabIdParam = new URL(location.href).searchParams.get('tabId');
const fixedTabId = tabIdParam === null ? undefined : Number(tabIdParam);
const stateRequest: PanelRequest =
  fixedTabId !== undefined && Number.isInteger(fixedTabId)
    ? { type: 'panel.state', tabId: fixedTabId }
    : { type: 'panel.state' };
const headless = new URL(location.href).searchParams.get('headless') === '1';
const promptNodes = new Map<string, PromptNode>();

async function refresh(): Promise<void> {
  if (app === null) return;
  try {
    const state = await send(stateRequest);
    if (!('sessions' in state)) throw new Error('Unexpected panel state');
    render(state);
  } catch (error) {
    app.replaceChildren(
      heading('Permissions'),
      text('p', error instanceof Error ? error.message : String(error), 'muted'),
    );
  }
}

async function send(request: PanelRequest): Promise<PanelState | { ok: true }> {
  const result: unknown = await chrome.runtime.sendMessage(request);
  if (typeof result === 'object' && result !== null && (result as { ok?: unknown }).ok === false) {
    throw new Error(String((result as { error?: unknown }).error ?? 'The request failed'));
  }
  return result as PanelState | { ok: true };
}

function render(state: PanelState): void {
  if (app === null) return;
  const children: Node[] = [heading('Permissions')];
  const current = state.currentTab;
  children.push(
    heading('Current tab', 2),
    text('p', current === undefined ? 'No current tab' : `${current.title || '(untitled)'}\n${current.url}`, 'muted'),
  );

  children.push(heading('Waiting for you', 2));
  if (state.pending.length === 0) children.push(text('p', 'No permission requests.', 'muted'));
  else children.push(promptList(state.pending));

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
        buttons([
          [
            site.setting === 'allow' ? 'Ask before acting' : 'Always allow',
            () => setSite(site.origin, site.setting === 'allow' ? 'ask' : 'allow'),
          ],
        ]),
      );
      list.append(item);
    }
    children.push(list);
  }
  app.replaceChildren(...children);
}

function promptList(pending: PermissionPrompt[]): HTMLElement {
  const list = document.createElement('ul');
  const ids = new Set(pending.map((prompt) => prompt.id));
  for (const [id, node] of promptNodes) {
    if (ids.has(id)) continue;
    node.item.remove();
    promptNodes.delete(id);
  }
  for (const prompt of pending) {
    let node = promptNodes.get(prompt.id);
    if (node === undefined) {
      const item = document.createElement('li');
      const description = text('div', '', 'prompt-text');
      const controls = buttons([
        ['Allow once', () => decide(prompt.id, 'allow-once'), null, true],
        ['Always allow on this site', () => decide(prompt.id, 'always-allow'), null, true],
        ['Decline', () => decide(prompt.id, 'decline'), 'danger', true],
      ]);
      item.append(description, controls);
      node = { item, description };
      promptNodes.set(prompt.id, node);
      const enable = (): void => {
        for (const button of controls.querySelectorAll('button')) button.disabled = false;
      };
      setTimeout(enable, BUTTON_DELAY_MS);
    }
    node.description.textContent = promptDescription(prompt);
    list.append(node.item);
  }
  return list;
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

async function setSite(origin: string, setting: 'ask' | 'allow'): Promise<void> {
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

function buttons(items: Array<[string, () => Promise<void>, (string | null)?, boolean?]>): HTMLElement {
  const row = document.createElement('div');
  row.className = 'buttons';
  for (const [label, action, className, disabled] of items) {
    const button = document.createElement('button');
    button.textContent = label;
    if (className !== undefined && className !== null) button.className = className;
    if (disabled === true) button.disabled = true;
    button.addEventListener('click', () => void action());
    row.append(button);
  }
  return row;
}

if (headless) {
  (globalThis as typeof globalThis & { __t3tabRenderPanelState?: typeof render }).__t3tabRenderPanelState = render;
} else {
  void refresh();
  setInterval(() => void refresh(), 1_000);
}
