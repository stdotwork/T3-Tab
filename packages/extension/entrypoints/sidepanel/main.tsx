import '@fontsource-variable/inter';
import './styles.css';

import { createRoot } from 'react-dom/client';

import type { PermissionPrompt, StoredSitePermission } from '../../src/permissions';
import type { PanelTab } from '../../src/panel';
import { App } from './App';
import { applyHeadlessState, headlessRender, type AutoAllowed } from './lib/store';
import { loadAppearance } from './lib/theme';

// The end-to-end run draws prompts and the site list from state it supplies.
if (headlessRender) {
  (globalThis as typeof globalThis & { __t3tabRenderPanelState?: (state: { currentTab?: PanelTab; pending: PermissionPrompt[]; sites: StoredSitePermission[]; autoAllowed?: AutoAllowed[] }) => void }).__t3tabRenderPanelState =
    applyHeadlessState;
}

void loadAppearance().finally(() => {
  const host = document.querySelector('#app');
  if (host !== null) createRoot(host).render(<App />);
});
