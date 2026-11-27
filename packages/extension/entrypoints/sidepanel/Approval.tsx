/*
 * The one approval card, for a browser permission prompt and for a T3 thread's own approval, in T3 Code's anatomy: one
 * line saying what is asked, the address or reason and the tab under it, then Decline, the primary answer and More on one
 * row. Every answer's label says what it grants (`approval-model.ts`), and a card never takes focus, so a key meant for
 * the composer cannot answer it.
 *
 * The cards of one screen sit in one `ApprovalStack`: browser prompts, then the thread's T3 approval. It keeps their
 * locks in one list (500 ms when a card appears, when cards shift around it, when it becomes the keyed card and when the
 * panel is shown again) and listens for Enter and Escape once. Only browser prompts take keys, as T3's own client takes
 * none for its approvals, and only the keyed one answers: the first prompt fully on screen. A key answers only a press
 * that began after that card became keyed, never one typed into a field, nor while a popover, menu or dialog is open
 * (`approvalKey`).
 */
import { ArrowUpRight, Ellipsis, ShieldAlert, TriangleAlert } from 'lucide-react';
import { createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useReducer, useRef, useState, type CSSProperties, type ReactNode } from 'react';

import { errorText } from './lib/api';
import { approvalKey, COVERING, KeyGate, keyedCard, lockAll, updateLocks, type ApprovalAction, type ApprovalModel } from './approval-model';
import { ICON, useDismiss } from './ui';

interface Slot {
  element: HTMLElement | null;
  answer: (which: 'primary' | 'decline') => void;
}

interface Stack {
  locked: (id: string) => boolean;
  keyed: string | undefined;
  register: (id: string, slot: Slot) => () => void;
  seen: (id: string, visible: boolean) => void;
}

const StackContext = createContext<Stack | undefined>(undefined);

/** A card counts as on screen when this much of it shows; a card cut by a scroller or the panel's edge does not. */
const FULLY_SHOWN = 0.98;

/** Holds one screen's cards. `order` is all their ids, top to bottom; `keys` the ones Enter and Escape may answer. */
export function ApprovalStack({ order, keys, children }: { order: readonly string[]; keys: readonly string[]; children: ReactNode }): ReactNode {
  const [visible, setVisible] = useState<ReadonlySet<string>>(() => new Set());
  const keyed = keyedCard(keys, visible);
  const locks = useRef(new Map<string, number>());
  const before = useRef<{ order: readonly string[]; keyed: string | undefined }>({ order: [], keyed: undefined });
  const gate = useRef(new KeyGate());
  if (order.join('\n') !== before.current.order.join('\n') || keyed !== before.current.keyed) {
    updateLocks(locks.current, before.current, order, keyed, Date.now());
    if (keyed !== before.current.keyed) gate.current.changed();
    before.current = { order: [...order], keyed };
  }
  const [, redraw] = useReducer((tick: number) => tick + 1, 0);
  const now = Date.now();
  const nextUnlock = Math.min(...[...locks.current.values()].filter((until) => until > now), Number.POSITIVE_INFINITY);
  useEffect(() => {
    if (!Number.isFinite(nextUnlock)) return;
    const timer = setTimeout(redraw, Math.max(0, nextUnlock - Date.now()) + 5);
    return () => clearTimeout(timer);
  }, [nextUnlock]);
  const slots = useRef(new Map<string, Slot>());
  const keyedNow = useRef(keyed);
  keyedNow.current = keyed;
  const orderNow = useRef(order);
  orderNow.current = order;
  // Shown again after it was hidden: what the cards hold now has not been seen, so none answers for a moment.
  useEffect(() => {
    const onShow = (): void => {
      if (document.visibilityState !== 'visible') return;
      lockAll(locks.current, orderNow.current, Date.now());
      gate.current.reset();
      redraw();
    };
    document.addEventListener('visibilitychange', onShow);
    return () => document.removeEventListener('visibilitychange', onShow);
  }, []);
  useEffect(() => {
    const onDown = (event: KeyboardEvent): void => {
      const fresh = gate.current.down(event.key);
      const id = keyedNow.current;
      const slot = id === undefined ? undefined : slots.current.get(id);
      if (slot === undefined) return;
      const answer = approvalKey(event, slot.element, document.querySelector(COVERING) !== null);
      if (answer === undefined) return;
      event.preventDefault();
      if (fresh) slot.answer(answer);
    };
    const onUp = (event: KeyboardEvent): void => gate.current.up(event.key);
    const onBlur = (): void => gate.current.reset();
    document.addEventListener('keydown', onDown);
    document.addEventListener('keyup', onUp);
    window.addEventListener('blur', onBlur);
    return () => {
      document.removeEventListener('keydown', onDown);
      document.removeEventListener('keyup', onUp);
      window.removeEventListener('blur', onBlur);
    };
  }, []);
  const register = useCallback((id: string, slot: Slot) => {
    slots.current.set(id, slot);
    return () => {
      if (slots.current.get(id) === slot) slots.current.delete(id);
    };
  }, []);
  const seen = useCallback((id: string, shown: boolean) => {
    setVisible((current) => {
      if (current.has(id) === shown) return current;
      const next = new Set(current);
      if (shown) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);
  const lockedAt = locks.current;
  const stack = useMemo<Stack>(() => ({ locked: (id) => (lockedAt.get(id) ?? 0) > now, keyed, register, seen }), [lockedAt, now, keyed, register, seen]);
  return <StackContext.Provider value={stack}>{children}</StackContext.Provider>;
}

export interface ApprovalCardProps<D extends string> {
  /** The card's id in its `ApprovalStack`'s order. */
  id: string;
  model: ApprovalModel<D>;
  /** `dock`: a card above the composer. `inline`: the thread's current work-log row, as T3 places its approvals. */
  presentation: 'dock' | 'inline';
  /** Sends the answer. The card stays disabled after a success, until the ask goes away. */
  onDecide: (decision: D) => Promise<void>;
  /** Set when the ask is about a tab other than the one the panel belongs to. */
  onGoToTab?: (() => void) | undefined;
  /** A last item under More that leaves the card (the site settings). */
  onManage?: { label: string; run: () => void } | undefined;
  data?: Record<`data-${string}`, string | number | undefined>;
}

export function ApprovalCard<D extends string>({ id, model, presentation, onDecide, onGoToTab, onManage, data }: ApprovalCardProps<D>): ReactNode {
  const stack = useContext(StackContext);
  if (stack === undefined) throw new Error('An approval card needs an ApprovalStack');
  const locked = stack.locked(id);
  const keyed = stack.keyed === id;
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();
  const disabled = locked || submitting || model.unanswerable !== undefined;
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
  const latest = useRef({ decide, model });
  latest.current = { decide, model };
  const element = useRef<HTMLDivElement>(null);
  const { register, seen } = stack;
  useEffect(
    () =>
      register(id, {
        get element() {
          return element.current;
        },
        answer: (which) => {
          const action = which === 'primary' ? latest.current.model.primary : latest.current.model.decline;
          if (action !== undefined) void latest.current.decide(action.decision);
        },
      }),
    [id, register],
  );
  useEffect(() => {
    const node = element.current;
    if (node === null) return;
    const observer = new IntersectionObserver(([entry]) => seen(id, entry !== undefined && entry.isIntersecting && entry.intersectionRatio >= FULLY_SHOWN), { threshold: [0, FULLY_SHOWN, 1] });
    observer.observe(node);
    return () => {
      observer.disconnect();
      seen(id, false);
    };
  }, [id, seen]);
  const askId = useId();
  const { ask, detail, tab } = model;
  return (
    <div ref={element} className={`approval-card ${presentation}`} role="group" aria-labelledby={askId} data-keyed={keyed ? 'true' : undefined} {...data}>
      <ShieldAlert size={ICON.sm} className="approval-icon" aria-hidden="true" />
      <div className="approval-main">
        <p className="approval-ask" id={askId}>
          {ask.who === undefined ? null : <strong>{ask.who} </strong>}
          {ask.verb} {ask.mono ? <code className="approval-subject">{ask.subject}</code> : <span className="approval-subject">{ask.subject}</span>}
        </p>
        {detail === undefined ? null : <p className={detail.mono ? 'approval-where mono' : 'approval-where'}>{detail.text}</p>}
        {tab === undefined && onGoToTab === undefined ? null : (
          <div className="approval-where-row">
            <p className="approval-where approval-tab">
              {onGoToTab === undefined ? null : <span className="approval-elsewhere">{tab === undefined ? 'On another tab' : 'On another tab · '}</span>}
              {tab}
            </p>
            {onGoToTab === undefined ? null : (
              <button type="button" className="approval-goto" onClick={onGoToTab}>
                Go to tab <ArrowUpRight size={ICON.xs} aria-hidden="true" />
              </button>
            )}
          </div>
        )}
        <div className="approval-actions">
          {model.decline === undefined ? null : <AnswerButton action={model.decline} disabled={disabled} hint={keyed ? 'Esc' : undefined} onClick={(decision) => void decide(decision)} />}
          {model.primary === undefined ? null : <AnswerButton action={model.primary} primary disabled={disabled} hint={keyed ? '↵' : undefined} onClick={(decision) => void decide(decision)} />}
          {model.more.length === 0 && onManage === undefined ? null : <MoreMenu actions={model.more} disabled={disabled} onPick={(decision) => void decide(decision)} onManage={onManage} />}
        </div>
        {model.unanswerable === undefined ? null : <p className="approval-unanswerable">{model.unanswerable}</p>}
        {error === undefined ? null : <p className="error-line approval-error">{error}</p>}
      </div>
    </div>
  );
}

function AnswerButton<D extends string>({ action, primary = false, disabled, hint, onClick }: { action: ApprovalAction<D>; primary?: boolean; disabled: boolean; hint: string | undefined; onClick: (decision: D) => void }): ReactNode {
  return (
    <button
      type="button"
      className={primary ? 'answer-btn primary' : 'answer-btn'}
      data-decision={action.decision}
      disabled={disabled}
      title={action.warning}
      aria-description={action.warning}
      aria-keyshortcuts={hint === undefined ? undefined : hint === '↵' ? 'Enter' : 'Escape'}
      onClick={() => onClick(action.decision)}
    >
      {action.warning === undefined ? null : <TriangleAlert size={ICON.xs} className="answer-warning" aria-hidden="true" />}
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
              title={action.warning}
              aria-description={action.warning}
              onClick={() => {
                setOpen(false);
                onPick(action.decision);
              }}
            >
              {action.warning === undefined ? null : <TriangleAlert size={ICON.sm} className="menu-icon answer-warning" aria-hidden="true" />}
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
