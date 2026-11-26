import {
  Bot,
  Brain,
  ChevronRight,
  CircleHelp,
  FilePen,
  Globe,
  ListChecks,
  MessageSquare,
  MousePointerClick,
  Search,
  ShieldAlert,
  SquareTerminal,
  Wrench,
  X,
} from 'lucide-react';
import { lazy, memo, Suspense, useEffect, useRef, useState, type ReactNode } from 'react';

import type { PendingApproval, PendingQuestion, QueuedMessage, Row, ThreadView, WorkEntry, WorkIcon } from './lib/thread-model';
import { ApprovalCard, useCardLocks } from './Approval';
import { t3Approval } from './approval-model';
import { clockTime, CopyButton, formatDuration, ICON } from './ui';

// The markdown parser is about a quarter of the panel's script, and a new thread has nothing to render with it.
const Markdown = lazy(() => import('./Markdown'));

const ICONS: Record<WorkIcon, typeof Brain> = {
  thinking: Brain,
  read: Search,
  edit: FilePen,
  command: SquareTerminal,
  search: Search,
  web: Globe,
  tool: Wrench,
  browser: MousePointerClick,
  ask: MessageSquare,
  approval: ShieldAlert,
  agent: Bot,
  plan: ListChecks,
  note: MessageSquare,
};

/** Agent text, as plain text for the moment the markdown renderer takes to load. */
export const MessageText = memo(function MessageText({ text }: { text: string }): ReactNode {
  return (
    <div className="chat-markdown">
      <Suspense fallback={<p className="plain-text">{text}</p>}>
        <Markdown text={text} />
      </Suspense>
    </div>
  );
});

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

function Entry({ entry }: { entry: WorkEntry }): ReactNode {
  const [open, setOpen] = useState(false);
  const Icon = ICONS[entry.icon];
  const expandable = entry.detail !== undefined && entry.detail.trim() !== '' && entry.detail.trim() !== entry.label.trim();
  const className = `work-entry ${entry.status}${entry.icon === 'command' ? ' mono' : ''}`;
  return (
    <div className="work-item">
      <button type="button" className={className} disabled={!expandable} aria-expanded={expandable ? open : undefined} onClick={() => setOpen(!open)}>
        <Icon size={ICON.sm} aria-hidden="true" />
        <span className={entry.status === 'running' ? 'work-label shimmer' : 'work-label'}>{entry.label}</span>
      </button>
      {open && entry.detail !== undefined ? <pre className="work-detail">{entry.detail}</pre> : null}
    </div>
  );
}

function WorkGroup({ row, approval }: { row: Extract<Row, { kind: 'work' }>; approval?: InlineApproval | undefined }): ReactNode {
  const [open, setOpen] = useState(false);
  const now = useNow(row.running);
  const end = row.running ? now : (row.endedAt ?? now);
  const duration = row.startedAt === undefined ? undefined : formatDuration(end - row.startedAt);
  if (row.running) {
    return (
      <section className="work-group" data-timeline-row-kind="work">
        <div className="work-head">{duration === undefined ? 'Working…' : `Working for ${duration}`}</div>
        <div className="work-entries">
          {row.entries.slice(-8).map((entry) =>
            entry.id === approval?.entryId ? (
              <div className="work-item" key={entry.id} data-approval-entry={entry.id}>
                {approval.card}
              </div>
            ) : (
              <Entry key={entry.id} entry={entry} />
            ),
          )}
        </div>
      </section>
    );
  }
  return (
    <section className="work-group" data-timeline-row-kind="work">
      <button type="button" className="work-head toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        {duration === undefined ? 'Worked' : `Worked for ${duration}`}
        <ChevronRight size={ICON.sm} className={open ? 'chev open' : 'chev'} aria-hidden="true" />
      </button>
      {open ? (
        <div className="work-entries">
          {row.entries.map((entry) => (
            <Entry key={entry.id} entry={entry} />
          ))}
        </div>
      ) : null}
    </section>
  );
}

function AssistantRow({ row }: { row: Extract<Row, { kind: 'assistant' }> }): ReactNode {
  return (
    <article className="assistant" data-message-role="assistant">
      <MessageText text={row.text} />
      {row.streaming ? null : (
        <div className="message-meta">
          <CopyButton text={row.text} label="Copy reply" />
          {row.at === undefined ? null : <time>{clockTime(row.at)}</time>}
        </div>
      )}
    </article>
  );
}

function UserRow({ row }: { row: Extract<Row, { kind: 'user' }> }): ReactNode {
  return (
    <div className="user-row" data-message-role="user">
      <div className="user-bubble" data-user-message-bubble>
        {row.text}
      </div>
      <div className="message-meta user-meta">
        {row.at === undefined ? null : <time>{clockTime(row.at)}</time>}
        <CopyButton text={row.text} label="Copy message" />
      </div>
    </div>
  );
}

/** A waiting approval drawn as its own row of the running work log, as T3 draws it. */
export interface InlineApproval {
  entryId: string;
  card: ReactNode;
}

export function Timeline({ view, approval }: { view: ThreadView; approval?: InlineApproval | undefined }): ReactNode {
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  useEffect(() => {
    const element = scroller.current;
    if (element !== null && pinned.current) element.scrollTop = element.scrollHeight;
  });
  // A new approval is brought into view even when the owner had scrolled up: it waits on them.
  const approvalEntry = approval?.entryId;
  useEffect(() => {
    if (approvalEntry === undefined) return;
    scroller.current?.querySelector(`[data-approval-entry="${CSS.escape(approvalEntry)}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [approvalEntry]);
  return (
    <div
      className="timeline messages-timeline-scroll"
      ref={scroller}
      onScroll={(event) => {
        const element = event.currentTarget;
        pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 60;
      }}
    >
      {view.rows.map((row) => {
        if (row.kind === 'user') {
          return <UserRow key={row.id} row={row} />;
        }
        if (row.kind === 'work') return <WorkGroup key={row.id} row={row} approval={row.running ? approval : undefined} />;
        if (row.kind === 'assistant') return <AssistantRow key={row.id} row={row} />;
        return (
          <p className={`notice ${row.tone}`} key={row.id}>
            {row.text}
          </p>
        );
      })}
    </div>
  );
}

/**
 * Where T3 draws a waiting approval: in place of its row in the running work log. True when that row is on screen (the
 * running group shows its last eight steps); otherwise the card goes above the composer.
 */
export function approvalInline(view: ThreadView): boolean {
  const entryId = view.approval?.entryId;
  if (entryId === undefined) return false;
  return view.rows.some((row) => row.kind === 'work' && row.running && row.entries.slice(-8).some((entry) => entry.id === entryId));
}

/** A T3 thread's approval in the one approval card, locked for 500 ms when it appears like every card. */
export function T3ApprovalCard({ approval, presentation, keyed, onAnswer }: { approval: PendingApproval; presentation: 'dock' | 'inline'; keyed: boolean; onAnswer: (decision: string) => Promise<void> }): ReactNode {
  const locked = useCardLocks([approval.requestId]);
  return (
    <ApprovalCard
      key={approval.requestId}
      model={t3Approval(approval)}
      presentation={presentation}
      locked={locked(approval.requestId)}
      keyed={keyed}
      onDecide={onAnswer}
      data={{ 'data-approval-kind': approval.kind, 'data-request-id': approval.requestId }}
    />
  );
}

/** Follow-ups waiting for the current turn. After a Stop, T3 holds them until the owner says go. */
export function QueuedMessages({ queued, running, onCancel, onStart }: { queued: QueuedMessage[]; running: boolean; onCancel: (runId: string) => void; onStart: (runId: string) => void }): ReactNode {
  if (queued.length === 0) return null;
  return (
    <ul className="queued-list" aria-label="Queued messages">
      {queued.map((entry, index) => (
        <li key={entry.runId}>
          <small>{entry.held && !running ? 'Held' : 'Queued'}</small>
          <span className="queued-text" title={entry.text}>
            {entry.text}
          </span>
          {!running && index === 0 ? (
            <button type="button" className="queued-send" onClick={() => onStart(entry.runId)}>
              Send now
            </button>
          ) : null}
          <button type="button" className="queued-x" aria-label={`Remove queued message: ${entry.text.slice(0, 40)}`} title="Remove" onClick={() => onCancel(entry.runId)}>
            <X size={ICON.xs} aria-hidden="true" />
          </button>
        </li>
      ))}
    </ul>
  );
}

export function QuestionCard({
  pending,
  onSubmit,
}: {
  pending: PendingQuestion;
  onSubmit: (answers: Record<string, unknown>) => void;
}): ReactNode {
  const [index, setIndex] = useState(0);
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [custom, setCustom] = useState<Record<string, string>>({});
  const question = pending.questions[index];
  // As in T3 Code: 1-9 choose an option unless the owner is typing somewhere. Choosing never sends.
  useEffect(() => {
    if (question === undefined) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || !/^[1-9]$/.test(event.key)) return;
      if (event.target instanceof Element && event.target.closest('input, textarea, select, [contenteditable], [role="dialog"], [role="menu"]') !== null) return;
      const option = question.options[Number(event.key) - 1];
      if (option === undefined) return;
      event.preventDefault();
      const value = option.value ?? option.label;
      setPicked((current) => {
        const now = current[question.id] ?? [];
        return { ...current, [question.id]: question.multiSelect === true ? (now.includes(value) ? now.filter((entry) => entry !== value) : [...now, value]) : [value] };
      });
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [question]);
  if (question === undefined) return null;
  const chosen = picked[question.id] ?? [];
  const typed = custom[question.id] ?? '';
  const answered = (entry: (typeof pending.questions)[number]): boolean => (picked[entry.id]?.length ?? 0) > 0 || (custom[entry.id] ?? '').trim() !== '';
  const last = index === pending.questions.length - 1;
  const canAdvance = last ? pending.questions.every(answered) : answered(question);
  const submit = (): void => {
    const answers: Record<string, unknown> = {};
    for (const entry of pending.questions) {
      const text = (custom[entry.id] ?? '').trim();
      const values = picked[entry.id] ?? [];
      answers[entry.id] = text !== '' ? text : entry.multiSelect === true ? values : values[0];
    }
    onSubmit(answers);
  };
  return (
    <div className="question-card" role="group" aria-label="Question">
      <div className="question-head">
        <CircleHelp size={ICON.sm} aria-hidden="true" />
        <span>{question.header}</span>
        {pending.questions.length > 1 ? (
          <small>
            {index + 1} of {pending.questions.length}
          </small>
        ) : null}
      </div>
      <p className="question-text">{question.question}</p>
      <div className="question-options">
        {question.options.map((option, optionIndex) => {
          const value = option.value ?? option.label;
          const selected = chosen.includes(value);
          return (
            <button
              type="button"
              key={value}
              className={selected ? 'question-option selected' : 'question-option'}
              aria-pressed={selected}
              onClick={() => {
                const next = question.multiSelect === true ? (selected ? chosen.filter((entry) => entry !== value) : [...chosen, value]) : [value];
                setPicked({ ...picked, [question.id]: next });
              }}
            >
              <span className={question.multiSelect === true ? 'option-mark square' : 'option-mark'} />
              <span className="option-text">
                <strong>{option.label}</strong>
                {option.description === '' ? null : <small>{option.description}</small>}
              </span>
              <kbd>{optionIndex + 1}</kbd>
            </button>
          );
        })}
      </div>
      {question.allowCustomAnswer === false ? null : (
        <input
          className="question-custom"
          placeholder="Or type your own answer"
          value={typed}
          onChange={(event) => setCustom({ ...custom, [question.id]: event.target.value })}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' || event.nativeEvent.isComposing || !canAdvance) return;
            event.preventDefault();
            if (last) submit();
            else setIndex(index + 1);
          }}
        />
      )}
      <div className="question-actions">
        {index > 0 ? (
          <button type="button" className="prompt-btn" onClick={() => setIndex(index - 1)}>
            Back
          </button>
        ) : null}
        <button
          type="button"
          className="prompt-btn primary"
          disabled={!canAdvance}
          onClick={() => (last ? submit() : setIndex(index + 1))}
        >
          {last ? 'Submit' : 'Next'}
        </button>
      </div>
    </div>
  );
}
