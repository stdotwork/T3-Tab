// The tab the extension opens once, when it is installed: one click opens the side panel here, so the owner does not
// have to find (or pin) the toolbar icon first, and copies the helper's setup command on the way.
import '../sidepanel/inter.css';
import '../sidepanel/styles.css';
import './welcome.css';

import { useEffect, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';

import { HELPER_COMMAND, HELPER_REQUIREMENT } from '../../src/helper-command';
import { openPanelOn } from '../../src/panel-tab';
import { CommandLine } from '../sidepanel/Setup';
import { errorText } from '../sidepanel/lib/api';
import { loadAppearance } from '../sidepanel/lib/theme';

function Welcome(): ReactNode {
  const [tabId, setTabId] = useState<number>();
  const [opened, setOpened] = useState(false);
  const [copied, setCopied] = useState<boolean>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    void chrome.tabs.getCurrent().then((tab) => setTabId(tab?.id));
  }, []);
  const open = (): void => {
    if (tabId === undefined) return;
    setError(undefined);
    // Both start in the click's own turn: the browser opens a side panel only for a user gesture.
    const copy = opened ? undefined : navigator.clipboard.writeText(HELPER_COMMAND);
    void openPanelOn(tabId).then(
      () => setOpened(true),
      (failure: unknown) => setError(`The panel did not open: ${errorText(failure)}`),
    );
    if (copy !== undefined) void copy.then(() => setCopied(true), () => setCopied(false));
  };
  return (
    <main className="welcome">
      <img className="welcome-icon" src="/icons/icon-128.png" width="48" height="48" alt="" />
      <h1>Welcome to T3-Tab</h1>
      <p className="welcome-lead">Your browser, as tools for your agents.</p>
      <p>T3-Tab reaches your agents through a small helper on this computer. Run this in a terminal, from any folder. {HELPER_REQUIREMENT}</p>
      <CommandLine />
      <button type="button" className="primary-btn" disabled={tabId === undefined} onClick={open}>
        {opened ? 'Open T3-Tab' : 'Copy the command and open T3-Tab'}
      </button>
      {opened ? (
        <p className="welcome-status" role="status">
          {copied === true ? 'Copied. Paste it in a terminal and run it; the panel connects by itself.' : 'Copy the command above and run it in a terminal; the panel connects by itself.'}
        </p>
      ) : null}
      {error === undefined ? null : <p className="error-line">{error}</p>}
      <p className="welcome-foot">Later, open T3-Tab from its toolbar icon. The browser keeps a new extension under the puzzle piece until you pin it.</p>
    </main>
  );
}

void loadAppearance().finally(() => {
  const host = document.querySelector('#app');
  if (host !== null) createRoot(host).render(<Welcome />);
});
