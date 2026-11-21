import { ClaimStore } from './claims';
import { ChromeSitePermissionStore, PermissionPrompts, type PermissionPrompt } from './permissions';
import { SessionStore } from './sessions';

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
});

async function updatePermissionBadge(pending: PermissionPrompt[]): Promise<void> {
  const count = pending.length;
  await chrome.action.setBadgeText({ text: count === 0 ? '' : String(count) });
  if (count > 0) await chrome.action.setBadgeBackgroundColor({ color: '#b3261e' });
  await chrome.action.setTitle({
    title: count === 0 ? 'T3-Tab' : `${count} permission request${count === 1 ? '' : 's'} waiting`,
  });
}
