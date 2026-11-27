/**
 * The thread list, as T3 Code's sidebar draws it: the search row, a card per thread (project avatar and name, status or
 * time, title and the provider's logo), hover actions to snooze and settle, and the Working, Snoozed and Settled shelves
 * at the foot of the list with slim rows. Nested controls make each row a `role="button"` rather than a button. The
 * agents using the browser, which T3 has no place for, sit under the list where T3 keeps its own status.
 */
import {
  AlarmClock,
  AlarmClockOff,
  Check,
  ChevronDown,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CircleDotDashed,
  Clock,
  MessageCircleQuestionMark,
  Pin,
  Search,
  ShieldQuestionMark,
  Undo2,
  UserRound,
  type LucideIcon,
} from 'lucide-react';
import { useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';

import { Bar, BarActions, directRuns, useWakeClock, type Screen } from './Frame';
import { ActiveSessions } from './Sessions';
import { errorText } from './lib/api';
import { useStored, type LiveState } from './lib/store';
import { projectName } from './lib/new-thread';
import { snoozeChoices } from './lib/snooze';
import { t3, type T3State } from './lib/t3-client';
import { SETTLED_FIRST, SETTLED_MORE, SHELF_LABEL, STATUS_LABEL, threadSections, wakeLabel, type ListRow, type RowStatus } from './lib/thread-sections';
import { ICON, ProjectAvatar, ProviderIcon, timeAgo, useDismiss } from './ui';

const STATUS_ICON: Record<RowStatus, LucideIcon> = {
  working: CircleDashed,
  connecting: CircleDashed,
  waiting: CircleDotDashed,
  input: MessageCircleQuestionMark,
  plan: MessageCircleQuestionMark,
  guest: UserRound,
  approval: ShieldQuestionMark,
  failed: CircleAlert,
  completed: CircleCheck,
};

interface Described {
  title: string;
  project: string;
  /** The provider the thread runs on, for its logo; none when T3 lists no such provider, as T3 then draws none. */
  provider: { driver: string; name: string } | undefined;
}

/** Runs the action without opening the row it sits in. */
const own =
  (action: () => void) =>
  (event: MouseEvent): void => {
    event.stopPropagation();
    action();
  };

function SnoozeMenu({ state, onPick, onClose }: { state: T3State; onPick: (until: string) => void; onClose: () => void }): ReactNode {
  const box = useRef<HTMLDivElement>(null);
  useDismiss(box, true, onClose);
  const choices = snoozeChoices(state.snoozePresets, new Date());
  return (
    <div className="popover snooze-popover" role="menu" aria-label="Snooze until" ref={box} onClick={(event) => event.stopPropagation()}>
      {choices.map((choice) => (
        <button type="button" role="menuitem" key={choice.id} className="menu-row" onClick={() => onPick(choice.snoozedUntil)}>
          <span>{choice.label}</span>
          <small>{choice.whenLabel}</small>
        </button>
      ))}
    </div>
  );
}

export function ThreadList({
  live,
  state,
  onOpen,
  onClose,
  onSettings,
}: {
  live: LiveState;
  state: T3State;
  onOpen: (screen: Screen) => void;
  onClose: () => void;
  onSettings: () => void;
}): ReactNode {
  const [query, setQuery] = useState('');
  // T3 keeps its shelves closed until the owner opens them, and remembers that; so does the panel.
  const [workingOpen, setWorkingOpen] = useStored('threads.workingOpen', false);
  const [snoozedOpen, setSnoozedOpen] = useStored('threads.snoozedOpen', false);
  const [settledOpen, setSettledOpen] = useStored('threads.settledOpen', false);
  const [settledShown, setSettledShown] = useState(SETTLED_FIRST);
  const [snoozing, setSnoozing] = useState<string>();
  const [error, setError] = useState<string>();
  const now = useWakeClock(state);
  const needle = query.trim().toLowerCase();
  const projects = new Map(state.projects.map((project) => [project.id, project]));
  const providers = new Map(state.providers.map((provider) => [provider.instanceId, provider]));
  const sections = threadSections(state.threads, directRuns(live), now);
  const act = (action: () => Promise<void>): void => {
    setError(undefined);
    void action().catch((failure: unknown) => setError(errorText(failure)));
  };
  const describe = (row: ListRow): Described => {
    if (row.source === 'direct') {
      const via = live.conversations.find((conversation) => conversation.id === row.id)?.via;
      const name = via === 'claude' ? 'Claude Code' : 'Codex';
      return { title: row.run.title, project: name, provider: { driver: via === 'claude' ? 'claudeAgent' : 'codex', name } };
    }
    const project = projects.get(row.shell.projectId);
    const provider = providers.get(row.shell.modelSelection?.instanceId ?? row.shell.providerInstanceId ?? '');
    return {
      title: row.shell.title,
      project: project === undefined ? 'T3 Code' : projectName(project, state.scratchRoot),
      provider: provider === undefined ? undefined : { driver: provider.driver, name: provider.displayName ?? provider.instanceId },
    };
  };
  const open = (row: ListRow): void => onOpen({ name: 'thread', id: row.id, source: row.source });
  const keys = (row: ListRow) => (event: KeyboardEvent): void => {
    if (event.target !== event.currentTarget || (event.key !== 'Enter' && event.key !== ' ')) return;
    event.preventDefault();
    open(row);
  };

  const statusOf = (row: ListRow, lastAt: number, slim = false): ReactNode => {
    // A slim (snoozed or settled) row shows when it wakes, or its time, as T3's does; never a status.
    if (row.status !== undefined && !slim) {
      const Icon = STATUS_ICON[row.status];
      return (
        <span className={`thread-badge ${row.status}`}>
          <Icon size={ICON.md} aria-hidden="true" />
          {STATUS_LABEL[row.status]}
        </span>
      );
    }
    if (row.source === 't3' && row.wakesAt !== undefined) {
      return (
        <span className="thread-badge snoozed" title="Wakes">
          <AlarmClock size={ICON.xs} aria-hidden="true" />
          {wakeLabel(row.wakesAt, now)}
        </span>
      );
    }
    return <time className="thread-time">{timeAgo(lastAt)}</time>;
  };

  /** T3's hover actions for a row: snooze and Settle in the list, Wake on a snoozed one, Un-settle on a settled one. */
  const actionsOf = (row: ListRow, slim: boolean): ReactNode => {
    if (row.source !== 't3' || state.status !== 'ready') return null;
    if (row.section === 'settled') {
      return (
        <button type="button" className="row-action" aria-label="Un-settle thread" title="Un-settle" onClick={own(() => act(async () => await t3.unsettle(row.id)))}>
          <Undo2 size={ICON.sm} aria-hidden="true" />
        </button>
      );
    }
    if (row.section === 'snoozed') {
      return (
        <button type="button" className="row-action" aria-label="Wake thread now" title="Wake now" onClick={own(() => act(async () => await t3.unsnooze(row.id)))}>
          <AlarmClockOff size={ICON.xs} aria-hidden="true" />
        </button>
      );
    }
    // T3 refuses to snooze a thread that waits on the owner.
    const blocked = row.status === 'approval' || row.status === 'input' || row.status === 'guest';
    return (
      <>
        {blocked || slim ? null : (
          <button type="button" className="row-action" aria-label="Snooze thread" title="Snooze" aria-haspopup="menu" aria-expanded={snoozing === row.id} onClick={own(() => setSnoozing(snoozing === row.id ? undefined : row.id))}>
            <Clock size={ICON.xs} aria-hidden="true" />
          </button>
        )}
        <button type="button" className="row-action" aria-label="Settle thread" onClick={own(() => act(async () => await t3.settle(row.id)))}>
          <Check size={ICON.sm} aria-hidden="true" />
          {slim ? null : 'Settle'}
        </button>
      </>
    );
  };

  const renderRow = (row: ListRow): ReactNode => {
    const { title, project, provider } = describe(row);
    const lastAt = row.source === 'direct' ? row.run.updatedAt : Date.parse(row.shell.latestUserMessageAt ?? row.shell.updatedAt ?? '');
    const slim = row.section === 'snoozed' || row.section === 'settled';
    // A thread with nothing new to say reads quieter, as in T3.
    const read = row.status === undefined;
    const actions = actionsOf(row, slim);
    // The row is named by its thread, not by the actions inside it.
    const label = [title, project, row.status === undefined ? undefined : STATUS_LABEL[row.status]].filter((part) => part !== undefined).join(', ');
    const className = ['thread-row', slim ? 'slim' : 'card', read ? 'read' : ''].filter(Boolean).join(' ');
    return (
      <li className="thread-item" key={`${row.source}:${row.id}`}>
        <div
          role="button"
          tabIndex={0}
          className={className}
          aria-label={label}
          data-thread-item
          data-section={row.section}
          data-provider={provider?.driver}
          onClick={() => open(row)}
          onKeyDown={keys(row)}
        >
          {slim ? (
            <>
              <span className="thread-avatar">
                <ProjectAvatar name={project} />
              </span>
              <span className="thread-title">{title}</span>
              <span className="thread-status-slot">
                <span className="thread-status">{statusOf(row, lastAt, true)}</span>
                {actions === null ? null : <span className="thread-actions">{actions}</span>}
              </span>
            </>
          ) : (
            <>
              <span className="thread-row-top">
                <ProjectAvatar name={project} />
                {row.pinned ? <Pin size={ICON.xs} className="thread-pin" aria-label="Pinned" /> : null}
                <span className="thread-project">{project}</span>
                <span className="thread-status-slot">
                  <span className="thread-status">{statusOf(row, lastAt)}</span>
                  {actions === null ? null : <span className="thread-actions">{actions}</span>}
                </span>
              </span>
              <span className="thread-row-title">
                <span className="thread-title">{title}</span>
                {provider === undefined ? null : (
                  <span className="thread-provider">
                    <ProviderIcon driver={provider.driver} name={provider.name} size={ICON.sm} />
                  </span>
                )}
              </span>
            </>
          )}
        </div>
        {snoozing === row.id ? (
          <SnoozeMenu
            state={state}
            onClose={() => setSnoozing(undefined)}
            onPick={(until) => {
              setSnoozing(undefined);
              act(async () => await t3.snooze(row.id, until));
            }}
          />
        ) : null}
      </li>
    );
  };

  const shelf = (id: 'working' | 'snoozed' | 'settled', rows: ListRow[], count: number, expanded: boolean, toggle: () => void, more?: ReactNode): ReactNode => (
    <li className="shelf-group" key={id}>
      <button type="button" className="shelf" data-shelf={id} aria-expanded={expanded} onClick={toggle}>
        <span className="shelf-label">{SHELF_LABEL[id]}</span>
        <span className="shelf-fill" aria-hidden="true" />
        <span className="shelf-count">{count}</span>
        <ChevronDown size={ICON.xs} className={expanded ? 'shelf-chevron' : 'shelf-chevron closed'} aria-hidden="true" />
      </button>
      {expanded ? (
        <ul className="thread-rows">
          {rows.map(renderRow)}
          {more}
        </ul>
      ) : null}
    </li>
  );

  const searching = needle !== '';
  // A search looks through every section, in T3's order, whether its shelf is open or not.
  const matches = searching
    ? [...sections.pinned, ...sections.active, ...sections.working, ...sections.snoozed, ...sections.settled].filter((row) => {
        const { title, project } = describe(row);
        return title.toLowerCase().includes(needle) || project.toLowerCase().includes(needle);
      })
    : [];
  const total = sections.pinned.length + sections.active.length + sections.working.length + sections.snoozed.length + sections.settled.length;
  const settledRows = sections.settled.slice(0, settledShown);
  const settledHidden = sections.settled.length - settledRows.length;
  return (
    <div className="screen thread-list-screen" data-slot="sidebar">
      <Bar
        crumbs={['Threads']}
        threads={{ onClick: onClose, open: true }}
        actions={<BarActions onNew={() => onOpen({ name: 'home' })} onSettings={onSettings} />}
      />
      {/* T3's search row: the first row of the list, at the rows' inset; focused only when the owner clicks it. */}
      <div className="list-search-row">
        <label className="list-search">
          <Search size={ICON.md} aria-hidden="true" />
          <input aria-label="Search threads" placeholder="Search" value={query} onChange={(event) => setQuery(event.target.value)} />
        </label>
      </div>
      <div className="thread-list">
        {error === undefined ? null : <p className="error-line">{error}</p>}
        {searching ? (
          <ul className="thread-rows">
            {matches.map(renderRow)}
            {matches.length === 0 ? <li className="empty-line">No threads match.</li> : null}
          </ul>
        ) : (
          <>
            <ul className="thread-rows">
              {sections.pinned.map(renderRow)}
              {sections.pinned.length > 0 && sections.active.length > 0 ? <li className="pinned-divider" aria-hidden="true" /> : null}
              {sections.active.map(renderRow)}
              {total === 0 ? <li className="empty-line">No threads yet.</li> : null}
            </ul>
            {/* T3 keeps its shelves at the foot of the sidebar, under everything else. */}
            <ul className="shelves">
              {sections.working.length > 0 ? shelf('working', sections.working, sections.working.length, workingOpen, () => setWorkingOpen(!workingOpen)) : null}
              {sections.snoozed.length > 0 ? shelf('snoozed', sections.snoozed, sections.snoozed.length, snoozedOpen, () => setSnoozedOpen(!snoozedOpen)) : null}
              {state.status === 'off' && sections.settled.length === 0
                ? null
                : shelf(
                    'settled',
                    settledRows,
                    sections.settled.length,
                    settledOpen,
                    () => setSettledOpen(!settledOpen),
                    settledHidden > 0 ? (
                      <li>
                        <button type="button" className="shelf-more" onClick={() => setSettledShown(settledShown + SETTLED_MORE)}>
                          <ChevronDown size={ICON.md} aria-hidden="true" />
                          Show {Math.min(settledHidden, SETTLED_MORE)} more
                        </button>
                      </li>
                    ) : undefined,
                  )}
            </ul>
          </>
        )}
      </div>
      <ActiveSessions live={live} state={state} onOpen={onOpen} />
    </div>
  );
}
