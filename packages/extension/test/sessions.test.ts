import { describe, expect, it } from 'vitest';

import {
  assertSessionTab,
  canSessionUseTab,
  groupTitle,
  hasApprovedOrigin,
  sessionForPopup,
  usableSessionTabs,
  type StoredSession,
} from '../src/sessions';

const session: StoredSession = {
  id: 'session-a',
  name: 'Session A',
  groupId: 12,
  sharedTabIds: [22],
  approvedOrigins: {},
  currentOrigins: {},
};

describe('session tab ownership', () => {
  it('allows only tabs in the session group or explicitly shared', () => {
    expect(canSessionUseTab(session, { id: 1, groupId: 12 })).toBe(true);
    expect(canSessionUseTab(session, { id: 22, groupId: -1 })).toBe(true);
    expect(canSessionUseTab(session, { id: 33, groupId: 15 })).toBe(false);
    expect(canSessionUseTab(session, { id: 44 })).toBe(false);
  });

  it('refuses an outside tab with a clear message', () => {
    expect(() => assertSessionTab(session, { id: 33, groupId: 15 })).toThrow(
      'Tab 33 is not available to this session. Only tabs in its tab group or tabs the owner shared can be used.',
    );
  });

  it('filters the tab list to usable, regular pages', () => {
    const tabs = [
      { id: 1, groupId: 12, url: 'https://one.test/' },
      { id: 22, groupId: -1, url: 'https://shared.test/' },
      { id: 33, groupId: 15, url: 'https://other.test/' },
      { id: 44, groupId: 12, url: 'chrome://version' },
    ] as chrome.tabs.Tab[];
    expect(usableSessionTabs(session, tabs).map((tab) => tab.id)).toEqual([1, 22]);
  });

  it('keeps group titles within the Chromium limit', () => {
    expect(groupTitle('short')).toBe('short');
    expect(groupTitle('x'.repeat(100))).toHaveLength(48);
  });
});

describe('which session a popup belongs to', () => {
  const other: StoredSession = { ...session, id: 'session-b', name: 'Session B', groupId: 13, sharedTabIds: [] };

  it('is the session whose tab group the opener is in', () => {
    expect(sessionForPopup([session, other], { id: 1, groupId: 12 })?.id).toBe('session-a');
    expect(sessionForPopup([session, other], { id: 2, groupId: 13 })?.id).toBe('session-b');
  });

  it('is nobody\'s when the opener is an ungrouped tab the owner has not shared', () => {
    expect(sessionForPopup([session, other], { id: 77, groupId: -1 })).toBeUndefined();
    expect(sessionForPopup([session, other], { id: 78 })).toBeUndefined();
  });

  it('follows a shared opener only when exactly one session with a group has it', () => {
    expect(sessionForPopup([session, other], { id: 22, groupId: -1 })?.id).toBe('session-a');
    const alsoShared: StoredSession = { ...other, sharedTabIds: [22] };
    expect(sessionForPopup([session, alsoShared], { id: 22, groupId: -1 })).toBeUndefined();
    const noGroup: StoredSession = { id: 'session-c', name: 'Session C', sharedTabIds: [22], approvedOrigins: {}, currentOrigins: {} };
    expect(sessionForPopup([noGroup], { id: 22, groupId: -1 })).toBeUndefined();
  });

  it('prefers the group of an opener that is also shared with another session', () => {
    const sharedWithOther: StoredSession = { ...other, sharedTabIds: [1] };
    expect(sessionForPopup([session, sharedWithOther], { id: 1, groupId: 12 })?.id).toBe('session-a');
  });
});

describe('approved origins per tab', () => {
  it('counts only the origin approved for that tab', () => {
    const approved: StoredSession = { ...session, approvedOrigins: { '1': ['https://one.test'] } };
    expect(hasApprovedOrigin(approved, 1, 'https://one.test')).toBe(true);
    expect(hasApprovedOrigin(approved, 1, 'https://two.test')).toBe(false);
    expect(hasApprovedOrigin(approved, 2, 'https://one.test')).toBe(false);
  });
});
