/*
 * The one approval card, for a browser permission prompt and for a T3 thread's own approval, in T3 Code's anatomy: one
 * line saying what is asked, a line saying where, then Decline, the primary answer and More on one row. Safeguards:
 * every answer's label says what it grants (`approval-model.ts`), a card that is `locked` takes no click and no key (the
 * 500 ms lock on appearing and on rows shifting), and a card never takes focus, so a key meant for the composer cannot
 * answer it. Only the card marked `keyed` answers Enter (the primary answer) and Escape (decline), and only when the
 * key is not typed into a field or a menu (`approvalKey`).
 */
import { ArrowUpRight, Ellipsis, ShieldAlert } from 'lucide-react';
import { useEffect, useLayoutEffect, useReducer, useRef, useState, type CSSProperties, type ReactNode } from 'react';

import { errorText } from './lib/api';
import { approvalKey, type ApprovalAction, type ApprovalModel } from './approval-model';
import { rowsShifted } from './prompt-choices';
import { ICON, useDismiss } from './ui';

export const BUTTON_DELAY_MS = 500;

/**
 * Which cards are locked: a card is for 500 ms after it appears, and every card is when a card above another went away
 * or appeared, because the answers under the owner's pointer can then be another card's. `order` is the cards' ids, top
 * to bottom.
 */
export function useCardLocks(order: readonly string[]): (id: string) => boolean {
  const locks = useRef(new Map<string, number>());
  const shown = useRef<readonly string[]>([]);
  const [, redraw] = useReducer((tick: number) => tick + 1, 0);
  if (order.join('\n') !== shown.current.join('\n')) {
    const until = Date.now() + BUTTON_DELAY_MS;
    const shifted = rowsShifted(shown.current, order);
    const before = new Set(shown.current);
    for (const id of order) if (shifted || !before.has(id)) locks.current.set(id, until);
    for (const id of locks.current.keys()) if (!order.includes(id)) locks.current.delete(id);
    shown.current = [...order];
  }
  const now = Date.now();
  const nextUnlock = Math.min(...[...locks.current.values()].filter((until) => until > now), Number.POSITIVE_INFINITY);
  useEffect(() => {
    if (!Number.isFinite(nextUnlock)) return;
    const timer = setTimeout(redraw, Math.max(0, nextUnlock - Date.now()) + 5);
    return () => clearTimeout(timer);
  }, [nextUnlock]);
  return (id) => (locks.current.get(id) ?? 0) > now;
}

export interface ApprovalCardProps<D extends string> {
  model: ApprovalModel<D>;
  /** `dock`: a card above the composer. `inline`: the thread's current work-log row, as T3 places its approvals. */
  presentation: 'dock' | 'inline';
  locked: boolean;
  /** This card answers Enter and Escape. At most one card on a screen is keyed. */
  keyed: boolean;
  /** Sends the answer. The card stays disabled after a success, until the ask goes away. */
  onDecide: (decision: D) => Promise<void>;
  /** Set when the ask is about a tab other than the one the panel belongs to. */
  onGoToTab?: (() => void) | undefined;
  /** A last item under More that leaves the card (the site settings). */
  onManage?: { label: string; run: () => void } | undefined;
  data?: Record<`data-${string}`, string | number | undefined>;
  className?: string;
}

export function ApprovalCard<D extends string>({ model, presentation, locked, keyed, onDecide, onGoToTab, onManage, data, className }: ApprovalCardProps<D>): ReactNode {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();
  const disabled = locked || submitting;
  const decide = async (decision: D): Promise<void> => {
    if (disabled) return;
    setSubmitting(true);
    setError(undefined);
    try {
      await onDecide(decision);
    } catch (failure) {
      setSubmitting(false);
      setError(errorText(failure));
    }
  };
  const latest = useRef({ decide, disabled, model });
  latest.current = { decide, disabled, model };
  useEffect(() => {
    if (!keyed) return;
    const onKey = (event: KeyboardEvent): void => {
      const answer = approvalKey(event);
      if (answer === undefined) return;
      event.preventDefault();
      const { decide: send, disabled: off, model: current } = latest.current;
      if (off) return;
      void send(answer === 'primary' ? current.primary.decision : current.decline.decision);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [keyed]);
  const { ask, where } = model;
  return (
    <div className={`approval-card ${presentation}${className === undefined ? '' : ` ${className}`}`} role="group" aria-label="Approval" {...data}>
      <ShieldAlert size={ICON.sm} className="approval-icon" aria-hidden="true" />
      <div className="approval-main">
        <p className="approval-ask">
          {ask.who === undefined ? null : <strong>{ask.who} </strong>}
          {ask.verb} {ask.mono ? <code className="approval-subject">{ask.subject}</code> : <span className="approval-subject">{ask.subject}</span>}
        </p>
        {where === undefined && onGoToTab === undefined ? null : (
          <div className="approval-where-row">
            <p className={where?.mono === true ? 'approval-where mono' : 'approval-where'}>
              {onGoToTab === undefined ? null : <span className="approval-elsewhere">{where === undefined ? 'On another tab' : 'On another tab · '}</span>}
              {where?.text}
            </p>
            {onGoToTab === undefined ? null : (
              <button type="button" className="approval-goto" onClick={onGoToTab}>
                Go to tab <ArrowUpRight size={ICON.xs} aria-hidden="true" />
              </button>
            )}
          </div>
        )}
        <div className="approval-actions">
          <AnswerButton action={model.decline} disabled={disabled} hint={keyed ? 'Esc' : undefined} onClick={() => void decide(model.decline.decision)} />
          <AnswerButton action={model.primary} primary disabled={disabled} hint={keyed ? '↵' : undefined} onClick={() => void decide(model.primary.decision)} />
          {model.more.length === 0 && onManage === undefined ? null : <MoreMenu actions={model.more} disabled={disabled} onPick={(decision) => void decide(decision)} onManage={onManage} />}
        </div>
        {error === undefined ? null : <p className="error-line approval-error">{error}</p>}
      </div>
    </div>
  );
}

function AnswerButton<D extends string>({ action, primary = false, disabled, hint, onClick }: { action: ApprovalAction<D>; primary?: boolean; disabled: boolean; hint: string | undefined; onClick: () => void }): ReactNode {
  return (
    <button
      type="button"
      className={primary ? 'answer-btn primary' : 'answer-btn'}
      data-decision={action.decision}
      disabled={disabled}
      aria-keyshortcuts={hint === undefined ? undefined : hint === '↵' ? 'Enter' : 'Escape'}
      onClick={onClick}
    >
      <span className="answer-label">{action.label}</span>
      {hint === undefined ? null : (
        <kbd className="key-hint" aria-hidden="true">
          {hint}
        </kbd>
      )}
    </button>
  );
}

/**
 * T3's More: the answers that are not Decline or the primary one, each with what it grants. It opens above its button
 * in a fixed layer, so a scrolling list of cards cannot clip it.
 */
function MoreMenu<D extends string>({ actions, disabled, onPick, onManage }: { actions: ApprovalAction<D>[]; disabled: boolean; onPick: (decision: D) => void; onManage: { label: string; run: () => void } | undefined }): ReactNode {
  const [open, setOpen] = useState(false);
  const [place, setPlace] = useState<CSSProperties>();
  const box = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useDismiss(box, open, () => setOpen(false));
  useLayoutEffect(() => {
    if (!open || trigger.current === null) return;
    const rect = trigger.current.getBoundingClientRect();
    setPlace({ position: 'fixed', right: Math.max(8, window.innerWidth - rect.right), bottom: window.innerHeight - rect.top + 4 });
  }, [open]);
  return (
    <div className="approval-more" ref={box}>
      <button
        type="button"
        ref={trigger}
        className="answer-btn icon"
        aria-label="More approval options"
        title="More approval options"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen(!open)}
      >
        <Ellipsis size={ICON.md} aria-hidden="true" />
      </button>
      {open ? (
        <div className="popover approval-menu" role="menu" aria-label="More approval options" style={place ?? { visibility: 'hidden' }}>
          {actions.map((action) => (
            <button
              type="button"
              role="menuitem"
              key={action.decision}
              className="menu-row"
              data-decision={action.decision}
              disabled={disabled}
              onClick={() => {
                setOpen(false);
                onPick(action.decision);
              }}
            >
              <span>
                <strong>{action.label}</strong>
                {action.detail === undefined ? null : <small>{action.detail}</small>}
              </span>
            </button>
          ))}
          {onManage === undefined ? null : (
            <button
              type="button"
              role="menuitem"
              className="menu-row approval-manage"
              onClick={() => {
                setOpen(false);
                onManage.run();
              }}
            >
              <span>{onManage.label}</span>
            </button>
          )}
        </div>
      ) : null}
    </div>
  );
}
