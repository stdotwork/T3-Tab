import {
  Bot,
  Brain,
  ChevronRight,
  CircleHelp,
  Copy,
  FilePen,
  Globe,
  ListChecks,
  MessageSquare,
  MousePointerClick,
  Search,
  ShieldAlert,
  SquareTerminal,
  Wrench,
} from 'lucide-react';
import { memo, useEffect, useRef, useState, type ReactNode } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import type { PendingApproval, PendingQuestion, Row, ThreadView, WorkEntry, WorkIcon } from './lib/thread-model';
import { formatDuration } from './ui';

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

/** Agent text is rendered as markdown with no remote images, so a reply cannot load anything by being shown. */
export const MessageText = memo(function MessageText({ text }: { text: string }): ReactNode {
  return (
    <div className="chat-markdown">
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={{
          img: ({ alt }) => <span className="md-image">{alt ?? 'image'}</span>,
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noreferrer noopener">
              {children}
            </a>
          ),
        }}
      >
        {text}
      </Markdown>
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
        <Icon size={15} aria-hidden="true" />
        <span className={entry.status === 'running' ? 'work-label shimmer' : 'work-label'}>{entry.label}</span>
      </button>
      {open && entry.detail !== undefined ? <pre className="work-detail">{entry.detail}</pre> : null}
    </div>
  );
}

function WorkGroup({ row }: { row: Extract<Row, { kind: 'work' }> }): ReactNode {
  const [open, setOpen] = useState(false);
  const now = useNow(row.running);
  const end = row.running ? now : (row.endedAt ?? now);
  const duration = row.startedAt === undefined ? undefined : formatDuration(end - row.startedAt);
  if (row.running) {
    return (
      <section className="work-group" data-timeline-row-kind="work">
        <div className="work-head">{duration === undefined ? 'Working…' : `Working for ${duration}`}</div>
        <div className="work-entries">
          {row.entries.slice(-8).map((entry) => (
            <Entry key={entry.id} entry={entry} />
          ))}
        </div>
      </section>
    );
  }
  return (
    <section className="work-group" data-timeline-row-kind="work">
      <button type="button" className="work-head toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        {duration === undefined ? 'Worked' : `Worked for ${duration}`}
        <ChevronRight size={14} className={open ? 'chev open' : 'chev'} aria-hidden="true" />
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
  const [copied, setCopied] = useState(false);
  return (
    <article className="assistant" data-message-role="assistant">
      <MessageText text={row.text} />
      {row.streaming ? null : (
        <div className="message-meta">
          <button
            type="button"
            aria-label={copied ? 'Copied' : 'Copy reply'}
            title={copied ? 'Copied' : 'Copy'}
            onClick={() => {
              void navigator.clipboard.writeText(row.text).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1200);
              });
            }}
          >
            <Copy size={13} aria-hidden="true" />
          </button>
          {row.at === undefined ? null : <time>{new Date(row.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</time>}
        </div>
      )}
    </article>
  );
}

export function Timeline({ view }: { view: ThreadView }): ReactNode {
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  useEffect(() => {
    const element = scroller.current;
    if (element !== null && pinned.current) element.scrollTop = element.scrollHeight;
  });
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
          return (
            <div className="user-row" key={row.id} data-message-role="user">
              <div className="user-bubble" data-user-message-bubble>
                {row.text}
              </div>
            </div>
          );
        }
        if (row.kind === 'work') return <WorkGroup key={row.id} row={row} />;
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

export function ApprovalCard({ approval, onAnswer }: { approval: PendingApproval; onAnswer: (decision: string) => void }): ReactNode {
  const order = ['cancel', 'decline', 'acceptForSession', 'acceptAlways', 'accept'];
  const options = [...approval.options]
    .filter((option) => option.decision !== 'cancel')
    .sort((a, b) => order.indexOf(a.decision) - order.indexOf(b.decision));
  return (
    <div className="approval-card" role="group" aria-label="Approval">
      <div className="approval-head">
        <ShieldAlert size={14} aria-hidden="true" />
        Waiting for approval
      </div>
      <p className="approval-title">{approval.title}</p>
      {approval.detail === undefined ? null : <p className="approval-detail">{approval.detail}</p>}
      <div className="approval-actions">
        {options.map((option) => (
          <button type="button" key={option.decision} className={option.decision === 'accept' ? 'prompt-btn primary' : 'prompt-btn'} onClick={() => onAnswer(option.decision)}>
            {option.label}
          </button>
        ))}
      </div>
    </div>
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
  if (question === undefined) return null;
  const chosen = picked[question.id] ?? [];
  const typed = custom[question.id] ?? '';
  const answered = (entry: (typeof pending.questions)[number]): boolean => (picked[entry.id]?.length ?? 0) > 0 || (custom[entry.id] ?? '').trim() !== '';
  const last = index === pending.questions.length - 1;
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
        <CircleHelp size={14} aria-hidden="true" />
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
        <input className="question-custom" placeholder="Or type your own answer" value={typed} onChange={(event) => setCustom({ ...custom, [question.id]: event.target.value })} />
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
          disabled={last ? !pending.questions.every(answered) : !answered(question)}
          onClick={() => (last ? submit() : setIndex(index + 1))}
        >
          {last ? 'Submit' : 'Next'}
        </button>
      </div>
    </div>
  );
}
