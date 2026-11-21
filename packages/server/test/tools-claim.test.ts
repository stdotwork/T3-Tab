import type { BrowserMethod, TabInfo } from '@t3-tab/protocol';
import { describe, expect, it } from 'vitest';

import type { BrowserLink } from '../src/browser-link.js';
import { TabState } from '../src/reader/page.js';
import { runTool } from '../src/tools.js';

const SESSION = { id: 's', name: 'Session s' };
const first: TabInfo = { id: 4, title: 'First', url: 'http://localhost/a', active: true };

function link(failClaim = false): BrowserLink & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    request: async (_session, method: BrowserMethod, params) => {
      calls.push(`${method} ${JSON.stringify(params)}`);
      if (method === 'session.claim') {
        if (failClaim) throw new Error('Unknown claim code');
        return { shared: [4] } as never;
      }
      if (method === 'tabs.list') return { tabs: [first] } as never;
      throw new Error(`unexpected ${method}`);
    },
    tabState: () => new TabState(),
    forgetTab: () => undefined,
  };
}

describe('tabs tool with a claim', () => {
  it('sends session.claim before listing tabs', async () => {
    const browser = link();
    expect(await runTool(browser, SESSION, 'tabs', { claim: 'abcdefghijklmnop1234' })).toEqual([
      { type: 'text', text: '4 [front] First — http://localhost/a' },
    ]);
    expect(browser.calls).toEqual(['session.claim {"code":"abcdefghijklmnop1234","route":"message"}', 'tabs.list {}']);
  });

  it('sends no claim when none is given', async () => {
    const browser = link();
    await runTool(browser, SESSION, 'tabs', {});
    expect(browser.calls).toEqual(['tabs.list {}']);
  });

  it('fails the call, without listing, when the claim is refused', async () => {
    const browser = link(true);
    await expect(runTool(browser, SESSION, 'tabs', { claim: 'abcdefghijklmnop1234' })).rejects.toThrow('Unknown claim code');
    expect(browser.calls).toEqual(['session.claim {"code":"abcdefghijklmnop1234","route":"message"}']);
  });
});
