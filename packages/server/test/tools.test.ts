import type { BrowserMethod, BrowserMethods, TabInfo } from '@t3-tab/protocol';
import { describe, expect, it } from 'vitest';

import type { BrowserLink } from '../src/browser-link.js';
import { TabState } from '../src/reader/page.js';
import { runTool } from '../src/tools.js';
import { buttonPage, page, signInPage } from './ax-fixtures.js';

type Handlers = { [M in BrowserMethod]?: (params: BrowserMethods[M]['params']) => BrowserMethods[M]['result'] };

function fakeBrowser(handlers: Handlers): BrowserLink & { calls: string[]; forgotten: number[] } {
  const states = new Map<number, TabState>();
  const calls: string[] = [];
  const forgotten: number[] = [];
  return {
    calls,
    forgotten,
    request: async (_session, method, params) => {
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

const SESSION = { id: 's', name: 'Session s' };

const first: TabInfo = { id: 4, title: 'First', url: 'http://localhost/a', active: true };
const second: TabInfo = { id: 9, title: 'Second', url: 'http://localhost/b', active: false };

describe('tabs tool', () => {
  it('lists tabs as short lines and marks the front one', async () => {
    const link = fakeBrowser({ 'tabs.list': () => ({ tabs: [first, second] }) });
    expect(await runTool(link, SESSION, 'tabs', {})).toEqual([
      { type: 'text', text: '4 [front] First — http://localhost/a\n9 Second — http://localhost/b' },
    ]);
  });

  it('shows only the origin and that approval is needed for a tab the session has not approved', async () => {
    const hidden: TabInfo = { id: 7, title: '', url: 'http://mail.test', active: true, needsApproval: true };
    const link = fakeBrowser({
      'tabs.list': () => ({ tabs: [hidden, second] }),
      'tabs.switch': () => ({ tab: hidden }),
    });
    expect(await runTool(link, SESSION, 'tabs', {})).toEqual([
      { type: 'text', text: '7 [front] [needs approval] http://mail.test\n9 Second — http://localhost/b' },
    ]);
    expect(await runTool(link, SESSION, 'tabs', { action: 'switch', tab: 7 })).toEqual([
      { type: 'text', text: 'Switched to tab 7 [front] [needs approval] http://mail.test' },
    ]);
  });

  it('opens, switches and closes', async () => {
    const link = fakeBrowser({
      'tabs.open': () => ({ tab: second }),
      'tabs.switch': () => ({ tab: first }),
      'tabs.close': (params) => ({ closed: params.tab }),
    });
    expect(await runTool(link, SESSION, 'tabs', { action: 'open', url: 'http://localhost/b' })).toEqual([
      { type: 'text', text: 'Opened tab 9 Second — http://localhost/b' },
    ]);
    expect(await runTool(link, SESSION, 'tabs', { action: 'switch', tab: 4 })).toEqual([
      { type: 'text', text: 'Switched to tab 4 [front] First — http://localhost/a' },
    ]);
    expect(await runTool(link, SESSION, 'tabs', { action: 'close', tab: 9 })).toEqual([{ type: 'text', text: 'Closed tab 9.' }]);
    expect(link.forgotten).toEqual([9]);
  });

  it('refuses calls that miss what the action needs, before asking the browser', async () => {
    const link = fakeBrowser({});
    await expect(runTool(link, SESSION, 'tabs', { action: 'open' })).rejects.toThrow('open needs a url');
    await expect(runTool(link, SESSION, 'tabs', { action: 'close' })).rejects.toThrow('close needs a tab id');
    await expect(runTool(link, SESSION, 'tabs', { action: 'burn' })).rejects.toThrow(/Invalid arguments: action/);
    expect(link.calls).toEqual([]);
  });
});

describe('read tool', () => {
  it('reads the front tab by default and a diff the second time', async () => {
    const link = fakeBrowser({ 'page.read': () => page(buttonPage(30)) });
    const firstReply = await runTool(link, SESSION, 'read', {});
    expect(firstReply[0]).toMatchObject({ type: 'text' });
    const secondReply = await runTool(link, SESSION, 'read', {});
    expect(secondReply).toEqual([
      { type: 'text', text: 'tab 7: Test page — http://localhost/test\nNo changes since the last read.' },
    ]);
    expect(link.calls[0]).toBe('page.read {}');
  });

  it('passes the tab and rejects malformed arguments', async () => {
    const link = fakeBrowser({ 'page.read': () => page(buttonPage(3)) });
    await runTool(link, SESSION, 'read', { tab: 12 });
    expect(link.calls[0]).toBe('page.read {"tab":12}');
    await expect(runTool(link, SESSION, 'read', { ref: 'button' })).rejects.toThrow(/Unknown ref button/);
    await expect(runTool(link, SESSION, 'read', { depth: -1 })).rejects.toThrow(/Invalid arguments: depth/);
    await expect(runTool(link, SESSION, 'read', { all: 'yes' })).rejects.toThrow(/Invalid arguments: all/);
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
    expect(await runTool(link, SESSION, 'screenshot', {})).toEqual([
      { type: 'text', text: 'tab 4: 1280x450 (viewport 1600x900)' },
      { type: 'image', data: 'AAAA', mimeType: 'image/jpeg' },
    ]);
    await runTool(link, SESSION, 'screenshot', { maxEdge: 640, tab: 4 });
    expect(link.calls).toEqual([
      'page.screenshot {"maxEdge":1280}',
      'page.screenshot {"tab":4,"maxEdge":640}',
    ]);
    await expect(runTool(link, SESSION, 'screenshot', { maxEdge: 10 })).rejects.toThrow(/Invalid arguments: maxEdge/);
  });
});

describe('act tool', () => {
  it('sends a batch with resolved backend ids and returns the page diff', async () => {
    const initial = signInPage();
    const changed = initial.map((node) => (node.id === '5' ? { ...node, value: 'grace@example.com' } : node));
    let batch: Record<string, unknown> | undefined;
    const link = fakeBrowser({
      'page.read': () => page(initial),
      'page.act': (params) => {
        batch = params as unknown as Record<string, unknown>;
        return page(changed);
      },
    });
    await runTool(link, SESSION, 'read', {});
    const reply = await runTool(link, SESSION, 'act', {
      tab: 7,
      steps: [
        { fill: { ref: 'e2', value: 'grace@example.com' } },
        { click: { ref: 'e3' } },
      ],
    });
    expect(reply[0]).toMatchObject({ type: 'text' });
    expect((reply[0] as { text: string }).text).toContain('e2 textbox "Email" value="grace@example.com" [required]');
    expect(batch).toMatchObject({
      tab: 7,
      epoch: 1,
      backendIds: [5, 6],
      steps: [
        { fill: { ref: 'e2', value: 'grace@example.com' } },
        { click: { ref: 'e3' } },
      ],
    });
  });

  it('uses the front tab when no tab is given', async () => {
    const link = fakeBrowser({
      'tabs.list': () => ({ tabs: [second] }),
      'page.read': () => page(signInPage()),
      'page.act': () => page(signInPage()),
    });
    await runTool(link, SESSION, 'read', {});
    await runTool(link, SESSION, 'act', { steps: [{ press: { key: 'Enter' } }] });
    expect(link.calls).toContain('tabs.list {}');
    expect(link.calls.at(-1)).toContain('page.act {"tab":9');
  });

  it('refuses an unknown ref before sending the batch', async () => {
    const link = fakeBrowser({ 'page.read': () => page(signInPage()) });
    await runTool(link, SESSION, 'read', {});
    await expect(runTool(link, SESSION, 'act', { tab: 7, steps: [{ click: { ref: 'e99' } }] })).rejects.toThrow(
      'Unknown ref e99: read the page again',
    );
    expect(link.calls).toHaveLength(1);
  });

  it('names the failed step and includes the page diff after navigation', async () => {
    const link = fakeBrowser({
      'page.read': () => page(signInPage()),
      'page.act': () => ({
        ...page(buttonPage(1), { title: 'Next', url: 'http://localhost/next', epoch: 2 }),
        failure: { step: 2, action: 'click', error: 'e1 is no longer on the page; read again' },
      }),
    });
    await runTool(link, SESSION, 'read', {});
    await expect(
      runTool(link, SESSION, 'act', {
        tab: 7,
        steps: [{ press: { key: 'Enter' } }, { click: { ref: 'e1' } }],
      }),
    ).rejects.toThrow(/Step 2 \(click\) failed: e1 is no longer on the page; read again\n[\s\S]*# Buttons/);
  });
});

describe('run_js tool', () => {
  it('returns a JSON result from the requested tab', async () => {
    const link = fakeBrowser({ 'page.eval': () => ({ value: { title: 'Test page', count: 2 } }) });
    const reply = await runTool(link, SESSION, 'run_js', { tab: 7, expression: '({title: document.title})' });
    expect(reply).toEqual([{ type: 'text', text: '{"title":"Test page","count":2}' }]);
    expect(link.calls).toEqual(['page.eval {"tab":7,"expression":"({title: document.title})"}']);
  });

  it('caps a large JSON result', async () => {
    const link = fakeBrowser({ 'page.eval': () => ({ value: 'x'.repeat(20_000) }) });
    const reply = await runTool(link, SESSION, 'run_js', { expression: 'document.body.innerText' });
    const output = (reply[0] as { text: string }).text;
    expect(output.length).toBeLessThan(12_200);
    expect(output).toMatch(/… truncated at 12000 characters/);
  });

  it('rejects an empty expression', async () => {
    const link = fakeBrowser({});
    await expect(runTool(link, SESSION, 'run_js', { expression: '' })).rejects.toThrow(/Invalid arguments: expression/);
  });
});
