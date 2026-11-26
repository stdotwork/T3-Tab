import type { BrowserMethod, BrowserMethods, PageReadResult, TabInfo, ToolContent } from '@t3-tab/protocol';
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

function text(content: ToolContent[]): string {
  const [first] = content;
  if (first?.type !== 'text') throw new Error('expected a text reply');
  return first.text;
}

const first: TabInfo = { id: 4, title: 'First', url: 'http://localhost/a', active: true };
const second: TabInfo = { id: 9, title: 'Second', url: 'http://localhost/b', active: false };

describe('tabs tool', () => {
  it('lists tabs as short lines and marks the front one', async () => {
    const link = fakeBrowser({ 'tabs.list': () => ({ tabs: [first, second] }) });
    expect(await runTool(link, SESSION, 'tabs', {})).toEqual([
      { type: 'text', text: '4 [current] First — http://localhost/a\n9 Second — http://localhost/b' },
    ]);
  });

  it('shows only the origin and that approval is needed for a tab the session has not approved', async () => {
    const hidden: TabInfo = { id: 7, title: '', url: 'http://mail.test', active: true, needsApproval: true };
    const link = fakeBrowser({
      'tabs.list': () => ({ tabs: [hidden, second] }),
      'tabs.switch': () => ({ tab: hidden }),
    });
    expect(await runTool(link, SESSION, 'tabs', {})).toEqual([
      { type: 'text', text: '7 [current] [needs approval] http://mail.test\n9 Second — http://localhost/b' },
    ]);
    expect(await runTool(link, SESSION, 'tabs', { action: 'switch', tab: 7 })).toEqual([
      { type: 'text', text: 'Switched to tab 7 [current] [needs approval] http://mail.test' },
    ]);
  });

  it('opens, switches and closes', async () => {
    const link = fakeBrowser({
      'tabs.open': () => ({ tab: second, page: page(signInPage(), { tab: 9, title: 'Second', url: 'http://localhost/b' }) }),
      'tabs.switch': () => ({ tab: first }),
      'tabs.close': (params) => ({ closed: params.tab }),
    });
    const opened = text(await runTool(link, SESSION, 'tabs', { action: 'open', url: 'http://localhost/b' }));
    expect(opened.split('\n').slice(0, 2)).toEqual(['Opened tab 9: Second — http://localhost/b', '# Sign in']);
    expect(opened).toContain('"Hello there"');
    expect(await runTool(link, SESSION, 'tabs', { action: 'switch', tab: 4 })).toEqual([
      { type: 'text', text: 'Switched to tab 4 [current] First — http://localhost/a' },
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

describe('loads', () => {
  const landing = (overrides: Partial<PageReadResult> = {}): PageReadResult =>
    page(signInPage(), { tab: 9, title: 'Second', url: 'http://localhost/b', ...overrides });

  it('reply with the page, which is the baseline the next read is diffed against', async () => {
    const link = fakeBrowser({ 'tabs.open': () => ({ tab: second, page: landing() }), 'page.read': () => landing() });
    const opened = text(await runTool(link, SESSION, 'tabs', { action: 'open', url: 'http://localhost/b' }));
    expect(opened).toMatch(/^Opened tab 9: Second — http:\/\/localhost\/b\n/);
    expect(text(await runTool(link, SESSION, 'read', {}))).toBe('tab 9\nNo changes since the last read.');
  });

  it('name the move, and say only the tab id when the session already saw that title and address', async () => {
    const replies: PageReadResult[] = [landing(), landing({ epoch: 1 })];
    const link = fakeBrowser({
      'tabs.open': () => ({ tab: second, page: landing() }),
      'tabs.navigate': () => ({ tab: second, page: replies.shift() ?? landing({ epoch: 2 }) }),
    });
    await runTool(link, SESSION, 'tabs', { action: 'open', url: 'http://localhost/b' });
    // The same document (a move within it) is a diff; a new one is the whole page again.
    expect(text(await runTool(link, SESSION, 'tabs', { action: 'back' }))).toBe('Back in tab 9\nNo changes since the last read.');
    expect(text(await runTool(link, SESSION, 'tabs', { action: 'forward' }))).toBe('Forward in tab 9\nNo changes since the last read.');
    expect(text(await runTool(link, SESSION, 'tabs', { action: 'reload' }))).toMatch(/^Reloaded tab 9: Second — http:\/\/localhost\/b\n# Sign in/);
  });

  it('give only the matching lines with find', async () => {
    const link = fakeBrowser({ 'tabs.open': () => ({ tab: second, page: landing() }) });
    const found = text(await runTool(link, SESSION, 'tabs', { action: 'open', url: 'http://localhost/b', find: 'hello' }));
    expect(found.split('\n')[0]).toBe('Opened tab 9: Second — http://localhost/b');
    expect(found).toContain('Hello there');
    expect(found).not.toContain('Sign in');
  });

  it('show only the origin of a tab a redirect took to an origin nobody approved', async () => {
    const elsewhere: TabInfo = { id: 9, title: '', url: 'http://mail.test', active: true, needsApproval: true };
    const link = fakeBrowser({ 'tabs.open': () => ({ tab: elsewhere, redirectedFrom: 'http://localhost' }) });
    expect(text(await runTool(link, SESSION, 'tabs', { action: 'open', url: 'http://localhost/b' }))).toBe(
      'Opened tab 9 [current] [needs approval] http://mail.test\nRedirected from http://localhost. read this tab to ask the owner for access.',
    );
  });

  it('say why the page is not in the reply', async () => {
    const link = fakeBrowser({
      'tabs.open': () => ({ tab: { ...second, active: true }, unread: 'A dialog is open: alert "Hi".' }),
      'tabs.navigate': () => ({ tab: { ...second, active: true } }),
    });
    expect(text(await runTool(link, SESSION, 'tabs', { action: 'open', url: 'http://localhost/b' }))).toBe(
      'Opened tab 9 [current] Second — http://localhost/b\nA dialog is open: alert "Hi".',
    );
    expect(text(await runTool(link, SESSION, 'tabs', { action: 'reload' }))).toBe(
      'Reloaded tab 9 [current] Second — http://localhost/b\nread it for the page.',
    );
  });

  it('read with a url loads it, opening a tab when the session has none', async () => {
    const link = fakeBrowser({ 'tabs.navigate': () => ({ tab: second, page: landing(), opened: true }) });
    const reply = text(await runTool(link, SESSION, 'read', { url: 'http://localhost/b', find: 'hello' }));
    expect(link.calls).toEqual(['tabs.navigate {"action":"goto","url":"http://localhost/b"}']);
    expect(reply.split('\n')[0]).toBe('Opened tab 9: Second — http://localhost/b');
    expect(reply).toContain('Hello there');
    expect(text(await runTool(link, SESSION, 'tabs', { action: 'goto', url: 'http://localhost/b' }))).toMatch(/^Opened tab 9/);
  });

  it('read with a url says Loaded for a tab it moved, and refuses a ref', async () => {
    const link = fakeBrowser({ 'tabs.navigate': () => ({ tab: second, page: landing() }) });
    expect(text(await runTool(link, SESSION, 'read', { url: 'http://localhost/b', tab: 9 }))).toMatch(/^Loaded tab 9: Second/);
    expect(link.calls).toEqual(['tabs.navigate {"action":"goto","url":"http://localhost/b","tab":9}']);
    await expect(runTool(link, SESSION, 'read', { url: 'http://localhost/b', ref: 'e1' })).rejects.toThrow('ref does not go with url');
  });
});

describe('read tool', () => {
  it('reads the front tab by default and a diff the second time', async () => {
    const link = fakeBrowser({ 'page.read': () => page(buttonPage(30)) });
    const firstReply = await runTool(link, SESSION, 'read', {});
    expect(firstReply[0]).toMatchObject({ type: 'text' });
    const secondReply = await runTool(link, SESSION, 'read', {});
    expect(secondReply).toEqual([
      { type: 'text', text: 'tab 7\nNo changes since the last read.' },
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
        { action: 'fill', ref: 'e2', text: 'grace@example.com' },
        { action: 'click', ref: 'e3' },
      ],
    });
    expect(reply[0]).toMatchObject({ type: 'text' });
    // The value the batch typed is not sent back; the reply says the field was set.
    expect((reply[0] as { text: string }).text).toBe('tab 7\nSet e2. Nothing else changed.');
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

  it('keeps a value the page changed in the reply, and counts only the steps before a failure', async () => {
    const initial = signInPage();
    const masked = initial.map((node) => (node.id === '5' ? { ...node, value: 'GRACE@EXAMPLE.COM' } : node));
    const link = fakeBrowser({
      'page.read': () => page(initial),
      'page.act': () => ({ ...page(masked), failure: { step: 2, action: 'click', error: 'e3 is no longer on the page; read again' } }),
    });
    await runTool(link, SESSION, 'read', {});
    const failure = await runTool(link, SESSION, 'act', {
      tab: 7,
      steps: [
        { action: 'fill', ref: 'e2', text: 'grace@example.com' },
        { action: 'click', ref: 'e3' },
      ],
    }).catch((error: Error) => error.message);
    expect(failure).toContain('Step 2 (click) failed: e3 is no longer on the page; read again');
    expect(failure).toContain('e2 textbox "Email" value="GRACE@EXAMPLE.COM"');
    expect(failure).not.toContain('Set e2');
  });

  it('uses the front tab when no tab is given', async () => {
    const link = fakeBrowser({
      'tabs.list': () => ({ tabs: [second] }),
      'page.read': () => page(signInPage()),
      'page.act': () => page(signInPage()),
    });
    await runTool(link, SESSION, 'read', {});
    await runTool(link, SESSION, 'act', { steps: [{ action: 'press', key: 'Enter' }] });
    expect(link.calls).toContain('tabs.list {}');
    expect(link.calls.at(-1)).toContain('page.act {"tab":9');
  });

  it('refuses an unknown ref before sending the batch', async () => {
    const link = fakeBrowser({ 'page.read': () => page(signInPage()) });
    await runTool(link, SESSION, 'read', {});
    await expect(runTool(link, SESSION, 'act', { tab: 7, steps: [{ action: 'click', ref: 'e99' }] })).rejects.toThrow(
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
        steps: [{ action: 'press', key: 'Enter' }, { action: 'click', ref: 'e1' }],
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
