import { Check, Copy, Plug } from 'lucide-react';
import { useState, type ReactNode } from 'react';

import { HELPER_COMMAND, HELPER_REQUIREMENT } from '../../src/helper-command';
import { classifyHelperProblem } from '../../src/helper-problem';
import { errorText, panel } from './lib/api';
import type { LiveState } from './lib/store';
import { refreshSetup, useFreshSetup } from './lib/store';
import { t3, type T3State } from './lib/t3-client';
import { ProviderIcon, Spinner, T3Mark, ICON } from './ui';

const Ready = ({ text = 'Ready' }: { text?: string }): ReactNode => (
  <span className="state-ready">
    <Check size={ICON.sm} aria-hidden="true" />
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
        {copied ? <Check size={ICON.sm} aria-hidden="true" /> : <Copy size={ICON.sm} aria-hidden="true" />}
      </button>
    </div>
  );
}

/** What the helper row says and does. `command`: show the setup command; `detail`: what the browser reported. */
export interface HelperNote {
  text: string;
  /** A few words for the banner on other screens. */
  short: string;
  command: boolean;
  /** Something is under way and nothing is asked of the owner. */
  waiting?: boolean;
  detail?: string;
}

/**
 * What the panel tells the owner about the helper, and the one thing to do: the setup command, or one browser page.
 * It names the error the connection last hit; the plain "run this" text is only for a helper the browser has no record of.
 */
export function helperNote(live: LiveState): HelperNote {
  const { helper } = live;
  if (live.build === 'stuck') {
    return { text: 'This extension is still an old build and could not reload itself. Reload T3-Tab on your browser’s extensions page.', short: 'the extension is an old build', command: false };
  }
  if (live.build === 'reloading') return { text: 'Updating the extension', short: 'updating the extension', command: false, waiting: true };
  if (helper.connected) return { text: 'Running', short: '', command: false };
  if (!live.loaded) return { text: 'Looking for the helper', short: 'looking for it', command: false, waiting: true };
  const problem = helper.problem ?? classifyHelperProblem(helper.error);
  const detail = helper.error;
  switch (problem) {
    case 'pending':
      return { text: 'Connecting to the helper', short: 'connecting', command: false, waiting: true };
    case 'extension-outdated':
      return { text: 'This extension is older than the helper. Reload T3-Tab on your browser’s extensions page, or update it.', short: 'the extension is out of date', command: false, ...(detail === undefined ? {} : { detail }) };
    case 'helper-outdated':
      return { text: 'The helper on this machine is older than this extension. Run this to update it:', short: 'the helper is out of date', command: true, ...(detail === undefined ? {} : { detail }) };
    case 'blocked':
      return { text: 'The helper on this machine does not know this extension. Run this again to update it:', short: 'it does not know this extension', command: true, ...(detail === undefined ? {} : { detail }) };
    case 'failed':
      return { text: `The browser started the helper and it stopped. ${HELPER_REQUIREMENT} Run this again:`, short: 'it would not start', command: true, ...(detail === undefined ? {} : { detail }) };
    case 'connection':
      return { text: 'The helper is installed, but the browser could not connect to it. Running this again restarts it:', short: 'the browser could not reach it', command: true, ...(detail === undefined ? {} : { detail }) };
    case 'unknown':
      return { text: 'The browser reported a problem with the helper. Running this again usually fixes it:', short: detail ?? 'the browser reported a problem', command: true, ...(detail === undefined ? {} : { detail }) };
    default:
      // The usual first run: nothing has failed, so the browser's "host not found" is not worth showing.
      return { text: `Run this in a terminal, from any folder. ${HELPER_REQUIREMENT}`, short: 'it is not installed', command: true };
  }
}

/** The helper's row and, while it is not connected and a command helps, the command to copy. */
export function HelperStep({ live, icon = true }: { live: LiveState; icon?: boolean }): ReactNode {
  const note = helperNote(live);
  const ready = live.helper.connected && live.build !== 'stuck' && live.build !== 'reloading';
  return (
    <>
      <div className={note.command ? 'setup-row helper-row' : 'setup-row'}>
        {icon ? (
          <span className="setup-icon">
            <Plug size={ICON.lg} aria-hidden="true" />
          </span>
        ) : null}
        <span className="setup-text">
          <strong>T3-Tab helper</strong>
          <small>{note.text}</small>
          {note.detail === undefined ? null : <small className="helper-detail">The browser said: {note.detail}</small>}
        </span>
        {ready ? <Ready /> : note.waiting === true ? <Spinner /> : null}
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
        <ProviderIcon driver={id === 'claude' ? 'claudeAgent' : 'codex'} size={ICON.lg} />
      </span>
      <span className="setup-text">
        <strong>{name}</strong>
        <small>{error ?? (agent === undefined ? 'Waiting for the helper' : !agent.found ? 'Not installed' : agent.registered ? `Sessions you start in ${name} can use this browser` : `Add to use this browser from sessions you start in ${name}`)}</small>
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
            : live.helper.connected
              ? 'Looking for T3 Code'
              : 'Checked once the helper is running');
  return (
    <div className="setup-row">
      <span className="setup-icon">
        <T3Mark size={ICON.lg} />
      </span>
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
  useFreshSetup();
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
        <h2>Your own agents</h2>
        <p className="setup-hint">Optional. Threads started in this panel work without it.</p>
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
