import { PROTOCOL_VERSION, type ToolSession } from '@t3-tab/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
    await handlePanelRequest({ type: 'panel.t3Pair', origin: 'http://127.0.0.1:3773', dpop: 'a.b.c' });
    await handlePanelRequest({ type: 'panel.t3Session', kind: 'ticket', origin: 'http://127.0.0.1:3773', accessToken: 'tok', dpop: 'a.b.c' });
    await handlePanelRequest({ type: 'panel.t3Unpair' });
    await handlePanelRequest({ type: 'panel.agentGet', id: 'c1' });
    await handlePanelRequest({ type: 'panel.agentStop', id: 'c1' });
    expect(daemon.askDaemon.mock.calls).toEqual([
      ['setup.status', {}],
      ['setup.status', { refresh: true }],
      ['setup.addAgent', { agent: 'codex' }],
      ['t3.pair', { origin: 'http://127.0.0.1:3773', dpop: 'a.b.c' }],
      ['t3.session', { kind: 'ticket', origin: 'http://127.0.0.1:3773', accessToken: 'tok', dpop: 'a.b.c' }],
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
      { type: 'panel.t3Pair' },
      { type: 'panel.t3Pair', origin: 'http://127.0.0.1:3773' },
      { type: 'panel.t3Session', kind: 'pair', origin: 'o', accessToken: 'a', dpop: 'd' },
      { type: 'panel.t3Session', kind: 'renew', origin: 'o', accessToken: 'a' },
      { type: 'panel.t3ClaimBind', code: 'c' },
      { type: 'panel.t3ClaimBind', code: 'c', threadId: '' },
      // The panel no longer sets Full access: T3 is asked for it when a request needs it.
      { type: 'panel.t3SetFullAccess', threadId: 't', fullAccess: true },
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

/** What T3 reports as each thread's mode. A test changes it to change T3's answer; the panel is not involved. */
const threadModes: Record<string, string | Error> = {};

function answerThreadModes(): void {
  daemon.askDaemon.mockImplementation(async (method: string, params: { threadId?: string }) => {
    if (method !== 't3.threadMode') return { answered: true };
    const mode = threadModes[params.threadId ?? ''];
    if (mode === undefined) throw new Error('no such thread');
    if (mode instanceof Error) throw mode;
    return { runtimeMode: mode };
  });
}

const modeAsks = (): string[] =>
  daemon.askDaemon.mock.calls.filter(([method]) => method === 't3.threadMode').map(([, params]) => (params as { threadId: string }).threadId);

describe('a claim for a T3 thread the panel launches itself', () => {
  it('shares the current tab, hands back the code with the note to put in the first message, and works once', async () => {
    const { handlePanelRequest, claimStore, sessionStore, claimTabs } = await load();
    const claim = (await handlePanelRequest({ type: 'panel.t3Claim', tabId: 5 })) as { code: string; note: string; tabs: unknown[] };
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
    const claim = (await handlePanelRequest({ type: 'panel.t3Claim' })) as { code: string };
    await sessionStore.register(alice);
    await expect(claimTabs(claimStore, sessionStore, alice.id, claim.code, 'launch')).rejects.toThrow('Unknown claim code');
  });

  it('can be revoked before anyone redeems it, and binding an unknown code is refused', async () => {
    const { handlePanelRequest, claimStore, sessionStore, claimTabs } = await load();
    const claim = (await handlePanelRequest({ type: 'panel.t3Claim' })) as { code: string };
    expect(await handlePanelRequest({ type: 'panel.t3ClaimRevoke', code: claim.code })).toEqual({ ok: true });
    await sessionStore.register(alice);
    await expect(claimTabs(claimStore, sessionStore, alice.id, claim.code, 'message')).rejects.toThrow('Unknown claim code');
    await expect(handlePanelRequest({ type: 'panel.t3ClaimBind', code: 'never-issued', threadId: 't1' })).rejects.toThrow('Unknown claim code');
  });
});

describe('Full access, as T3 confirms it for each request', () => {
  const tab = { id: 5, title: 'Cart' };
  let clock: number;

  beforeEach(() => {
    clock = 10_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
    vi.spyOn(performance, 'now').mockImplementation(() => clock);
    for (const key of Object.keys(threadModes)) delete threadModes[key];
    answerThreadModes();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Asks to act and expects the owner to be asked; ends the prompt so the test can go on. */
  async function expectPrompt(authorize: Promise<unknown>, permissionPrompts: { list: () => unknown[]; cancelSession: (id: string) => void }, sessionId: string): Promise<void> {
    await vi.waitFor(() => expect(permissionPrompts.list()).toHaveLength(1));
    permissionPrompts.cancelSession(sessionId);
    await expect(authorize).rejects.toThrow('declined');
  }

  /** A session that redeemed a code of a fresh claim, bound to `threadId` unless that is undefined. */
  async function session(threadId: string | undefined, who: ToolSession = alice) {
    const loaded = await load();
    const claim = (await loaded.handlePanelRequest({ type: 'panel.t3Claim', tabId: 5 })) as { code: string };
    await loaded.sessionStore.register(who);
    await loaded.claimTabs(loaded.claimStore, loaded.sessionStore, who.id, claim.code, 'message');
    if (threadId !== undefined) await loaded.handlePanelRequest({ type: 'panel.t3ClaimBind', code: claim.code, threadId });
    return { ...loaded, claim };
  }

  it('allows without a prompt when T3 says the bound thread has Full access, for that session only', async () => {
    threadModes.th1 = 'full-access';
    const { permissionPrompts, siteStore, sessionStore } = await session('th1');
    await sessionStore.register(bob);
    await permissionPrompts.authorize('https://shop.test', 'act', alice, tab);
    expect(permissionPrompts.list()).toEqual([]);
    expect(modeAsks()).toEqual(['th1']);
    // Another session, and the site's setting, are untouched.
    await expectPrompt(permissionPrompts.authorize('https://shop.test', 'act', bob, tab), permissionPrompts, bob.id);
    expect(await siteStore.get('https://shop.test')).toBe('ask');
  });

  it('prompts when T3 says approval-required, fails to answer, or has no such thread', async () => {
    const { permissionPrompts } = await session('th1');
    threadModes.th1 = 'approval-required';
    await expectPrompt(permissionPrompts.authorize('https://shop.test', 'act', alice, tab), permissionPrompts, alice.id);
    threadModes.th1 = new Error('T3 is not running.');
    await expectPrompt(permissionPrompts.authorize('https://shop.test', 'act', alice, tab), permissionPrompts, alice.id);
    delete threadModes.th1;
    await expectPrompt(permissionPrompts.authorize('https://shop.test', 'act', alice, tab), permissionPrompts, alice.id);
  });

  it('prompts when the daemon never answers, once the five second limit has passed', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      daemon.askDaemon.mockImplementation(async () => await new Promise(() => undefined));
      const { permissionPrompts } = await session('th1');
      const asked = permissionPrompts.authorize('https://shop.test', 'act', alice, tab);
      await vi.advanceTimersByTimeAsync(4_900);
      expect(permissionPrompts.list()).toEqual([]);
      await vi.advanceTimersByTimeAsync(200);
      expect(permissionPrompts.list()).toHaveLength(1);
      permissionPrompts.cancelSession(alice.id);
      await expect(asked).rejects.toThrow('declined');
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives no allowance to a code redeemed before a thread was bound to it, and starts once it is bound', async () => {
    threadModes.th1 = 'full-access';
    const { permissionPrompts, handlePanelRequest, claim } = await session(undefined);
    await expectPrompt(permissionPrompts.authorize('https://shop.test', 'act', alice, tab), permissionPrompts, alice.id);
    // T3 was not even asked: nothing ties the session to a thread.
    expect(modeAsks()).toEqual([]);
    await handlePanelRequest({ type: 'panel.t3ClaimBind', code: claim.code, threadId: 'th1' });
    await expect(permissionPrompts.authorize('https://shop.test', 'open', alice, tab)).resolves.toBe('full-access');
    expect(modeAsks()).toEqual(['th1']);
  });

  it('is not full access for a session holding one bound grant and one unbound grant', async () => {
    threadModes.th1 = 'full-access';
    const { permissionPrompts, handlePanelRequest, claimStore, sessionStore, claimTabs } = await session('th1');
    await permissionPrompts.authorize('https://shop.test', 'act', alice, tab);
    clock += 60_000;
    const second = (await handlePanelRequest({ type: 'panel.t3Claim', tabId: 5 })) as { code: string };
    await claimTabs(claimStore, sessionStore, alice.id, second.code, 'message');
    await expectPrompt(permissionPrompts.authorize('https://shop.test', 'act', alice, tab), permissionPrompts, alice.id);
    expect(await claimStore.t3ThreadsOf(alice.id)).toBeUndefined();
  });

  it('is not full access for a session that also holds a direct run\'s grant', async () => {
    threadModes.th1 = 'full-access';
    const { permissionPrompts, claimStore, sessionStore, claimTabs } = await session('th1');
    const grant = await claimStore.issue('direct-code', [{ tabId: 5 }], { route: 'launch' });
    await claimStore.bindConversation(grant, 'conversation-1');
    await claimTabs(claimStore, sessionStore, alice.id, 'direct-code', 'launch');
    expect(await claimStore.t3ThreadsOf(alice.id)).toBeUndefined();
    await expectPrompt(permissionPrompts.authorize('https://shop.test', 'act', alice, tab), permissionPrompts, alice.id);
  });

  it('needs every thread the session holds to be on Full access', async () => {
    threadModes.th1 = 'full-access';
    threadModes.th2 = 'full-access';
    const { permissionPrompts, handlePanelRequest, claimStore, sessionStore, claimTabs } = await session('th1');
    const second = (await handlePanelRequest({ type: 'panel.t3Claim', tabId: 5 })) as { code: string };
    await claimTabs(claimStore, sessionStore, alice.id, second.code, 'message');
    await handlePanelRequest({ type: 'panel.t3ClaimBind', code: second.code, threadId: 'th2' });
    expect((await claimStore.t3ThreadsOf(alice.id))?.sort()).toEqual(['th1', 'th2']);
    await expect(permissionPrompts.authorize('https://shop.test', 'act', alice, tab)).resolves.toBe('full-access');
    clock += 60_000;
    threadModes.th2 = 'approval-required';
    await expectPrompt(permissionPrompts.authorize('https://shop.test', 'act', alice, tab), permissionPrompts, alice.id);
  });

  it('follows T3 and not the panel: a thread leaving Full access ends the allowance with no panel call', async () => {
    threadModes.th1 = 'full-access';
    const { permissionPrompts } = await session('th1');
    daemon.askDaemon.mockClear();
    answerThreadModes();
    await permissionPrompts.authorize('https://shop.test', 'act', alice, tab);
    // Only T3's answer changes; no panel request is made anywhere in this test after the claim was bound.
    threadModes.th1 = 'approval-required';
    clock += 2_000;
    await expectPrompt(permissionPrompts.authorize('https://shop.test', 'act', alice, tab), permissionPrompts, alice.id);
    expect(daemon.askDaemon.mock.calls.every(([method]) => method === 't3.threadMode')).toBe(true);
    threadModes.th1 = 'full-access';
    await expect(permissionPrompts.authorize('https://shop.test', 'act', alice, tab)).resolves.toBe('full-access');
  });

  it('keeps the confirmed answer for a short time only, so a burst of steps asks T3 once', async () => {
    threadModes.th1 = 'full-access';
    const { permissionPrompts } = await session('th1');
    const { FULL_ACCESS_CONFIRMED_MS } = await import('../src/t3-full-access');
    await permissionPrompts.authorize('https://shop.test', 'act', alice, tab);
    clock += FULL_ACCESS_CONFIRMED_MS - 1;
    await permissionPrompts.authorize('https://shop.test', 'act', alice, tab);
    expect(modeAsks()).toEqual(['th1']);
    threadModes.th1 = 'approval-required';
    clock += 1;
    await expectPrompt(permissionPrompts.authorize('https://shop.test', 'act', alice, tab), permissionPrompts, alice.id);
  });
});

describe('withdrawing a claim', () => {
  it('deletes a grant no thread was bound to even after an agent redeemed it, and takes its tab back from that session', async () => {
    const { handlePanelRequest, claimStore, sessionStore, claimTabs } = await load();
    const claim = (await handlePanelRequest({ type: 'panel.t3Claim', tabId: 5 })) as { code: string };
    await sessionStore.register(alice);
    await claimTabs(claimStore, sessionStore, alice.id, claim.code, 'message');
    expect((await sessionStore.get(alice.id))?.sharedTabIds).toEqual([5]);
    expect((await sessionStore.get(alice.id))?.approvedOrigins).toEqual({ '5': ['https://shop.test'] });

    expect(await handlePanelRequest({ type: 'panel.t3ClaimRevoke', code: claim.code })).toEqual({ ok: true });
    const after = await sessionStore.get(alice.id);
    expect(after?.sharedTabIds).toEqual([]);
    expect(after?.approvedOrigins).toEqual({});
    expect(await claimStore.t3ThreadsOf(alice.id)).toBeUndefined();
    // The grant is gone, so binding the code later finds nothing either.
    await expect(handlePanelRequest({ type: 'panel.t3ClaimBind', code: claim.code, threadId: 'th1' })).rejects.toThrow('Unknown claim code');
  });

  it('keeps a tab the same session also holds through another grant, and drops the tab only the withdrawn grant gave', async () => {
    browser.addTab({ id: 6, url: 'https://shop.test/pay', title: 'Pay', groupId: -1 });
    const { handlePanelRequest, claimStore, sessionStore, claimTabs } = await load();
    const first = (await handlePanelRequest({ type: 'panel.t3Claim', tabId: 5 })) as { code: string };
    const second = (await handlePanelRequest({ type: 'panel.t3Claim', tabId: 5 })) as { code: string };
    const other = (await handlePanelRequest({ type: 'panel.t3Claim', tabId: 6 })) as { code: string };
    await sessionStore.register(alice);
    await claimTabs(claimStore, sessionStore, alice.id, first.code, 'message');
    await claimTabs(claimStore, sessionStore, alice.id, second.code, 'message');
    await claimTabs(claimStore, sessionStore, alice.id, other.code, 'message');
    expect((await sessionStore.get(alice.id))?.sharedTabIds.sort()).toEqual([5, 6]);

    await handlePanelRequest({ type: 'panel.t3ClaimRevoke', code: first.code });
    expect((await sessionStore.get(alice.id))?.sharedTabIds.sort()).toEqual([5, 6]);
    await handlePanelRequest({ type: 'panel.t3ClaimRevoke', code: other.code });
    const after = await sessionStore.get(alice.id);
    expect(after?.sharedTabIds).toEqual([5]);
    expect(Object.keys(after?.approvedOrigins ?? {})).toEqual(['5']);
  });

  it('does nothing to a grant a thread is bound to', async () => {
    const { handlePanelRequest, claimStore, sessionStore, claimTabs } = await load();
    const claim = (await handlePanelRequest({ type: 'panel.t3Claim', tabId: 5 })) as { code: string };
    await sessionStore.register(alice);
    await claimTabs(claimStore, sessionStore, alice.id, claim.code, 'message');
    await handlePanelRequest({ type: 'panel.t3ClaimBind', code: claim.code, threadId: 'th1' });
    await handlePanelRequest({ type: 'panel.t3ClaimRevoke', code: claim.code });
    expect((await sessionStore.get(alice.id))?.sharedTabIds).toEqual([5]);
    expect(await claimStore.t3ThreadsOf(alice.id)).toEqual(['th1']);
  });

  it('takes the tabs back when starting the thread fails after the agent could have redeemed the code', async () => {
    const { claimStore, sessionStore, claimTabs } = await load();
    const grant = await claimStore.issue('code-x', [{ tabId: 5, origin: 'https://shop.test' }], { route: 'message' });
    expect(grant).toBeTruthy();
    await sessionStore.register(alice);
    await claimTabs(claimStore, sessionStore, alice.id, 'code-x', 'message');
    expect(await claimStore.revoke('code-x')).toEqual([{ sessionId: alice.id, tabId: 5 }]);
    expect(await claimStore.revoke('code-x')).toEqual([]);
  });
});

describe('what full access let through', () => {
  it('lists the last twenty requests in panel.state and writes no site setting', async () => {
    const { handlePanelRequest, claimStore, sessionStore, claimTabs, siteStore } = await load();
    const claim = (await handlePanelRequest({ type: 'panel.t3Claim' })) as { code: string };
    await sessionStore.register(alice);
    await claimTabs(claimStore, sessionStore, alice.id, claim.code, 'message');
    await handlePanelRequest({ type: 'panel.t3ClaimBind', code: claim.code, threadId: 'th1' });
    daemon.askDaemon.mockImplementation(async () => ({ runtimeMode: 'full-access' }));
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
    await expect(waiting).resolves.toBe('approved');
    await expect(decide(alice, 'allow-once')).rejects.toThrow('No such permission request for this session');

    const refused = permissionPrompts.authorize('https://shop.test', 'run_js', alice, tab);
    await vi.waitFor(() => expect(permissionPrompts.list()).toHaveLength(1));
    const second = permissionPrompts.list()[0]?.id ?? '';
    await handleRequest({ type: 'browser.request', protocolVersion: PROTOCOL_VERSION, requestId: 'r', method: 'prompt.decide', session: alice, params: { promptId: second, decision: 'decline' } } as never);
    await expect(refused).rejects.toThrow('declined');
  });
});
