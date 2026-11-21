import type { BrowserMethod, BrowserMethods, TabInfo } from '@t3-tab/protocol';
import { describe, expect, it } from 'vitest';

import type { BrowserLink } from '../src/browser-link.js';
import { TabState } from '../src/reader/page.js';
import { runTool } from '../src/tools.js';
import { buttonPage, page } from './ax-fixtures.js';

type Handlers = { [M in BrowserMethod]?: (params: BrowserMethods[M]['params']) => BrowserMethods[M]['result'] };

function fakeBrowser(handlers: Handlers): BrowserLink & { calls: string[]; forgotten: number[] } {
  const states = new Map<number, TabState>();
  const calls: string[] = [];
  const forgotten: number[] = [];
  return {
    calls,
    forgotten,
    request: async (method, params) => {
      calls.push(`${method} ${JSON.stringify(params)}`);
      const handler = handlers[method] as ((params: unknown) => unknown) | undefined;
      if (handler === undefined) throw new Error(`unexpected ${method}`);
      return handler(params) as never;
    },
    tabState: (tabId) => {
      let state = states.get(tabId);
      if (state === undefined) {
        state = new TabState();
        states.set(tabId, state);
      }
      return state;
    },
    forgetTab: (tabId) => {
      forgotten.push(tabId);
    },
  };
}

const first: TabInfo = { id: 4, title: 'First', url: 'http://localhost/a', active: true };
const second: TabInfo = { id: 9, title: 'Second', url: 'http://localhost/b', active: false };

describe('tabs tool', () => {
  it('lists tabs as short lines and marks the front one', async () => {
    const link = fakeBrowser({ 'tabs.list': () => ({ tabs: [first, second] }) });
    expect(await runTool(link, 's', 'tabs', {})).toEqual([
      { type: 'text', text: '4 [front] First — http://localhost/a\n9 Second — http://localhost/b' },
    ]);
  });

  it('opens, switches and closes', async () => {
    const link = fakeBrowser({
      'tabs.open': () => ({ tab: second }),
      'tabs.switch': () => ({ tab: first }),
      'tabs.close': (params) => ({ closed: params.tab }),
    });
    expect(await runTool(link, 's', 'tabs', { action: 'open', url: 'http://localhost/b' })).toEqual([
      { type: 'text', text: 'Opened tab 9 Second — http://localhost/b' },
    ]);
    expect(await runTool(link, 's', 'tabs', { action: 'switch', tab: 4 })).toEqual([
      { type: 'text', text: 'Switched to tab 4 [front] First — http://localhost/a' },
    ]);
    expect(await runTool(link, 's', 'tabs', { action: 'close', tab: 9 })).toEqual([{ type: 'text', text: 'Closed tab 9.' }]);
    expect(link.forgotten).toEqual([9]);
  });

  it('refuses calls that miss what the action needs, before asking the browser', async () => {
    const link = fakeBrowser({});
    await expect(runTool(link, 's', 'tabs', { action: 'open' })).rejects.toThrow('open needs a url');
    await expect(runTool(link, 's', 'tabs', { action: 'close' })).rejects.toThrow('close needs a tab id');
    await expect(runTool(link, 's', 'tabs', { action: 'burn' })).rejects.toThrow(/Invalid arguments: action/);
    expect(link.calls).toEqual([]);
  });
});

describe('read tool', () => {
  it('reads the front tab by default and a diff the second time', async () => {
    const link = fakeBrowser({ 'page.read': () => page(buttonPage(30)) });
    const firstReply = await runTool(link, 's', 'read', {});
    expect(firstReply[0]).toMatchObject({ type: 'text' });
    const secondReply = await runTool(link, 's', 'read', {});
    expect(secondReply).toEqual([
      { type: 'text', text: 'tab 7: Test page — http://localhost/test\nNo changes since the last read.' },
    ]);
    expect(link.calls[0]).toBe('page.read {}');
  });

  it('passes the tab and rejects malformed arguments', async () => {
    const link = fakeBrowser({ 'page.read': () => page(buttonPage(3)) });
    await runTool(link, 's', 'read', { tab: 12 });
    expect(link.calls[0]).toBe('page.read {"tab":12}');
    await expect(runTool(link, 's', 'read', { ref: 'button' })).rejects.toThrow(/Unknown ref button/);
    await expect(runTool(link, 's', 'read', { depth: -1 })).rejects.toThrow(/Invalid arguments: depth/);
    await expect(runTool(link, 's', 'read', { all: 'yes' })).rejects.toThrow(/Invalid arguments: all/);
  });
});

describe('screenshot tool', () => {
  it('asks for a 1280 pixel long edge unless told otherwise, and returns a JPEG image', async () => {
    const link = fakeBrowser({
      'page.screenshot': (params) => ({
        tab: 4,
        data: 'AAAA',
        width: Math.min(params.maxEdge, 1600),
        height: 450,
        viewportWidth: 1600,
        viewportHeight: 900,
      }),
    });
    expect(await runTool(link, 's', 'screenshot', {})).toEqual([
      { type: 'text', text: 'tab 4: 1280x450 (viewport 1600x900)' },
      { type: 'image', data: 'AAAA', mimeType: 'image/jpeg' },
    ]);
    await runTool(link, 's', 'screenshot', { maxEdge: 640, tab: 4 });
    expect(link.calls).toEqual([
      'page.screenshot {"maxEdge":1280}',
      'page.screenshot {"tab":4,"maxEdge":640}',
    ]);
    await expect(runTool(link, 's', 'screenshot', { maxEdge: 10 })).rejects.toThrow(/Invalid arguments: maxEdge/);
  });
});
