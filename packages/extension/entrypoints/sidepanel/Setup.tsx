import { Check, Copy, Plug } from 'lucide-react';
import { useState, type ReactNode } from 'react';

import { HELPER_COMMAND, HELPER_REQUIREMENT } from '../../src/helper-command';
import { errorText, panel } from './lib/api';
import type { LiveState } from './lib/store';
import { refreshSetup } from './lib/store';
import { t3, type T3State } from './lib/t3-client';
import { ProviderIcon, Spinner } from './ui';


const Ready = ({ text = 'Ready' }: { text?: string }): ReactNode => (
  <span className="state-ready">
    <Check size={14} aria-hidden="true" />
    {text}
  </span>
);

export function CommandLine(): ReactNode {
  const [copied, setCopied] = useState(false);
  return (
    <div className="command-line">
      <code>
        {HELPER_COMMAND.split(/(?<=[/|])/).map((part, index) => (
          // A long command breaks after a slash, not in the middle of a word. Copy still copies the whole command.
          <span key={index}>
            {index > 0 ? <wbr /> : null}
            {part}
          </span>
        ))}
      </code>
      <button
        type="button"
        aria-label={copied ? 'Copied' : 'Copy command'}
        title={copied ? 'Copied' : 'Copy'}
        onClick={() => {
          void navigator.clipboard.writeText(HELPER_COMMAND).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          });
        }}
      >
        {copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
      </button>
    </div>
  );
}

const OUTDATED_HELPER = 'This extension is newer than the helper on this machine. Run this to update it:';

/** What the panel tells the owner about the helper, and what to do: one command, or one browser page, never both. */
export function helperNote(live: LiveState): { text: string; command: boolean } {
  const { helper } = live;
  if (helper.connected) return { text: 'Running', command: false };
  if (!live.loaded) return { text: 'Looking for the helper', command: false };
  switch (helper.problem) {
    case 'extension-outdated':
      return { text: 'This extension is older than the helper. Update T3-Tab on your browser’s extensions page.', command: false };
    case 'helper-outdated':
      return { text: OUTDATED_HELPER, command: true };
    case 'blocked':
      return { text: 'The helper on this machine does not know this extension. Run this again to update it:', command: true };
    case 'failed':
      return { text: `The helper is installed but would not start. ${HELPER_REQUIREMENT} Run this again:`, command: true };
    default:
      return { text: `Run this in a terminal, from any folder. ${HELPER_REQUIREMENT}`, command: true };
  }
}

/** The helper's row and, while it is not connected and a command helps, the command to copy. */
export function HelperStep({ live, icon = true }: { live: LiveState; icon?: boolean }): ReactNode {
  const note = helperNote(live);
  const ready = live.helper.connected;
  return (
    <>
      <div className={note.command ? 'setup-row helper-row' : 'setup-row'}>
        {icon ? (
          <span className="setup-icon">
            <Plug size={17} aria-hidden="true" />
          </span>
        ) : null}
        <span className="setup-text">
          <strong>T3-Tab helper</strong>
          <small>{note.text}</small>
        </span>
        {ready ? <Ready /> : live.helper.problem === 'extension-outdated' ? null : <Spinner />}
      </div>
      {note.command ? <CommandLine /> : null}
    </>
  );
}

export function AgentRow({ id, live }: { id: 'claude' | 'codex'; live: LiveState }): ReactNode {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const agent = live.setup?.agents.find((entry) => entry.id === id);
  const name = id === 'claude' ? 'Claude Code' : 'Codex';
  const add = async (): Promise<void> => {
    setBusy(true);
    setError(undefined);
    try {
      await panel({ type: 'panel.addAgent', agent: id });
      await refreshSetup(true);
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="setup-row">
      <span className="setup-icon">
        <ProviderIcon driver={id === 'claude' ? 'claudeAgent' : 'codex'} size={18} />
      </span>
      <span className="setup-text">
        <strong>{name}</strong>
        <small>{error ?? (agent === undefined ? 'Waiting for the helper' : !agent.found ? 'Not installed' : agent.registered ? 'Has the browser tools' : 'Add the browser tools')}</small>
      </span>
      {agent?.registered === true ? (
        <Ready />
      ) : agent?.found === true ? (
        <button type="button" className="row-btn" disabled={busy} onClick={() => void add()}>
          {busy ? <Spinner /> : 'Add'}
        </button>
      ) : null}
    </div>
  );
}

export function T3Row({ live, state }: { live: LiveState; state: T3State }): ReactNode {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const found = live.setup?.t3.state;
  const connect = async (): Promise<void> => {
    setBusy(true);
    setError(undefined);
    try {
      await t3.pair();
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(false);
    }
  };
  const connected = state.status === 'ready';
  const note =
    error ??
    state.error ??
    (connected
      ? (state.origin ?? 'Connected')
      : found === 'running'
        ? 'Found on this machine'
        : found === 'stopped'
          ? 'Installed, not running. Threads use Claude Code or Codex directly.'
          : found === 'missing'
            ? 'Not installed. Threads use Claude Code or Codex directly.'
            : 'Looking for T3 Code');
  return (
    <div className="setup-row">
      <span className="setup-icon t3-mark">T3</span>
      <span className="setup-text">
        <strong>T3 Code</strong>
        <small>{note}</small>
      </span>
      {connected ? (
        <Ready text="Connected" />
      ) : found === 'running' ? (
        <button type="button" className="row-btn" disabled={busy || state.status === 'connecting'} onClick={() => void connect()}>
          {busy || state.status === 'connecting' ? <Spinner /> : 'Connect'}
        </button>
      ) : null}
    </div>
  );
}

export function Setup({ live, state, onDone }: { live: LiveState; state: T3State; onDone: () => void }): ReactNode {
  const helperReady = live.helper.connected;
  const anyAgent = live.setup?.agents.some((agent) => agent.found) === true || state.status === 'ready';
  return (
    <main className="setup">
      <header>
        <h1>Welcome to T3-Tab</h1>
        <p>Your browser, as tools for your agents.</p>
      </header>
      <section>
        <h2>Helper</h2>
        <HelperStep live={live} />
      </section>
      <section>
        <h2>Agents</h2>
        <AgentRow id="claude" live={live} />
        <AgentRow id="codex" live={live} />
      </section>
      <section>
        <h2>T3 Code</h2>
        <T3Row live={live} state={state} />
      </section>
      <footer>
        <button type="button" className="primary-btn" disabled={!helperReady || !anyAgent} onClick={onDone}>
          Start
        </button>
      </footer>
    </main>
  );
}
