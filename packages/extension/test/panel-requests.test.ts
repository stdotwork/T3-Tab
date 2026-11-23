import { PROTOCOL_VERSION, type ToolSession } from '@t3-tab/protocol';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { FakeBrowser } from './fake-browser';

const daemon = vi.hoisted(() => ({
  askDaemon: vi.fn(),
  daemonLinkState: vi.fn(),
  sendPromptNotice: vi.fn(),
}));
vi.mock('../src/daemon-link', () => daemon);

const browser = new FakeBrowser();
const alice: ToolSession = { id: 'session-alice', name: 'Alice · 1' };
const bob: ToolSession = { id: 'session-bob', name: 'Bob · 2' };

async function load() {
  // The runtime builds its stores from `chrome` when it is first imported, so the stubs come first.
  const [panel, runtime, claims, requests] = await Promise.all([
    import('../src/panel'),
    import('../src/runtime'),
    import('../src/claims'),
    import('../src/requests'),
  ]);
  return { ...panel, ...runtime, ...claims, handleRequest: requests.handleRequest };
}

beforeEach(() => {
  vi.resetModules();
  daemon.askDaemon.mockReset();
  daemon.daemonLinkState.mockReset();
  daemon.sendPromptNotice.mockReset();
  browser.reset();
  browser.install();
  const area = (): Record<string, unknown> => ({});
  const stores = { session: area(), local: area() };
  const storage = (data: Record<string, unknown>) => ({
    get: async (keys: string | string[]) => Object.fromEntries([keys].flat().filter((key) => key in data).map((key) => [key, structuredClone(data[key])])),
    set: async (values: Record<string, unknown>) => {
      for (const [key, value] of Object.entries(values)) data[key] = structuredClone(value);
    },
  });
  (globalThis as unknown as { chrome: { storage: unknown } }).chrome.storage = { session: storage(stores.session), local: storage(stores.local) };
  browser.addTab({ id: 5, url: 'https://shop.test/cart', title: 'Cart', groupId: -1 });
});

describe('the panel\'s setup, pairing and thread requests', () => {
  it('passes each to the background program with the fields it needs', async () => {
    const { handlePanelRequest } = await load();
    daemon.askDaemon.mockResolvedValue({ answered: true });
    await handlePanelRequest({ type: 'panel.setup' });
    await handlePanelRequest({ type: 'panel.setup', refresh: true });
    await handlePanelRequest({ type: 'panel.addAgent', agent: 'codex' });
    await handlePanelRequest({ type: 'panel.t3Pair' });
    await handlePanelRequest({ type: 'panel.t3Unpair' });
    await handlePanelRequest({ type: 'panel.agentGet', id: 'c1' });
    await handlePanelRequest({ type: 'panel.agentStop', id: 'c1' });
    expect(daemon.askDaemon.mock.calls).toEqual([
      ['setup.status', {}],
      ['setup.status', { refresh: true }],
      ['setup.addAgent', { agent: 'codex' }],
      ['t3.pair', {}],
      ['t3.unpair', {}],
      ['agents.get', { id: 'c1' }],
      ['agents.stop', { id: 'c1' }],
    ]);
  });

  it('refuses an agent other than the two, and a request with the wrong fields', async () => {
    const { handlePanelRequest } = await load();
    for (const request of [
      { type: 'panel.addAgent', agent: 't3' },
      { type: 'panel.addAgent' },
      { type: 'panel.agentGet' },
      { type: 'panel.agentStop', id: 4 },
      { type: 'panel.t3Claim' },
      { type: 'panel.t3ClaimBind', code: 'c' },
      { type: 'panel.t3ClaimBind', code: 'c', threadId: '' },
      { type: 'panel.t3SetFullAccess', threadId: 't', fullAccess: 'yes' },
    ]) {
      await expect(handlePanelRequest(request), JSON.stringify(request)).rejects.toThrow('Invalid panel request');
    }
    expect(daemon.askDaemon).not.toHaveBeenCalled();
  });

  it('answers the helper request from the link state, also when nothing is reachable', async () => {
    const { handlePanelRequest } = await load();
    daemon.daemonLinkState.mockResolvedValueOnce({ connected: false, error: 'Specified native messaging host not found.' });
    expect(await handlePanelRequest({ type: 'panel.helper' })).toEqual({ connected: false, error: 'Specified native messaging host not found.' });
    daemon.daemonLinkState.mockResolvedValueOnce({ connected: true });
    expect(await handlePanelRequest({ type: 'panel.helper' })).toEqual({ connected: true });
    expect(daemon.askDaemon).not.toHaveBeenCalled();
  });
});

describe('a claim for a T3 thread the panel launches itself', () => {
  it('shares the current tab, hands back the code with the note to put in the first message, and works once', async () => {
    const { handlePanelRequest, claimStore, sessionStore, claimTabs } = await load();
    const claim = (await handlePanelRequest({ type: 'panel.t3Claim', tabId: 5, fullAccess: false })) as { code: string; note: string; tabs: unknown[] };
    expect(claim.tabs).toEqual([{ id: 5, title: 'Cart', url: 'https://shop.test/cart' }]);
    expect(claim.note).toContain(`{"claim": "${claim.code}"}`);
    expect(claim.note.startsWith('\n\n[T3-Tab] ')).toBe(true);

    await sessionStore.register(alice);
    expect(await claimTabs(claimStore, sessionStore, alice.id, claim.code, 'message')).toEqual([5]);
    expect((await sessionStore.get(alice.id))?.sharedTabIds).toEqual([5]);
    await expect(claimTabs(claimStore, sessionStore, alice.id, claim.code, 'message')).rejects.toThrow('Unknown claim code');
  });

  it('is the message route only: a direct run\'s private file cannot redeem it', async () => {
    const { handlePanelRequest, claimStore, sessionStore, claimTabs } = await load();
    const claim = (await handlePanelRequest({ type: 'panel.t3Claim', fullAccess: false })) as { code: string };
    await sessionStore.register(alice);
    await expect(claimTabs(claimStore, sessionStore, alice.id, claim.code, 'launch')).rejects.toThrow('Unknown claim code');
  });

  it('can be revoked before anyone redeems it, and binding an unknown code is refused', async () => {
    const { handlePanelRequest, claimStore, sessionStore, claimTabs } = await load();
    const claim = (await handlePanelRequest({ type: 'panel.t3Claim', fullAccess: true })) as { code: string };
    expect(await handlePanelRequest({ type: 'panel.t3ClaimRevoke', code: claim.code })).toEqual({ ok: true });
    await sessionStore.register(alice);
    await expect(claimTabs(claimStore, sessionStore, alice.id, claim.code, 'message')).rejects.toThrow('Unknown claim code');
    await expect(handlePanelRequest({ type: 'panel.t3ClaimBind', code: 'never-issued', threadId: 't1' })).rejects.toThrow('Unknown claim code');
  });

  it('follows the thread\'s access: full access answers yes for that thread\'s session until T3 says it changed', async () => {
    const { handlePanelRequest, permissionPrompts, claimStore, sessionStore, claimTabs } = await load();
    const claim = (await handlePanelRequest({ type: 'panel.t3Claim', fullAccess: true })) as { code: string };
    await sessionStore.register(alice);
    await sessionStore.register(bob);
    // The agent redeems the code before the panel has even bound the new thread.
    await claimTabs(claimStore, sessionStore, alice.id, claim.code, 'message');
    await handlePanelRequest({ type: 'panel.t3ClaimBind', code: claim.code, threadId: 'th1' });

    const tab = { id: 5, title: 'Cart' };
    await permissionPrompts.authorize('https://shop.test', 'act', alice, tab);
    expect(permissionPrompts.list()).toEqual([]);
    // Another session, and any site setting, are untouched.
    const other = permissionPrompts.authorize('https://shop.test', 'act', bob, tab);
    await vi.waitFor(() => expect(permissionPrompts.list()).toHaveLength(1));
    permissionPrompts.cancelSession(bob.id);
    await expect(other).rejects.toThrow('declined');
    expect(await (await load()).siteStore.get('https://shop.test')).toBe('ask');

    await handlePanelRequest({ type: 'panel.t3SetFullAccess', threadId: 'th1', fullAccess: false });
    const asked = permissionPrompts.authorize('https://shop.test', 'run_js', alice, tab);
    await vi.waitFor(() => expect(permissionPrompts.list()).toHaveLength(1));
    permissionPrompts.cancelSession(alice.id);
    await expect(asked).rejects.toThrow('declined');

    await handlePanelRequest({ type: 'panel.t3SetFullAccess', threadId: 'th1', fullAccess: true });
    await expect(permissionPrompts.authorize('https://shop.test', 'open', alice, tab)).resolves.toBeUndefined();
  });

  it('does not give a session full access unless its own code was issued with it', async () => {
    const { handlePanelRequest, claimStore, sessionStore, claimTabs } = await load();
    const withAccess = (await handlePanelRequest({ type: 'panel.t3Claim', fullAccess: true })) as { code: string };
    const without = (await handlePanelRequest({ type: 'panel.t3Claim', fullAccess: false })) as { code: string };
    await sessionStore.register(alice);
    await sessionStore.register(bob);
    await claimTabs(claimStore, sessionStore, alice.id, without.code, 'message');
    await claimTabs(claimStore, sessionStore, bob.id, withAccess.code, 'message');
    expect(await claimStore.isFullAccess(alice.id)).toBe(false);
    expect(await claimStore.isFullAccess(bob.id)).toBe(true);
    expect(await claimStore.isFullAccess('never-claimed')).toBe(false);
    // Turning it on for a thread no grant is bound to changes nothing.
    await handlePanelRequest({ type: 'panel.t3SetFullAccess', threadId: 'unbound', fullAccess: true });
    expect(await claimStore.isFullAccess(alice.id)).toBe(false);
  });
});

describe('what full access let through', () => {
  it('lists the last twenty requests in panel.state and writes no site setting', async () => {
    const { handlePanelRequest, claimStore, sessionStore, claimTabs, siteStore } = await load();
    const claim = (await handlePanelRequest({ type: 'panel.t3Claim', fullAccess: true })) as { code: string };
    await sessionStore.register(alice);
    await claimTabs(claimStore, sessionStore, alice.id, claim.code, 'message');
    const { permissionPrompts } = await load();
    for (let index = 0; index < 25; index += 1) {
      await permissionPrompts.authorize(`https://site${index}.test`, 'read', alice, { id: 5, title: `Page ${index}` });
    }
    const state = (await handlePanelRequest({ type: 'panel.state', tabId: 5 })) as { autoAllowed: Array<{ tool: string; origin: string; tabId: number; tabTitle: string; at: number }> };
    expect(state.autoAllowed).toHaveLength(20);
    expect(state.autoAllowed[0]).toMatchObject({ tool: 'read', origin: 'https://site5.test', tabId: 5, tabTitle: 'Page 5' });
    expect(state.autoAllowed.at(-1)?.origin).toBe('https://site24.test');
    expect(typeof state.autoAllowed[0]?.at).toBe('number');
    expect(await siteStore.get('https://site24.test')).toBeUndefined();
  });
});

describe('a prompt in the agent\'s own thread', () => {
  it('tells the background program when a prompt opens and when it ends, however it ends', async () => {
    const { permissionPrompts } = await load();
    const tab = { id: 5, title: 'Cart' };
    const first = permissionPrompts.authorize('https://shop.test', 'act', alice, tab);
    await vi.waitFor(() => expect(permissionPrompts.list()).toHaveLength(1));
    const { id } = permissionPrompts.list()[0] ?? { id: '' };
    expect(daemon.sendPromptNotice).toHaveBeenLastCalledWith({
      type: 'browser.promptOpened',
      protocolVersion: PROTOCOL_VERSION,
      session: alice,
      prompt: { id, origin: 'https://shop.test', tool: 'act', tab },
    });
    await permissionPrompts.decide(id, 'allow-once');
    await first;
    expect(daemon.sendPromptNotice).toHaveBeenLastCalledWith({ type: 'browser.promptClosed', protocolVersion: PROTOCOL_VERSION, promptId: id });

    daemon.sendPromptNotice.mockClear();
    const second = permissionPrompts.authorize('https://shop.test', 'read', alice, tab);
    await vi.waitFor(() => expect(permissionPrompts.list()).toHaveLength(1));
    permissionPrompts.cancelSession(alice.id);
    await expect(second).rejects.toThrow('declined');
    expect(daemon.sendPromptNotice.mock.calls.map(([message]) => (message as { type: string }).type)).toEqual(['browser.promptOpened', 'browser.promptClosed']);
  });

  it('lets the session answer its own prompt once or by declining, and nobody else\'s, and never for good', async () => {
    const { permissionPrompts, sessionStore, handleRequest } = await load();
    await sessionStore.register(alice);
    await sessionStore.register(bob);
    const tab = { id: 5, title: 'Cart' };
    const waiting = permissionPrompts.authorize('https://shop.test', 'act', alice, tab);
    await vi.waitFor(() => expect(permissionPrompts.list()).toHaveLength(1));
    const promptId = permissionPrompts.list()[0]?.id ?? '';
    const decide = async (session: ToolSession, decision: string) =>
      await handleRequest({ type: 'browser.request', protocolVersion: PROTOCOL_VERSION, requestId: 'r', method: 'prompt.decide', session, params: { promptId, decision } } as never);

    await expect(decide(bob, 'allow-once')).rejects.toThrow('No such permission request for this session');
    await expect(decide(alice, 'always-allow')).rejects.toThrow('Invalid answer');
    expect(permissionPrompts.list()).toHaveLength(1);
    expect(await decide(alice, 'allow-once')).toEqual({ decided: true });
    await expect(waiting).resolves.toBeUndefined();
    await expect(decide(alice, 'allow-once')).rejects.toThrow('No such permission request for this session');

    const refused = permissionPrompts.authorize('https://shop.test', 'run_js', alice, tab);
    await vi.waitFor(() => expect(permissionPrompts.list()).toHaveLength(1));
    const second = permissionPrompts.list()[0]?.id ?? '';
    await handleRequest({ type: 'browser.request', protocolVersion: PROTOCOL_VERSION, requestId: 'r', method: 'prompt.decide', session: alice, params: { promptId: second, decision: 'decline' } } as never);
    await expect(refused).rejects.toThrow('declined');
  });
});
