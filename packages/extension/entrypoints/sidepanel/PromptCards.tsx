/*
 * The browser permission card. Safeguards kept from T3-Tab's permission policy: the button labels say exactly what
 * they grant (`promptChoices`), buttons stay disabled for 500 ms when a card appears and whenever rows shift
 * (`rowsShifted`), cards are keyed so they never swap under the pointer, and a card never takes focus.
 */
import { Hand } from 'lucide-react';
import { useEffect, useReducer, useRef, useState, type ReactNode } from 'react';

import type { PermissionDecision, PermissionPrompt } from '../../src/permissions';
import { errorText, panel } from './lib/api';
import { promptChoices, rowsShifted } from './prompt-choices';

export const BUTTON_DELAY_MS = 500;

const plain = (text: string): string => [...text].filter((character) => (character.codePointAt(0) ?? 0) >= 32).join('');

const heading = (prompt: PermissionPrompt): string => {
  if (prompt.tool === 'read') return 'wants to read';
  if (prompt.tool === 'open') return 'wants to open';
  if (prompt.tool === 'run_js') return 'wants to run JavaScript on';
  return 'wants to act on';
};

function PromptCard({ prompt, locked, here }: { prompt: PermissionPrompt; locked: boolean; here: boolean }): ReactNode {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();
  const disabled = locked || submitting;
  const decide = async (decision: PermissionDecision): Promise<void> => {
    if (disabled) return;
    setSubmitting(true);
    setError(undefined);
    try {
      await panel({ type: 'panel.decide', promptId: prompt.id, decision });
    } catch (failure) {
      setSubmitting(false);
      setError(errorText(failure));
    }
  };
  const host = (() => {
    try {
      return new URL(prompt.origin).host;
    } catch {
      return prompt.origin;
    }
  })();
  const choices = promptChoices(prompt.tool);
  const once = choices.find((choice) => choice.decision === 'allow-once');
  const decline = choices.find((choice) => choice.decision === 'decline');
  const always = choices.find((choice) => choice.decision !== 'allow-once' && choice.decision !== 'decline');
  const choice = (entry: (typeof choices)[number] | undefined, className: string): ReactNode =>
    entry === undefined ? null : (
      <button type="button" className={className} disabled={disabled} onClick={() => void decide(entry.decision)}>
        {entry.label}
      </button>
    );
  return (
    <li className="prompt-card" data-prompt-id={prompt.id}>
      <div className="prompt-head">
        <Hand size={15} aria-hidden="true" />
        <span>{here ? 'Permission needed' : 'Permission needed on another tab'}</span>
      </div>
      <div className="prompt-body">
        <p className="prompt-who">
          {plain(prompt.session.name)} {heading(prompt)}
        </p>
        <p className="prompt-host">{host}</p>
        <p className="prompt-tab">
          "{plain(prompt.tab.title || '(untitled)')}" <span>tab {prompt.tab.id}</span>
        </p>
      </div>
      <div className="prompt-actions">
        {choice(once, 'prompt-btn primary')}
        {choice(decline, 'prompt-btn')}
        {choice(always, 'prompt-btn subtle')}
      </div>
      {error === undefined ? null : <p className="error-line">{error}</p>}
    </li>
  );
}

export function PromptCards({ prompts, currentTabId }: { prompts: PermissionPrompt[]; currentTabId?: number | undefined }): ReactNode {
  const locks = useRef(new Map<string, number>());
  const shown = useRef<string[]>([]);
  const [, redraw] = useReducer((tick: number) => tick + 1, 0);
  const order = prompts.map((prompt) => prompt.id);
  if (order.join('\n') !== shown.current.join('\n')) {
    const until = Date.now() + BUTTON_DELAY_MS;
    const shifted = rowsShifted(shown.current, order);
    const before = new Set(shown.current);
    for (const id of order) if (shifted || !before.has(id)) locks.current.set(id, until);
    for (const id of locks.current.keys()) if (!order.includes(id)) locks.current.delete(id);
    shown.current = order;
  }
  const now = Date.now();
  const nextUnlock = Math.min(...[...locks.current.values()].filter((until) => until > now), Number.POSITIVE_INFINITY);
  useEffect(() => {
    if (!Number.isFinite(nextUnlock)) return;
    const timer = setTimeout(redraw, Math.max(0, nextUnlock - Date.now()) + 5);
    return () => clearTimeout(timer);
  }, [nextUnlock]);
  if (prompts.length === 0) return null;
  return (
    <ul className="prompt-list" aria-label="Pending permission prompts">
      {prompts.map((prompt) => (
        <PromptCard
          key={prompt.id}
          prompt={prompt}
          locked={(locks.current.get(prompt.id) ?? 0) > now}
          here={currentTabId === undefined || prompt.tab.id === currentTabId}
        />
      ))}
    </ul>
  );
}
