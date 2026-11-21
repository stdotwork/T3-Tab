import { ChromeSitePermissionStore, PermissionPrompts, type PermissionPrompt } from './permissions';
import { SessionStore } from './sessions';

export const sessionStore = new SessionStore();
export const siteStore = new ChromeSitePermissionStore();

export const permissionPrompts = new PermissionPrompts(siteStore, {
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
