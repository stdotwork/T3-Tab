import { PROTOCOL_VERSION } from '@t3-tab/protocol';

import { ClaimStore } from './claims';
import { askDaemon, sendPromptNotice } from './daemon-link';
import { ChromeSitePermissionStore, PermissionPrompts, type PermissionPrompt } from './permissions';
import { SessionStore } from './sessions';
import { t3FullAccess } from './t3-full-access';

export const sessionStore = new SessionStore();
export const siteStore = new ChromeSitePermissionStore();
export const claimStore = new ClaimStore();

const DEFAULT_PERMISSION_TIMEOUT_MS = 60_000;

export const permissionPrompts = new PermissionPrompts(siteStore, {
  timeoutMs: async () => {
    const stored = await chrome.storage.local.get('permissionTimeoutMs');
    const value = stored.permissionTimeoutMs;
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : DEFAULT_PERMISSION_TIMEOUT_MS;
  },
  onChange: (pending) => void updatePermissionBadge(pending).catch(() => undefined),
  // The agent's own thread can show the prompt too; the background program tells the session that asked.
  onOpen: ({ session, ...prompt }) =>
    sendPromptNotice({ type: 'browser.promptOpened', protocolVersion: PROTOCOL_VERSION, session, prompt }),
  onClose: (promptId) => sendPromptNotice({ type: 'browser.promptClosed', protocolVersion: PROTOCOL_VERSION, promptId }),
  fullAccess: t3FullAccess(
    async (sessionId) => await claimStore.t3ThreadsOf(sessionId, (await sessionStore.get(sessionId))?.t3ThreadId),
    async (threadId) => (await askDaemon('t3.threadMode', { threadId })).runtimeMode,
  ),
});

async function updatePermissionBadge(pending: PermissionPrompt[]): Promise<void> {
  const count = pending.length;
  await chrome.action.setBadgeText({ text: count === 0 ? '' : String(count) });
  if (count > 0) await chrome.action.setBadgeBackgroundColor({ color: '#b3261e' });
  await chrome.action.setTitle({
    title: count === 0 ? 'T3-Tab' : `${count} permission request${count === 1 ? '' : 's'} waiting`,
  });
}
