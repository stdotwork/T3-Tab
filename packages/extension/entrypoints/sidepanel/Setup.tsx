import { Check, Copy, Plug } from 'lucide-react';
import { useState, type ReactNode } from 'react';

import { errorText, panel } from './lib/api';
import type { LiveState } from './lib/store';
import { refreshSetup } from './lib/store';
import { t3, type T3State } from './lib/t3-client';
import { ProviderIcon, Spinner } from './ui';

export const HELPER_COMMAND = 'pnpm exec t3-tab native-host install';

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
      <code>{HELPER_COMMAND}</code>
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
        <div className="setup-row">
          <span className="setup-icon">
            <Plug size={17} aria-hidden="true" />
          </span>
          <span className="setup-text">
            <strong>T3-Tab helper</strong>
            <small>{helperReady ? 'Running' : live.helper.protocolMismatch === true ? 'Out of date. Run this again, then reload the extension.' : 'Connects this browser to your agents. Run this once in the T3-Tab folder:'}</small>
          </span>
          {helperReady ? <Ready /> : <Spinner />}
        </div>
        {helperReady ? null : <CommandLine />}
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
