/*
 * Keyed permission prompt list for the T3-Tab side panel.
 *
 * Safeguards preserved from T3-Tab's permission policy:
 * - Button labels and scopes come verbatim from `promptChoices` in `panel-prompts.ts`.
 * - Buttons stay disabled for 500 ms when a prompt appears and whenever rows shift (`rowsShifted`).
 * - Existing prompt items are kept in place across refreshes so DOM nodes never jump.
 * - Prompt cards never steal focus when they appear (Nanobrowser Cards.tsx rule, Apache-2.0).
 */
import { promptChoices, rowsShifted } from '../../src/panel-prompts';
import type { PermissionDecision, PermissionPrompt } from '../../src/permissions';
import { icon } from './icons';
import { el, promptEyebrow, promptMeta, promptSentence, type PanelActions } from './shared';

export const BUTTON_DELAY_MS = 500;

interface PromptNode {
  item: HTMLLIElement;
  eyebrowText: HTMLSpanElement;
  sentence: HTMLParagraphElement;
  meta: HTMLParagraphElement;
  controls: HTMLDivElement;
  error: HTMLParagraphElement;
  locked: boolean;
  submitting: boolean;
  timer: ReturnType<typeof setTimeout> | undefined;
}

export class PromptListView {
  readonly element: HTMLUListElement;
  private readonly nodes = new Map<string, PromptNode>();
  private shownOrder: string[] = [];

  constructor(private readonly actions: Pick<PanelActions, 'send' | 'refreshPanel' | 'announce'>) {
    this.element = document.createElement('ul');
    this.element.className = 'prompt-list';
    this.element.setAttribute('aria-label', 'Pending permission prompts');
  }

  update(pending: readonly PermissionPrompt[]): void {
    const order = pending.map((prompt) => prompt.id);
    const ids = new Set(order);
    for (const [id, node] of this.nodes) {
      if (ids.has(id)) continue;
      clearTimeout(node.timer);
      node.item.remove();
      this.nodes.delete(id);
    }

    for (const prompt of pending) {
      let node = this.nodes.get(prompt.id);
      if (node === undefined) {
        node = this.createNode(prompt);
        this.nodes.set(prompt.id, node);
        this.lock(node);
      }
      node.item.className = prompt.tool === 'read' ? 'prompt-card prompt-card--read' : 'prompt-card';
      node.eyebrowText.textContent = promptEyebrow(prompt.tool);
      node.sentence.textContent = promptSentence(prompt);
      node.meta.textContent = promptMeta(prompt);
      this.element.append(node.item);
    }

    // A row removed or inserted above another shifts buttons under the owner's pointer.
    if (rowsShifted(this.shownOrder, order)) {
      for (const node of this.nodes.values()) this.lock(node);
    }
    this.shownOrder = order;
  }

  dispose(): void {
    for (const node of this.nodes.values()) clearTimeout(node.timer);
    this.nodes.clear();
    this.shownOrder = [];
  }

  private createNode(prompt: PermissionPrompt): PromptNode {
    const item = document.createElement('li');
    item.className = prompt.tool === 'read' ? 'prompt-card prompt-card--read' : 'prompt-card';
    item.dataset.promptId = prompt.id;

    const eyebrow = el('div', 'prompt-eyebrow');
    const eyebrowText = el('span', '', promptEyebrow(prompt.tool));
    eyebrow.append(icon('shield', 13), eyebrowText);

    const sentence = el('p', 'prompt-sentence', promptSentence(prompt));
    const meta = el('p', 'prompt-meta', promptMeta(prompt));
    const controls = el('div', 'prompt-actions');
    const error = el('p', 'error-text');

    const node: PromptNode = {
      item,
      eyebrowText,
      sentence,
      meta,
      controls,
      error,
      locked: true,
      submitting: false,
      timer: undefined,
    };

    for (const choice of promptChoices(prompt.tool)) {
      const button = el('button', choiceClass(choice.decision, choice.danger), choice.label);
      button.type = 'button';
      button.disabled = true;
      button.addEventListener('click', () => {
        void this.decide(prompt.id, choice.decision, node);
      });
      controls.append(button);
    }

    item.append(eyebrow, sentence, meta, controls, error);
    return node;
  }

  private lock(node: PromptNode): void {
    clearTimeout(node.timer);
    node.locked = true;
    this.syncDisabled(node);
    node.timer = setTimeout(() => {
      node.locked = false;
      this.syncDisabled(node);
    }, BUTTON_DELAY_MS);
  }

  private syncDisabled(node: PromptNode): void {
    const disabled = node.locked || node.submitting;
    for (const button of node.controls.querySelectorAll('button')) {
      button.disabled = disabled;
    }
  }

  private async decide(promptId: string, decision: PermissionDecision, node: PromptNode): Promise<void> {
    if (node.locked || node.submitting) return;
    node.submitting = true;
    node.error.textContent = '';
    this.syncDisabled(node);
    try {
      await this.actions.send({ type: 'panel.decide', promptId, decision });
      this.actions.announce(decision === 'decline' ? 'Permission declined.' : 'Permission granted.');
      await this.actions.refreshPanel();
    } catch (failure) {
      node.submitting = false;
      node.error.textContent = failure instanceof Error ? failure.message : String(failure);
      this.syncDisabled(node);
    }
  }
}

function choiceClass(decision: PermissionDecision, danger?: true): string {
  if (danger === true) return 'btn btn-danger';
  if (decision === 'allow-once') return 'btn btn-primary';
  return 'btn';
}
