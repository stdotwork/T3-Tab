import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { SitePermission } from '../src/permissions';
import { forgetSecrets, rememberSecrets } from '../src/secret-text';
import type { SessionStore, StoredSession } from '../src/sessions';
import { adoptPopupTab, listTabs, switchSessionTab } from '../src/tabs';
import { FakeBrowser } from './fake-browser';

const browser = new FakeBrowser();

function sessionWith(fields: Partial<StoredSession>): StoredSession {
  return { id: 's1', name: 'Session', groupId: 5, sharedTabIds: [], approvedOrigins: {}, currentOrigins: {}, ...fields };
}

const noSettings = async (): Promise<SitePermission | undefined> => undefined;

beforeAll(() => browser.install());
beforeEach(() => browser.reset());

describe('what tabs list shows of a tab that took a secret into its address', () => {
  it('leaves out the values the extension saw in the tab\'s secret fields, from its title and address', async () => {
    browser.addTab({ id: 1, groupId: 5, url: 'https://shop.test/login?user=ada&pw=Tr0ub4dor%263', title: 'Hello Tr0ub4dor&3' });
    rememberSecrets(1, ['Tr0ub4dor&3']);
    try {
      const tabs = await listTabs(sessionWith({ approvedOrigins: { '1': ['https://shop.test'] } }), noSettings);
      expect(tabs[0]).toMatchObject({ title: 'Hello <redacted>', url: 'https://shop.test/login?user=ada&pw=<redacted>' });
      expect(JSON.stringify(tabs)).not.toContain('Tr0ub4dor');
    } finally {
      forgetSecrets(1);
    }
  });
});

describe('what tabs list and switch show for a member tab', () => {
  it('shows only the origin and that approval is needed for a tab whose origin the session has not approved', async () => {
    browser.addTab({ id: 1, groupId: 5, url: 'https://approved.test/inbox?id=7', title: 'Inbox (3)' });
    browser.addTab({ id: 2, groupId: 5, url: 'https://secret.test/account/balance?token=abc', title: 'Balance: 1,234' });
    const session = sessionWith({ approvedOrigins: { '1': ['https://approved.test'] } });

    const tabs = await listTabs(session, noSettings);
    expect(tabs.find((tab) => tab.id === 1)).toMatchObject({ title: 'Inbox (3)', url: 'https://approved.test/inbox?id=7' });
    const hidden = tabs.find((tab) => tab.id === 2);
    expect(hidden).toMatchObject({ title: '', url: 'https://secret.test', needsApproval: true });
    expect(JSON.stringify(hidden)).not.toMatch(/Balance|account|token/);
  });

  it('hides a tab that moved to an origin the session approved only for another tab, or earlier for another origin', async () => {
    browser.addTab({ id: 3, groupId: 5, url: 'https://moved.test/page', title: 'Moved' });
    const session = sessionWith({ approvedOrigins: { '3': ['https://before.test'], '9': ['https://moved.test'] } });
    const [tab] = await listTabs(session, noSettings);
    expect(tab).toMatchObject({ title: '', url: 'https://moved.test', needsApproval: true });
  });

  it('shows a tab on a site the owner allows reading on, but not one that is only set to ask', async () => {
    browser.addTab({ id: 4, groupId: 5, url: 'https://readable.test/a', title: 'Readable' });
    browser.addTab({ id: 5, groupId: 5, url: 'https://asked.test/a', title: 'Asked' });
    const settings = async (origin: string): Promise<SitePermission | undefined> =>
      origin === 'https://readable.test' ? 'read' : 'ask';
    const tabs = await listTabs(sessionWith({}), settings);
    expect(tabs.find((tab) => tab.id === 4)).toMatchObject({ title: 'Readable' });
    expect(tabs.find((tab) => tab.id === 5)).toMatchObject({ title: '', needsApproval: true });
  });

  it('applies the same rule when switching to a tab', async () => {
    browser.addTab({ id: 6, groupId: 5, url: 'https://unapproved.test/private', title: 'Private page' });
    (chrome.tabs as { update?: unknown }).update = async () => undefined;
    const tab = await switchSessionTab(sessionWith({}), 6, noSettings);
    expect(tab).toMatchObject({ id: 6, title: '', url: 'https://unapproved.test', needsApproval: true });
  });
});

describe('adopting a tab a page opened', () => {
  const store = (sessions: StoredSession[]): SessionStore => ({ list: async () => sessions }) as unknown as SessionStore;

  it('groups a tab opened from a tab in the session\'s group', async () => {
    browser.addTab({ id: 10, groupId: 5, url: 'https://work.test/' });
    browser.addTab({ id: 11, url: 'https://popup.test/' });
    await adoptPopupTab(11, 10, store([sessionWith({})]));
    expect(browser.groupCalls).toEqual([{ tabIds: [11], groupId: 5 }]);
  });

  it('leaves alone a tab opened from one of the owner\'s own tabs, even while a session runs code', async () => {
    browser.addTab({ id: 20, url: 'https://webmail.test/' });
    browser.addTab({ id: 21, url: 'https://link.test/' });
    await adoptPopupTab(21, 20, store([sessionWith({})]));
    expect(browser.groupCalls).toEqual([]);
  });

  it('puts a tab in the group of the session that owns its opener, not in another session\'s', async () => {
    browser.addTab({ id: 30, groupId: 8, url: 'https://other.test/' });
    browser.addTab({ id: 31, url: 'https://popup.test/' });
    await adoptPopupTab(31, 30, store([sessionWith({}), sessionWith({ id: 's2', groupId: 8 })]));
    expect(browser.groupCalls).toEqual([{ tabIds: [31], groupId: 8 }]);
  });

  it('survives an opener that has already closed', async () => {
    browser.addTab({ id: 41, url: 'https://popup.test/' });
    await expect(adoptPopupTab(41, 40, store([sessionWith({})]))).resolves.toBeUndefined();
    expect(browser.groupCalls).toEqual([]);
  });
});
