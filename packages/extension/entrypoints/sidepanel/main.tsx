import '@fontsource-variable/inter';
import './styles.css';

import { createRoot } from 'react-dom/client';

import type { PermissionPrompt, StoredSitePermission } from '../../src/permissions';
import type { PanelTab } from '../../src/panel';
import { App } from './App';
import { guardPanelDrops } from './Composer';
import { applyHeadlessState, headlessRender, type AutoAllowed } from './lib/store';
import { t3 } from './lib/t3-client';
import { loadAppearance } from './lib/theme';

// The end-to-end run draws prompts and the site list from state it supplies.
if (headlessRender) {
  (globalThis as typeof globalThis & { __t3tabRenderPanelState?: (state: { currentTab?: PanelTab; pending: PermissionPrompt[]; sites: StoredSitePermission[]; autoAllowed?: AutoAllowed[] }) => void }).__t3tabRenderPanelState =
    applyHeadlessState;
}

// The harness that carries the panel's requests can also answer a thread's request the way T3's own app would.
if (window.__t3tabPanelBridge !== undefined) (globalThis as typeof globalThis & { __t3tabT3?: typeof t3 }).__t3tabT3 = t3;

guardPanelDrops();

void loadAppearance().finally(() => {
  const host = document.querySelector('#app');
  if (host !== null) createRoot(host).render(<App />);
});
