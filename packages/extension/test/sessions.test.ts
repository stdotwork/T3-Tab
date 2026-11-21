import { describe, expect, it } from 'vitest';

import {
  assertSessionTab,
  canSessionUseTab,
  groupTitle,
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
