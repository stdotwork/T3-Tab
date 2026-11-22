import type { AgentConversation } from '@t3-tab/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ConversationView } from '../entrypoints/sidepanel/conversation';
import { BUTTON_DELAY_MS, PromptListView } from '../entrypoints/sidepanel/prompts';
import type { PanelActions } from '../entrypoints/sidepanel/shared';
import type { PermissionPrompt } from '../src/permissions';

/** Minimal DOM node fake for testing view update stability and prompt button locks in Node. */
class FakeElement {
  readonly tagName: string;
  className = '';
  id = '';
  title = '';
  type = '';
  disabled = false;
  hidden = false;
  tabIndex = 0;
  placeholder = '';
  rows = 0;
  value = '';
  readonly dataset: Record<string, string> = {};
  readonly attrs = new Map<string, string>();
  readonly children: Array<FakeElement | string> = [];
  readonly classList = {
    add: (...names: string[]) => {
      const current = new Set(this.className.split(/\s+/).filter(Boolean));
      for (const name of names) current.add(name);
      this.className = [...current].join(' ');
    },
  };
  parent: FakeElement | undefined;
  focused = false;
  private _textContent = '';

  constructor(tagName: string) {
    this.tagName = tagName.toUpperCase();
  }

  get textContent(): string {
    if (this.children.length === 0) return this._textContent;
    return this.children.map((child) => (typeof child === 'string' ? child : child.textContent)).join('');
  }

  set textContent(value: string) {
    this._textContent = value;
    this.children.length = 0;
  }

  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null;
  }

  addEventListener(): void {
    // No-op in unit tests.
  }

  focus(): void {
    this.focused = true;
  }

  append(...nodes: Array<FakeElement | string>): void {
    for (const node of nodes) {
      if (node instanceof FakeElement) {
        node.remove();
        node.parent = this;
      }
      this.children.push(node);
    }
  }

  replaceChildren(...nodes: Array<FakeElement | string>): void {
    for (const child of this.children) {
      if (child instanceof FakeElement) child.parent = undefined;
    }
    this.children.length = 0;
    this.append(...nodes);
  }

  remove(): void {
    if (this.parent === undefined) return;
    const index = this.parent.children.indexOf(this);
    if (index !== -1) this.parent.children.splice(index, 1);
    this.parent = undefined;
  }

  querySelectorAll(selector: string): FakeElement[] {
    const wanted = selector.toUpperCase();
    const out: FakeElement[] = [];
    const walk = (node: FakeElement): void => {
      for (const child of node.children) {
        if (!(child instanceof FakeElement)) continue;
        if (child.tagName === wanted) out.push(child);
        walk(child);
      }
    };
    walk(this);
    return out;
  }
}

function installFakeDocument(): void {
  const fakeDocument = {
    createElement: (tag: string) => new FakeElement(tag),
    createElementNS: (_ns: string, tag: string) => new FakeElement(tag),
    createTextNode: (text: string) => text,
  };
  vi.stubGlobal('document', fakeDocument);
}

const noopActions: PanelActions = {
  send: async () => ({ ok: true }),
  refreshPanel: async () => undefined,
  refreshAgents: async () => undefined,
  announce: () => undefined,
  openConversation: () => undefined,
  openNewConversation: () => undefined,
  openSettings: () => undefined,
  goBack: () => undefined,
};

function makePrompt(id: string, tool: PermissionPrompt['tool'], title: string): PermissionPrompt {
  return {
    id,
    origin: 'https://example.test',
    tool,
    session: { id: 'sess-1', name: 'claude-code · 11111111' },
    tab: { id: 10, title },
  };
}

describe('PromptListView', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    installFakeDocument();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('locks buttons for 500 ms on appear, keeps DOM nodes across refreshes, and never steals focus', () => {
    const view = new PromptListView(noopActions);
    const p1 = makePrompt('p1', 'read', 'First tab');
    view.update([p1]);

    const list = view.element as unknown as FakeElement;
    expect(list.children).toHaveLength(1);
    const firstItem = list.children[0] as FakeElement;
    const buttons = firstItem.querySelectorAll('button');
    expect(buttons).toHaveLength(3);
    expect(buttons.every((b) => b.disabled)).toBe(true);
    expect(firstItem.focused).toBe(false);
    expect(buttons.some((b) => b.focused)).toBe(false);

    vi.advanceTimersByTime(BUTTON_DELAY_MS);
    expect(buttons.every((b) => !b.disabled)).toBe(true);

    // Refreshing with the same prompt keeps the exact same DOM node and does not re-lock.
    view.update([p1]);
    expect(list.children[0]).toBe(firstItem);
    expect(buttons.every((b) => !b.disabled)).toBe(true);
    view.dispose();
  });

  it('re-locks remaining rows when a row is removed or inserted above, but not below', () => {
    const view = new PromptListView(noopActions);
    const p0 = makePrompt('p0', 'run_js', 'Zero');
    const p1 = makePrompt('p1', 'read', 'One');
    const p2 = makePrompt('p2', 'act', 'Two');
    const p3 = makePrompt('p3', 'open', 'Three');

    view.update([p1, p2]);
    vi.advanceTimersByTime(BUTTON_DELAY_MS);
    const list = view.element as unknown as FakeElement;
    const rowTwo = list.children[1] as FakeElement;
    expect(rowTwo.querySelectorAll('button').every((b) => !b.disabled)).toBe(true);

    // Removing p1 above p2 shifts p2 up -> must re-lock p2.
    view.update([p2]);
    expect(rowTwo.querySelectorAll('button').every((b) => b.disabled)).toBe(true);
    vi.advanceTimersByTime(BUTTON_DELAY_MS);
    expect(rowTwo.querySelectorAll('button').every((b) => !b.disabled)).toBe(true);

    // Inserting p0 above p2 shifts p2 down -> must re-lock both.
    view.update([p0, p2]);
    expect(rowTwo.querySelectorAll('button').every((b) => b.disabled)).toBe(true);
    vi.advanceTimersByTime(BUTTON_DELAY_MS);
    expect(rowTwo.querySelectorAll('button').every((b) => !b.disabled)).toBe(true);

    // Adding p3 below p2 must NOT lock p2, while p3 itself starts locked.
    view.update([p0, p2, p3]);
    expect(rowTwo.querySelectorAll('button').every((b) => !b.disabled)).toBe(true);
    const rowThree = list.children[2] as FakeElement;
    expect(rowThree.querySelectorAll('button').every((b) => b.disabled)).toBe(true);
    vi.advanceTimersByTime(BUTTON_DELAY_MS);

    // Removing p3 below p2 must NOT lock p2.
    view.update([p0, p2]);
    expect(rowTwo.querySelectorAll('button').every((b) => !b.disabled)).toBe(true);
    view.dispose();
  });
});

describe('ConversationView', () => {
  beforeEach(() => {
    installFakeDocument();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('skips re-rendering the message list when polled with unchanged messages', () => {
    const view = new ConversationView(noopActions);
    const conv: AgentConversation = {
      id: 'c1',
      via: 't3',
      title: 'Check billing',
      status: 'running',
      messages: [{ role: 'user', text: 'Summarise this page' }],
      updatedAt: 1,
    };

    expect(view.update(conv, [])).toBe(true);
    const root = view.element as unknown as FakeElement;
    const ol = root.querySelectorAll('ol')[0]!;
    const firstMsgNode = ol.children[0];

    // Polling with identical messages returns false and keeps the existing DOM node.
    expect(view.update({ ...conv, messages: [{ role: 'user', text: 'Summarise this page' }] }, [])).toBe(false);
    expect(ol.children[0]).toBe(firstMsgNode);

    // Adding a reply returns true and updates the list.
    expect(
      view.update(
        {
          ...conv,
          status: 'idle',
          messages: [
            { role: 'user', text: 'Summarise this page' },
            { role: 'assistant', text: 'Done.' },
          ],
        },
        [],
      ),
    ).toBe(true);
    expect(ol.children).toHaveLength(2);
  });

  it('keeps an unsent reply with its own conversation', () => {
    const view = new ConversationView(noopActions);
    const first: AgentConversation = { id: 'a', via: 'claude', title: 'A', status: 'idle', messages: [], updatedAt: 1 };
    const second: AgentConversation = { id: 'b', via: 'codex', title: 'B', status: 'idle', messages: [], updatedAt: 2 };
    const input = (view.element as unknown as FakeElement).querySelectorAll('textarea')[0]!;

    view.update(first, []);
    input.value = 'draft for A';
    view.update(second, []);
    expect(input.value).toBe('');
    view.update(first, []);
    expect(input.value).toBe('draft for A');
  });
});
