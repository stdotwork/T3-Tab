/*
 * The browser permission card. Safeguards kept from T3-Tab's permission policy: the button labels say exactly what
 * they grant (`promptChoices`), buttons stay disabled for 500 ms when a card appears and whenever rows shift
 * (`rowsShifted`), cards are keyed so they never swap under the pointer, and a card never takes focus, so no key press
 * meant for the composer can answer it.
 */
import type { ToolSession } from '@t3-tab/protocol';
import { ArrowUpRight, Hand } from 'lucide-react';
import { useEffect, useReducer, useRef, useState, type ReactNode } from 'react';

import type { PermissionDecision, PermissionPrompt } from '../../src/permissions';
import { errorText, panel } from './lib/api';
import { promptChoices, rowsShifted, type PromptChoice } from './prompt-choices';

export const BUTTON_DELAY_MS = 500;

const plain = (text: string): string => [...text].filter((character) => (character.codePointAt(0) ?? 0) >= 32).join('');

const heading = (prompt: PermissionPrompt): string => {
  if (prompt.tool === 'read') return 'wants to read';
  if (prompt.tool === 'open') return 'wants to open';
  if (prompt.tool === 'run_js') return 'wants to run JavaScript on';
  return 'wants to act on';
};

const showTab = (tabId: number): void => {
  void chrome.tabs
    .update(tabId, { active: true })
    .then(async (tab) => {
      if (tab?.windowId !== undefined) await chrome.windows.update(tab.windowId, { focused: true });
    })
    .catch(() => undefined);
};

function PromptCard({
  prompt,
  locked,
  here,
  asker,
  onManageSites,
}: {
  prompt: PermissionPrompt;
  locked: boolean;
  here: boolean;
  asker: string;
  onManageSites?: (() => void) | undefined;
}): ReactNode {
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
  // A tab not loaded yet is named by the address it would open; the worker's prompt carries whichever it has.
  const tab = prompt.tab as PermissionPrompt['tab'] | undefined;
  const address = (prompt as PermissionPrompt & { url?: string }).url;
  const choices = promptChoices(prompt.tool);
  const once = choices.find((choice) => choice.decision === 'allow-once');
  const decline = choices.find((choice) => choice.decision === 'decline');
  const always = choices.find((choice) => choice.decision !== 'allow-once' && choice.decision !== 'decline');
  const choice = (entry: PromptChoice | undefined, className: string): ReactNode =>
    entry === undefined ? null : (
      <button type="button" className={className} disabled={disabled} onClick={() => void decide(entry.decision)}>
        <span className="prompt-btn-label">{entry.label}</span>
        {entry.detail === undefined ? null : <small>{entry.detail}</small>}
      </button>
    );
  return (
    <li className="prompt-card" data-prompt-id={prompt.id} data-tab-id={tab?.id}>
      <div className="prompt-head">
        <Hand size={15} aria-hidden="true" />
        <span>{here ? 'Permission needed' : 'Permission needed on another tab'}</span>
        {here || tab === undefined ? null : (
          <button type="button" className="prompt-goto" onClick={() => showTab(tab.id)}>
            Go to tab <ArrowUpRight size={12} aria-hidden="true" />
          </button>
        )}
      </div>
      <div className="prompt-body">
        <p className="prompt-who">
          <strong>{plain(asker)}</strong> {heading(prompt)}
        </p>
        <p className="prompt-host">{host}</p>
        {address === undefined ? null : <p className="prompt-address">{plain(address)}</p>}
        {tab === undefined || (address !== undefined && tab.title === '') ? null : <p className="prompt-tab">"{plain(tab.title || '(untitled)')}"</p>}
      </div>
      <div className="prompt-actions">
        {choice(once, 'prompt-btn primary')}
        {choice(decline, 'prompt-btn')}
      </div>
      <div className="prompt-always">{choice(always, 'prompt-btn')}</div>
      {error === undefined ? null : <p className="error-line prompt-error">{error}</p>}
      {onManageSites === undefined ? null : (
        <p className="prompt-foot">
          <button type="button" className="prompt-link" onClick={onManageSites}>
            Manage sites
          </button>
        </p>
      )}
    </li>
  );
}

export function PromptCards({
  prompts,
  currentTabId,
  askerName,
  onManageSites,
}: {
  prompts: PermissionPrompt[];
  currentTabId?: number | undefined;
  askerName?: ((session: ToolSession) => string) | undefined;
  onManageSites?: (() => void) | undefined;
}): ReactNode {
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
          here={currentTabId === undefined || prompt.tool === 'open' || (prompt.tab as PermissionPrompt['tab'] | undefined)?.id === undefined || prompt.tab.id === currentTabId}
          asker={askerName?.(prompt.session) ?? prompt.session.name}
          onManageSites={onManageSites}
        />
      ))}
    </ul>
  );
}
