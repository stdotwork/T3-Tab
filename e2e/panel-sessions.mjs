// Side-panel sessions (slice 8): the panel starts a T3 thread, or a direct Claude Code or Codex run, with the
// owner's current tab, follows its replies and continues it. `t3`, `claude` and `codex` are fakes from
// e2e/fakes on the daemon's PATH, inside the temporary HOME; they drive the real `t3-tab mcp` server.
import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';

import { createServer } from 'node:http';

import { checkLayout, layoutProblems } from './checks-layout.mjs';
import { assert, closeServer, connectMcp, listen, panelRequest, rootDir, sleep, text } from './harness.mjs';

/**
 * Writes the fake commands and puts them first on PATH for everything started from `home.childEnv` afterwards:
 * the native host, and so the daemon. Call it after the install check, which needs the real agent CLIs.
 */
export async function installFakeAgents(home) {
  const binDir = join(home.tempHome, 'fake-bin');
  const fakeDir = join(home.tempHome, 'fake-agents');
  await mkdir(binDir, { recursive: true });
  await mkdir(fakeDir, { recursive: true });
  const fakes = join(rootDir, 'e2e', 'fakes');
  const wrappers = {
    t3: `exec "${process.execPath}" "${join(fakes, 't3.mjs')}" "$@"`,
    claude: `exec "${process.execPath}" "${join(fakes, 'direct.mjs')}" claude "$@"`,
    codex: `exec "${process.execPath}" "${join(fakes, 'direct.mjs')}" codex "$@"`,
  };
  for (const [name, body] of Object.entries(wrappers)) {
    await writeFile(join(binDir, name), `#!/bin/sh\n${body}\n`);
    await chmod(join(binDir, name), 0o755);
  }
  Object.assign(home.childEnv, {
    PATH: `${binDir}:${home.childEnv.PATH ?? ''}`,
    // Pins `t3` to the fake, so a real T3 on this machine is never found, even after the fake is removed below.
    T3_TAB_T3: join(binDir, 't3'),
    T3CODE_HOME: join(home.tempHome, '.t3'),
    T3_TAB_FAKE_DIR: fakeDir,
    T3_TAB_E2E_NODE: process.execPath,
    T3_TAB_E2E_CLI: home.cliPath,
  });
  return { binDir, fakeDir };
}

/**
 * Records a T3 server the way a running one does, in `<T3 home>/userdata/server-runtime.json` under the temporary HOME,
 * with this process as its live pid and a loopback address that answers nothing. Nothing in the run talks to T3 over
 * HTTP: `t3` is the fake command, and the record only lets the daemon find a running T3.
 */
export async function startFakeT3Environment(home) {
  const server = createServer((_request, response) => response.writeHead(404).end());
  await listen(server);
  const port = server.address().port;
  const origin = `http://127.0.0.1:${port}`;
  const userdata = join(home.tempHome, '.t3', 'userdata');
  await mkdir(userdata, { recursive: true });
  await writeFile(
    join(userdata, 'server-runtime.json'),
    JSON.stringify({ version: 1, pid: process.pid, port, origin, startedAt: new Date().toISOString() }),
  );
  return { origin, close: async () => await closeServer(server) };
}

export async function checkPanelSessions({ browserContext, serviceWorker, panelPage, siteUrl, fakes, home, mcpClient, screenshotPath }) {
  const ownerPage = await browserContext.newPage();
  await ownerPage.goto(`${siteUrl}/?agent=1`);
  await ownerPage.getByRole('heading', { name: 'T3-Tab E2E' }).waitFor();
  const tabId = await serviceWorker.evaluate(async () => (await chrome.tabs.query({})).find((tab) => tab.url?.endsWith('/?agent=1'))?.id);
  assert(Number.isInteger(tabId), 'The owner tab for the panel sessions has no id');
  const readLine = `tab ${tabId}: T3-Tab E2E — ${siteUrl}/?agent=1`;
  await setT3Mode(fakes, 'running');
  await checkFullAccessConfirmed({ serviceWorker, fakes, home, tabId });

  // T3 found and running; Claude Code and Codex found; the start would share the current tab.
  let state = await panelRequest(serviceWorker, { type: 'panel.agents', refresh: true, tabId });
  assert(state.status.t3.state === 'running', `T3 is not reported running: ${JSON.stringify(state.status)}`);
  assert(state.status.t3.path === join(fakes.binDir, 't3'), `T3 was found elsewhere: ${state.status.t3.path}`);
  assert(state.status.claude === join(fakes.binDir, 'claude') && state.status.codex === join(fakes.binDir, 'codex'), `Direct CLIs: ${JSON.stringify(state.status)}`);
  assert(state.shareTabs.length === 1 && state.shareTabs[0].id === tabId, `Start would share: ${JSON.stringify(state.shareTabs)}`);
  console.log(`Panel agents: T3 running at ${state.status.t3.path}; Claude Code and Codex found; start shares tab ${tabId}`);

  // A T3 thread: started with the project, provider and model, the message on stdin plus the claim note.
  const started = await panelRequest(serviceWorker, {
    type: 'panel.agentStart',
    via: 't3',
    project: '/work/demo',
    provider: 'claudeAgent',
    model: 'claude-haiku',
    message: 'Summarise this page',
    tabId,
  });
  const t3Id = started.conversation.id;
  assert((started.conversation.threadId ?? '').startsWith('thread-'), `No T3 thread id: ${JSON.stringify(started.conversation)}`);
  const startCall = (await calls(fakes)).find((call) => call.name === 't3' && call.args[1] === 'start');
  assert(
    JSON.stringify(startCall?.args) === JSON.stringify(['thread', 'start', '--json', '--provider', 'claudeAgent', '--model', 'claude-haiku', '/work/demo', '-']),
    `t3 thread start was called with ${JSON.stringify(startCall?.args)}`,
  );
  const claim = /\{"claim": "([A-Za-z0-9_-]+)"\}/.exec(startCall.input)?.[1];
  assert(startCall.input.startsWith('Summarise this page\n\n[T3-Tab] ') && claim !== undefined, `The thread message lacks the claim note:\n${startCall.input}`);
  let thread = await waitForConversation(serviceWorker, t3Id, (conversation) => conversation.status === 'idle' && conversation.messages.length >= 2);
  const firstReply = thread.messages[1]?.text ?? '';
  assert(thread.messages[0].text === 'Summarise this page', `The panel shows the claim note: ${JSON.stringify(thread.messages[0])}`);
  assert(firstReply.includes(`\n${tabId} `) && firstReply.includes(`read: ${readLine}`), `The thread's agent did not read the owner's tab:\n${firstReply}`);
  const sessions = (await panelRequest(serviceWorker, { type: 'panel.state', tabId })).sessions;
  const t3Session = sessions.find((session) => session.name.startsWith('fake-t3-agent ·'));
  assert(t3Session?.sharedTabIds.includes(tabId), `The thread's session was not shared the tab: ${JSON.stringify(sessions)}`);
  console.log(`Panel T3 thread: ${thread.threadId} claimed tab ${tabId} and read it without a prompt:\n${firstReply}`);

  // Continuing the thread: `t3 thread send`, then polled until the next reply.
  await panelRequest(serviceWorker, { type: 'panel.agentSend', id: t3Id, message: 'And again' });
  const sendCall = (await calls(fakes)).find((call) => call.name === 't3' && call.args[1] === 'send');
  assert(JSON.stringify(sendCall?.args) === JSON.stringify(['thread', 'send', '--json', thread.threadId, '-']) && sendCall.input === 'And again', `t3 thread send: ${JSON.stringify(sendCall)}`);
  thread = await waitForConversation(serviceWorker, t3Id, (conversation) => conversation.status === 'idle' && conversation.messages.length >= 4);
  assert(thread.messages[3].text.startsWith('Turn 2. no claim') && thread.messages[3].text.includes(`read: tab ${tabId}`), `The second turn: ${thread.messages[3].text}`);
  const showCall = (await calls(fakes)).find((call) => call.name === 't3' && call.args[1] === 'show' && call.args.includes('20'));
  assert(JSON.stringify(showCall?.args) === JSON.stringify(['thread', 'show', '--json', '--messages', '20', thread.threadId]), `t3 thread show: ${JSON.stringify(showCall?.args)}`);
  console.log('Panel T3 thread: continued with t3 thread send; the same session read the tab again');

  // A claim code the panel never issued shares nothing.
  const bogus = await mcpClient.callTool({ name: 'tabs', arguments: { claim: 'not-a-real-claim-code-0000' } });
  assert(bogus.isError === true && text(bogus).includes('Unknown claim code'), `A made-up claim code was accepted: ${text(bogus)}`);
  console.log(`Claim guard: a made-up code was refused: ${text(bogus)}`);

  // The code in the thread's first message is used up: another session presenting it gets nothing.
  const reused = await mcpClient.callTool({ name: 'tabs', arguments: { claim } });
  assert(reused.isError === true && text(reused).includes('Unknown claim code'), `A used claim code was accepted again: ${text(reused)}`);
  console.log(`Claim guard: the thread's used code was refused for another session: ${text(reused)}`);

  // T3 stopped: the panel says so and offers the direct runs; a T3 start fails with T3's own message.
  await setT3Mode(fakes, 'stopped');
  state = await panelRequest(serviceWorker, { type: 'panel.agents', refresh: true, tabId });
  assert(state.status.t3.state === 'stopped' && state.status.t3.detail.includes('No running T3 Code server'), `T3 stopped: ${JSON.stringify(state.status.t3)}`);
  const stoppedStart = await panelRequest(serviceWorker, { type: 'panel.agentStart', via: 't3', project: '/work/demo', message: 'x', tabId }).catch((error) => error);
  assert(stoppedStart instanceof Error && stoppedStart.message.includes('No running T3 Code server'), `A start with T3 stopped: ${stoppedStart}`);
  console.log(`Panel with T3 stopped: ${state.status.t3.detail}`);

  // Direct Claude Code: `claude -p` limited to the T3-Tab server, which claims the tab from a private file.
  const claude = await panelRequest(serviceWorker, { type: 'panel.agentStart', via: 'claude', model: 'haiku', message: 'Read the tab', tabId });
  let run = await waitForConversation(serviceWorker, claude.conversation.id, (conversation) => conversation.status === 'idle' && conversation.messages.length >= 2);
  const claudeCalls = (await calls(fakes)).filter((call) => call.name === 'claude');
  const claudeArgs = claudeCalls[0].args;
  for (const expected of ['-p', '--restricted', '--setting-sources', '--strict-mcp-config', '--tools', '--allowedTools', 'mcp__t3-tab', '--permission-mode', 'dontAsk', '--disable-slash-commands', '--model', 'haiku']) {
    assert(claudeArgs.includes(expected), `claude was not called with ${expected}: ${JSON.stringify(claudeArgs)}`);
  }
  assert(!claudeArgs.includes('--resume') && claudeCalls[0].input === 'Read the tab', `First claude call: ${JSON.stringify(claudeCalls[0])}`);
  assert(claudeArgs[claudeArgs.indexOf('--tools') + 1] === '' && claudeArgs[claudeArgs.indexOf('--setting-sources') + 1] === '', `claude keeps tools or settings: ${JSON.stringify(claudeArgs)}`);
  const firstClaimFile = claimFileOf(claudeArgs);
  assert(firstClaimFile !== undefined && !JSON.stringify(claudeArgs).includes('T3_TAB_CLAIM'), `The claim is not in a private file: ${JSON.stringify(claudeArgs)}`);
  assert(!existsSync(firstClaimFile), `The claim file was left behind: ${firstClaimFile}`);
  assert(run.messages[1].text.includes(`read: ${readLine}`), `Claude Code did not read the tab:\n${run.messages[1].text}`);
  await panelRequest(serviceWorker, { type: 'panel.agentSend', id: claude.conversation.id, message: 'Once more' });
  run = await waitForConversation(serviceWorker, claude.conversation.id, (conversation) => conversation.status === 'idle' && conversation.messages.length >= 4);
  const resumeArgs = (await calls(fakes)).filter((call) => call.name === 'claude')[1]?.args ?? [];
  assert(resumeArgs[resumeArgs.indexOf('--resume') + 1] === run.threadId, `claude was not resumed with ${run.threadId}: ${JSON.stringify(resumeArgs)}`);
  assert(run.messages[3].text.includes(`read: ${readLine}`), `The resumed run did not get the tab again:\n${run.messages[3].text}`);
  const secondClaimFile = claimFileOf(resumeArgs);
  assert(secondClaimFile !== undefined && secondClaimFile !== firstClaimFile, `The resumed turn reused its claim file: ${secondClaimFile}`);
  console.log(`Panel direct Claude Code: session ${run.threadId}, resumed with --resume and a new claim code; both turns read tab ${tabId}`);

  // A tab the owner unshares during a turn is not shared again with the next turn of that conversation.
  const held = await panelRequest(serviceWorker, { type: 'panel.agentStart', via: 'claude', message: '[hold] Keep the tab', tabId });
  let holder;
  for (let attempt = 0; attempt < 100 && holder === undefined; attempt += 1) {
    const { sessions: current } = await panelRequest(serviceWorker, { type: 'panel.state', tabId });
    holder = current.find((session) => session.name.startsWith('claude-code ·') && session.sharedTabIds.includes(tabId));
    if (holder === undefined) await sleep(100);
  }
  assert(holder !== undefined, 'The held Claude Code turn never got the tab');
  await panelRequest(serviceWorker, { type: 'panel.unshareTab', sessionId: holder.id, tabId });
  await writeFile(join(fakes.fakeDir, 'release'), '');
  await waitForConversation(serviceWorker, held.conversation.id, (conversation) => conversation.status === 'idle' && conversation.messages.length >= 2);
  await panelRequest(serviceWorker, { type: 'panel.agentSend', id: held.conversation.id, message: 'After the unshare' });
  const afterUnshare = await waitForConversation(serviceWorker, held.conversation.id, (conversation) => conversation.status === 'idle' && conversation.messages.length >= 4);
  assert(!afterUnshare.messages[3].text.includes(`\n${tabId} `) && !afterUnshare.messages[3].text.includes(`read: ${readLine}`), `The next turn got the unshared tab back:\n${afterUnshare.messages[3].text}`);
  console.log('Panel direct Claude Code: a tab unshared during a turn was not shared with the next turn');

  // Between two turns the first turn's session is gone, so only the conversation's own list can take a tab back.
  const between = await panelRequest(serviceWorker, { type: 'panel.agentStart', via: 'claude', message: 'Between turns', tabId });
  await waitForConversation(serviceWorker, between.conversation.id, (conversation) => conversation.status === 'idle' && conversation.messages.length >= 2);
  const connected = (await panelRequest(serviceWorker, { type: 'panel.state', tabId })).sessions.filter((session) => session.name.startsWith('claude-code ·'));
  assert(connected.every((session) => !session.sharedTabIds.includes(tabId)), `A finished turn's session still holds the tab: ${JSON.stringify(connected)}`);
  state = await panelRequest(serviceWorker, { type: 'panel.agents', tabId });
  assert(state.conversationTabs[between.conversation.id]?.some((tab) => tab.id === tabId), `The conversation does not list its tab: ${JSON.stringify(state.conversationTabs)}`);
  // The owner's view: a second panel page carried by the harness, on the real poll, opens the conversation from the
  // thread list, shows the tab it holds and takes it back with the chip's Remove button.
  const livePanel = await openLivePanel(browserContext, serviceWorker, tabId);
  await livePanel.locator('#btn-threads').click();
  await livePanel.locator('.thread-row').filter({ hasText: 'Between turns' }).click();
  const heldChip = livePanel.locator('.tab-chip').filter({ hasText: 'T3-Tab E2E' });
  await heldChip.waitFor();
  await heldChip.getByRole('button', { name: 'Remove "T3-Tab E2E" from this conversation' }).click();
  await livePanel.locator('.tab-chip').getByText('No tabs shared', { exact: true }).waitFor();
  state = await panelRequest(serviceWorker, { type: 'panel.agents', tabId });
  assert(state.conversationTabs[between.conversation.id]?.length === 0, `The tab is still listed: ${JSON.stringify(state.conversationTabs)}`);
  const beforeSend = (await calls(fakes)).filter((call) => call.name === 'claude').length;
  await panelRequest(serviceWorker, { type: 'panel.agentSend', id: between.conversation.id, message: 'After taking it back' });
  const afterRemoval = await waitForConversation(serviceWorker, between.conversation.id, (conversation) => conversation.status === 'idle' && conversation.messages.length >= 4);
  assert(!afterRemoval.messages[3].text.includes(`\n${tabId} `) && !afterRemoval.messages[3].text.includes(`read: ${readLine}`), `The next turn still saw the tab:\n${afterRemoval.messages[3].text}`);
  const removalCall = (await calls(fakes)).filter((call) => call.name === 'claude')[beforeSend];
  assert(claimFileOf(removalCall.args) === undefined, `The next turn was given a claim file: ${JSON.stringify(removalCall.args)}`);
  console.log(`Panel direct Claude Code: tab ${tabId} removed between turns in the conversation view; the next turn could not see it:\n${afterRemoval.messages[3].text}`);

  // A claim file the MCP server cannot use: the owner and the agent are both told, and the agent gets no tabs.
  for (const [how, words] of [['missing', 'it was missing'], ['mode', 'other users could read it'], ['replaced', 'it is not a regular file']]) {
    const spoiled = await panelRequest(serviceWorker, { type: 'panel.agentStart', via: 'claude', message: `[claim-file:${how}] Read the tab`, tabId });
    const shown = await waitForConversation(serviceWorker, spoiled.conversation.id, (conversation) => conversation.status === 'idle' && conversation.messages.some((message) => message.role === 'assistant'));
    const warning = shown.messages.find((message) => message.role === 'error');
    assert(warning?.text.includes(words) && warning.text.includes('no tabs from you'), `No warning for a ${how} claim file: ${JSON.stringify(shown.messages)}`);
    const reply = shown.messages.find((message) => message.role === 'assistant').text;
    assert(reply.includes('T3-Tab: the tabs the owner shared for this turn are not available') && reply.includes(words), `The first tool reply did not say so for ${how}:\n${reply}`);
    assert(!reply.includes(`\n${tabId} `) && !reply.includes(`read: ${readLine}`), `A ${how} claim file still shared the tab:\n${reply}`);
    console.log(`Claim file ${how}: panel warned "${warning.text}"`);
  }

  // Direct Codex: `codex exec --json` in a read-only sandbox, then `codex exec resume`.
  const codex = await panelRequest(serviceWorker, { type: 'panel.agentStart', via: 'codex', message: 'Read it with Codex', tabId });
  run = await waitForConversation(serviceWorker, codex.conversation.id, (conversation) => conversation.status === 'idle' && conversation.messages.length >= 2);
  const codexArgs = (await calls(fakes)).filter((call) => call.name === 'codex')[0].args;
  assert(codexArgs[0] === 'exec' && codexArgs.includes('--json') && codexArgs.includes('sandbox_mode="read-only"') && codexArgs.at(-1) === '-', `codex exec: ${JSON.stringify(codexArgs)}`);
  for (const expected of ['--ignore-user-config', '--ignore-rules', 'shell_tool', 'apps', 'plugins', 'hooks', 'web_search="disabled"', 'mcp_servers.t3-tab.tool_timeout_sec=330']) {
    assert(codexArgs.includes(expected), `codex was not called with ${expected}: ${JSON.stringify(codexArgs)}`);
  }
  assert(!JSON.stringify(codexArgs).includes('T3_TAB_CLAIM') && codexArgs.some((value) => value.startsWith('mcp_servers.t3-tab.args=') && value.includes('--claim-file')), `The claim is not in a private file: ${JSON.stringify(codexArgs)}`);
  assert(run.messages[1].text.includes(`read: ${readLine}`), `Codex did not read the tab:\n${run.messages[1].text}`);
  await panelRequest(serviceWorker, { type: 'panel.agentSend', id: codex.conversation.id, message: 'Codex again' });
  run = await waitForConversation(serviceWorker, codex.conversation.id, (conversation) => conversation.status === 'idle' && conversation.messages.length >= 4);
  const codexResume = (await calls(fakes)).filter((call) => call.name === 'codex')[1]?.args ?? [];
  assert(codexResume[0] === 'exec' && codexResume[1] === 'resume' && codexResume.at(-2) === run.threadId, `codex exec resume: ${JSON.stringify(codexResume)}`);
  assert(run.messages[3].text.includes(`read: ${readLine}`), `The resumed Codex run did not get the tab again:\n${run.messages[3].text}`);
  console.log(`Panel direct Codex: thread ${run.threadId}, resumed with codex exec resume; both turns read tab ${tabId}`);

  // The panel itself, on the real poll: the new-thread screen with T3 stopped runs a direct agent and offers the
  // current tab, and the thread list opens a finished conversation with the agent's reply in it.
  const realPanelState = await panelRequest(serviceWorker, { type: 'panel.state', tabId });
  await livePanel.locator('#btn-new').click();
  await livePanel.locator('.composer-chips .tab-chip').filter({ hasText: 'T3-Tab E2E' }).waitFor();
  await livePanel.getByRole('button', { name: 'Home folder' }).waitFor();
  await livePanel.locator('.model-chip').first().click();
  await livePanel.getByRole('tab', { name: 'Claude Code' }).waitFor();
  await livePanel.getByRole('tab', { name: 'Codex' }).waitFor();
  await livePanel.keyboard.press('Escape');
  await livePanel.locator('#btn-threads').click();
  await livePanel.locator('.thread-row').filter({ hasText: 'Read it with Codex' }).click();
  await livePanel.locator('article.assistant').filter({ hasText: readLine }).first().waitFor();

  if (screenshotPath !== undefined) {
    const shotsDir = dirname(screenshotPath);
    await mkdir(shotsDir, { recursive: true });
    const shoot = async (page, file, options = {}) => {
      for (const scheme of ['light', 'dark']) {
        await page.emulateMedia({ colorScheme: scheme });
        await sleep(300);
        await page.screenshot({ path: join(shotsDir, file.replace('{scheme}', scheme)), animations: 'disabled', ...options });
      }
      await page.emulateMedia({ colorScheme: 'light' });
    };
    // The conversation as the owner sees it (360 px, light and dark), and the thread view as the main screenshot.
    await livePanel.bringToFront();
    await shoot(livePanel, 'conversation-360-{scheme}.png');
    await livePanel.screenshot({ path: screenshotPath, animations: 'disabled' });
    // Waiting prompts and the site list, drawn from supplied state on the headless panel.
    const sampleSession = realPanelState.sessions[0] ?? { id: 'sample-session', name: 'claude-code · 12345678' };
    await panelPage.setViewportSize({ width: 360, height: 800 });
    await panelPage.bringToFront();
    await panelPage.evaluate((next) => globalThis.__t3tabRenderPanelState(next), {
      ...realPanelState,
      pending: ['act', 'read'].map((tool) => ({ id: `shot-${tool}`, origin: siteUrl, tool, session: sampleSession, tab: { id: tabId, title: 'T3-Tab E2E' } })),
      sites: [
        { origin: 'http://127.0.0.1:3000', setting: 'ask' },
        { origin: 'http://127.0.0.1:4000', setting: 'read' },
        { origin: 'http://127.0.0.1:5000', setting: 'allow' },
      ],
    });
    await sleep(550);
    await shoot(panelPage, 'home-360-{scheme}.png');
    await panelPage.locator('#btn-settings').click();
    await panelPage.locator('.settings-tabs').getByRole('button', { name: 'Sites', exact: true }).click();
    await shoot(panelPage, 'settings-360-{scheme}.png');
    await panelPage.locator('#btn-settings-back').click();
    await panelPage.evaluate((next) => globalThis.__t3tabRenderPanelState(next), realPanelState);
    console.log(`Panel screenshots: ${shotsDir}`);
  }
  await checkThreadSections(livePanel, screenshotPath);
  await checkComposer({ livePanel, fakes, screenshotPath });
  await checkAppearance({ livePanel, screenshotPath });
  await checkLayout({ livePanel, serviceWorker, screenshotPath });
  await livePanel.close();
  console.log('Panel UI: tab chip, direct agents, conversation list and replies rendered from the real state');

  // T3 not installed at all.
  await rm(join(fakes.binDir, 't3'));
  state = await panelRequest(serviceWorker, { type: 'panel.agents', refresh: true, tabId });
  assert(state.status.t3.state === 'missing', `T3 missing: ${JSON.stringify(state.status.t3)}`);
  console.log('Panel with T3 missing: reported as not found');
  await ownerPage.close();
}

/**
 * The thread list groups T3's threads as T3's sidebar does, and the threads button carries a dot only while a thread
 * waits on the owner. The panel here is not signed in to T3, so the threads are handed to its T3 client as one shell
 * snapshot, the way T3's shell stream would send them; the direct runs are the real ones from this run.
 */
async function checkThreadSections(livePanel, screenshotPath) {
  const supply = async (threads) =>
    await livePanel.evaluate((list) => {
      const minutes = (count) => new Date(Date.now() + count * 60_000).toISOString();
      const shell = (id, title, extra) => ({
        id,
        projectId: 'shot-project',
        title,
        status: 'completed',
        interactionMode: 'default',
        createdAt: minutes(-600),
        updatedAt: minutes(-60),
        latestRunId: `run-${id}`,
        latestRunRequestedAt: minutes(-90),
        latestRunStartedAt: minutes(-89),
        latestRunCompletedAt: minutes(-60),
        activeRunId: null,
        activityRunStatus: null,
        pendingRuntimeRequest: null,
        lineage: { relationshipToParent: null, parentThreadId: null },
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        ...Object.fromEntries(Object.entries(extra).map(([key, value]) => [key, typeof value === 'number' ? minutes(value) : value])),
      });
      const threads = list.map(([id, title, extra]) => shell(id, title, extra));
      window.__t3tabT3.onShell({ kind: 'snapshot', snapshot: { threads, projects: [{ id: 'shot-project', title: 'shop-site', workspaceRoot: '/tmp/shop-site' }] } });
    }, threads);
  const running = { status: 'running', activityRunStatus: 'running', activeRunId: 'run-busy', latestRunCompletedAt: null };
  // T3's providers and its machine name, so the rows can show each thread's provider logo and must not show the machine.
  const configure = async (providers, environment) =>
    await livePanel.evaluate(([list, env]) => window.__t3tabT3.onConfig({ type: 'snapshot', config: { providers: list, settings: {}, environment: env } }), [providers, environment]);
  const provider = (instanceId, driver) => ({ instanceId, driver, enabled: true, installed: true, status: 'ready', models: [{ slug: `${driver}-model`, name: driver, isDefault: true }] });
  await configure([provider('claudeAgent', 'claudeAgent'), provider('codex', 'codex')], { label: 'layout-desktop', platform: { machine: 'desktop' }, capabilities: {} });
  await supply([
    ['pinned', 'Pinned plan', { pinnedAt: -500, modelSelection: { instanceId: 'claudeAgent', model: 'claudeAgent-model' } }],
    ['active', 'Fix the checkout form', { latestRunCompletedAt: -3, lastVisitedAt: -10, modelSelection: { instanceId: 'codex', model: 'codex-model' } }],
    ['asks', 'Pick a colour', { ...running, status: 'waiting', activityRunStatus: 'waiting', pendingRuntimeRequest: { id: 'q1', kind: 'user_input', createdAt: -1 } }],
    ['busy', 'Refactor the cart', { ...running, latestUserAuthoredMessageAt: -2 }],
    ['snoozed', 'Wait for the deploy', { snoozedAt: -5, snoozedUntil: 90 }],
    ['settled', 'Old landing page', { settledOverride: 'settled', settledAt: -30 }],
    ['archived', 'Archived thread', { archivedAt: -1 }],
  ]);
  await livePanel.locator('#btn-threads').click();
  await livePanel.locator('.thread-row').filter({ hasText: 'Pick a colour' }).waitFor();
  const shelves = await livePanel.locator('.shelf').evaluateAll((nodes) => nodes.map((node) => `${node.querySelector('.shelf-label').textContent} ${node.querySelector('.shelf-count').textContent}`));
  assert(JSON.stringify(shelves) === JSON.stringify(['Working 1', 'Snoozed 1', 'Settled 1']), `Thread list shelves: ${JSON.stringify(shelves)}`);
  const visibleRows = async () => await livePanel.locator('.thread-row').evaluateAll((nodes) => nodes.map((node) => `${node.dataset.section}:${node.querySelector('.thread-title').textContent}`));
  let rows = await visibleRows();
  assert(rows[0] === 'pinned:Pinned plan' && rows.includes('active:Pick a colour') && rows.includes('active:Fix the checkout form'), `Pinned and active rows: ${JSON.stringify(rows)}`);
  assert(!rows.some((row) => /Refactor the cart|Wait for the deploy|Old landing page|Archived thread/.test(row)), `Closed shelves or an archived thread showed rows: ${JSON.stringify(rows)}`);
  assert((await livePanel.locator('.thread-row').filter({ hasText: 'Pick a colour' }).locator('.thread-badge.input').textContent()) === 'Input', 'The waiting thread does not say Input, as T3 does');
  // Each row ends in its provider's logo, as T3's do, and none names the machine: T3 shows that only across machines.
  const logos = await livePanel.locator('.thread-row').evaluateAll((nodes) =>
    Object.fromEntries(nodes.map((node) => [node.querySelector('.thread-title').textContent, `${node.dataset.provider ?? '-'}:${node.querySelectorAll('.thread-provider svg.provider-logo').length}`])),
  );
  assert(logos['Pinned plan'] === 'claudeAgent:1' && logos['Fix the checkout form'] === 'codex:1', `Thread rows' provider logos: ${JSON.stringify(logos)}`);
  assert(logos['Pick a colour'] === '-:0', `A row whose provider T3 does not list drew a logo anyway: ${JSON.stringify(logos)}`);
  assert((await livePanel.locator('.thread-list').getByText('layout-desktop').count()) === 0, 'A thread row names the machine');
  for (const shelf of ['working', 'snoozed', 'settled']) await livePanel.locator(`.shelf[data-shelf="${shelf}"]`).click();
  rows = await visibleRows();
  const tail = rows.slice(rows.indexOf('working:Refactor the cart'));
  assert(JSON.stringify(tail) === JSON.stringify(['working:Refactor the cart', 'snoozed:Wait for the deploy', 'settled:Old landing page']), `Opened shelves: ${JSON.stringify(rows)}`);
  assert(/^\d+[mhd]$/.test((await livePanel.locator('.thread-row[data-section="snoozed"] .thread-badge.snoozed').textContent()).trim()), 'The snoozed row has no wake label');
  if (screenshotPath !== undefined) {
    // Tall enough for every row, from the pinned one at the top to the last shelf.
    await livePanel.setViewportSize({ width: 360, height: 1200 });
    await livePanel.locator('.thread-list').evaluate((node) => node.scrollTo(0, 0));
    for (const scheme of ['light', 'dark']) {
      await livePanel.emulateMedia({ colorScheme: scheme });
      await sleep(300);
      await livePanel.screenshot({ path: join(dirname(screenshotPath), `threads-360-${scheme}.png`), animations: 'disabled' });
    }
    await livePanel.emulateMedia({ colorScheme: 'light' });
    await livePanel.setViewportSize({ width: 360, height: 800 });
  }
  // The dot: on while a thread waits for an answer, off once nothing does. Plain work shows only in the list, not on
  // the new-thread screen.
  await livePanel.keyboard.press('Escape');
  await livePanel.locator('#btn-threads .needs-you-dot').waitFor();
  await livePanel.locator('#btn-new').click();
  await livePanel.locator('.hero h1').waitFor();
  await livePanel.locator('#btn-threads .needs-you-dot').waitFor();
  await supply([['busy', 'Refactor the cart', running]]);
  await livePanel.locator('#btn-threads .needs-you-dot').waitFor({ state: 'detached' });
  assert((await livePanel.getByText('Refactor the cart').count()) === 0, 'The new-thread screen shows a working thread');
  await supply([]);
  await configure([], { capabilities: {} });
  console.log(`Panel thread list: T3's sections in T3's order (${rows.length} rows with the shelves open), each row with its provider's logo and no machine line; the needs-you dot follows a waiting question`);
}

/**
 * A second panel page for the owner's view of a conversation. Pages in a tab are refused by the worker's sender
 * check, so the harness carries the page's requests to the same handler (as e2e/panel-flow.mjs does); `setup.done`
 * is set first so the page skips the setup screen, and it runs its normal poll.
 */
async function openLivePanel(browserContext, serviceWorker, tabId) {
  await serviceWorker.evaluate(() => chrome.storage.local.set({ 'setup.done': true }));
  const page = await browserContext.newPage();
  await page.setViewportSize({ width: 360, height: 800 });
  await page.exposeFunction('__t3tabPanelBridge', async (request) => {
    try {
      return await serviceWorker.evaluate(async (message) => await globalThis.__t3tabHandlePanelRequest(message), request);
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
  await page.goto(`chrome-extension://${new URL(serviceWorker.url()).host}/sidepanel.html?tabId=${tabId}`);
  return page;
}

function claimFileOf(args) {
  const serverArgs = JSON.parse(args[args.indexOf('--mcp-config') + 1]).mcpServers['t3-tab'].args;
  const index = serverArgs.indexOf('--claim-file');
  return index === -1 ? undefined : serverArgs[index + 1];
}

async function waitForConversation(serviceWorker, id, done) {
  let last;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const state = await panelRequest(serviceWorker, { type: 'panel.agents' });
    last = state.conversations.find((conversation) => conversation.id === id);
    if (last?.status === 'failed') throw new Error(`Conversation failed: ${JSON.stringify(last)}`);
    if (last !== undefined && done(last)) return last;
    await sleep(100);
  }
  throw new Error(`The conversation did not finish: ${JSON.stringify(last, null, 2)}`);
}

/**
 * Full access answers a browser request only while T3 itself says the thread has it. No live panel runs here: the only
 * panel page is the headless one, which polls nothing, so this is the closed-panel case.
 */
async function checkFullAccessConfirmed({ serviceWorker, fakes, home, tabId }) {
  const threadId = 'thread-fullaccess';
  const setMode = async (runtimeMode) =>
    await writeFile(
      join(fakes.fakeDir, `${threadId}.json`),
      JSON.stringify({ threadId, title: 'Full access', status: 'idle', latestRunId: 'run-1', providerInstanceId: 'default', model: 'default', pendingRequestCount: 0, runtimeMode, messages: [] }),
    );
  const servers = [];
  const site = async () => {
    const server = createServer((_request, response) => {
      response.setHeader('content-type', 'text/html');
      response.end('<!doctype html><title>Full access site</title><h1>Full access site</h1>');
    });
    await listen(server);
    servers.push(server);
    return `http://127.0.0.1:${server.address().port}/`;
  };
  const pendingFor = async (url) =>
    (await panelRequest(serviceWorker, { type: 'panel.state', tabId })).pending.find((prompt) => prompt.origin === new URL(url).origin);
  const first = await connectMcp(home, 'full-access-check');
  const second = await connectMcp(home, 'full-access-revoke');
  const open = (client, url) => client.callTool({ name: 'tabs', arguments: { action: 'open', url } });
  const opensWithoutPrompt = async (url, what) => {
    const before = (await panelRequest(serviceWorker, { type: 'panel.state', tabId })).autoAllowed.length;
    const result = await Promise.race([open(first.client, url), sleep(8_000).then(() => ({ timedOut: true }))]);
    assert(result.timedOut !== true && result.isError !== true, `${what}: the open did not go straight through: ${JSON.stringify(result).slice(0, 200)}`);
    const after = await panelRequest(serviceWorker, { type: 'panel.state', tabId });
    assert(after.autoAllowed.length > before && (await pendingFor(url)) === undefined, `${what}: not recorded as allowed by Full access`);
    const opened = /^Opened tab (\d+)/.exec(text(result))?.[1];
    assert(opened !== undefined, `${what}: no tab id in the reply: ${text(result)}`);
    return Number(opened);
  };
  const asksThenDecline = async (url, what) => {
    const call = open(first.client, url);
    let prompt;
    for (let attempt = 0; attempt < 100 && prompt === undefined; attempt += 1) {
      prompt = await pendingFor(url);
      if (prompt === undefined) await sleep(100);
    }
    assert(prompt !== undefined, `${what}: no prompt appeared`);
    await panelRequest(serviceWorker, { type: 'panel.decide', promptId: prompt.id, decision: 'decline' });
    const result = await call;
    assert(result.isError === true, `${what}: a declined open went through`);
  };
  try {
    await setMode('full-access');
    const claim = await panelRequest(serviceWorker, { type: 'panel.t3Claim', tabId });
    await first.client.callTool({ name: 'tabs', arguments: { claim: claim.code } });
    const unbound = await site();
    await asksThenDecline(unbound, 'A claim redeemed before it was bound to a thread');
    await panelRequest(serviceWorker, { type: 'panel.t3ClaimBind', code: claim.code, threadId });
    const openedTab = await opensWithoutPrompt(unbound, 'A bound thread in Full access');
    const readsWithoutPrompt = async (what) => {
      const before = (await panelRequest(serviceWorker, { type: 'panel.state', tabId })).autoAllowed.length;
      const result = await Promise.race([first.client.callTool({ name: 'read', arguments: { tab: openedTab } }), sleep(8_000).then(() => ({ timedOut: true }))]);
      assert(result.timedOut !== true && result.isError !== true, `${what}: the read did not go straight through`);
      assert((await panelRequest(serviceWorker, { type: 'panel.state', tabId })).autoAllowed.length > before, `${what}: the read did not ask T3 again`);
    };
    await readsWithoutPrompt('A read in Full access');

    await setMode('approval-required');
    await sleep(2_100);
    // Passing through Full access left no approval behind: the same tab's read now follows the lowered mode.
    const listed = text(await first.client.callTool({ name: 'tabs', arguments: {} }));
    assert(listed.includes(`${openedTab}`) && new RegExp(`^${openedTab}( \\[current\\])? \\[needs approval\\]`, 'm').test(listed), `The tab did not go back to needing approval:\n${listed}`);
    const readCall = first.client.callTool({ name: 'read', arguments: { tab: openedTab } });
    let readPrompt;
    for (let attempt = 0; attempt < 100 && readPrompt === undefined; attempt += 1) {
      readPrompt = await pendingFor(unbound);
      if (readPrompt === undefined) await sleep(100);
    }
    assert(readPrompt?.tool === 'read', 'A read after leaving Full access did not prompt');
    await panelRequest(serviceWorker, { type: 'panel.decide', promptId: readPrompt.id, decision: 'decline' });
    assert((await readCall).isError === true, 'A declined read after leaving Full access went through');
    const lowered = await site();
    await asksThenDecline(lowered, 'A thread that left Full access');
    await setMode('full-access');
    await opensWithoutPrompt(lowered, 'A thread back in Full access');

    await setT3Mode(fakes, 'stopped');
    await sleep(2_100);
    await asksThenDecline(await site(), 'A thread T3 can no longer confirm');
    await setT3Mode(fakes, 'running');

    const withdrawn = await panelRequest(serviceWorker, { type: 'panel.t3Claim', tabId });
    await second.client.callTool({ name: 'tabs', arguments: { claim: withdrawn.code } });
    const holder = async () => (await panelRequest(serviceWorker, { type: 'panel.state', tabId })).sessions.find((session) => session.name.startsWith('full-access-revoke'));
    assert((await holder())?.sharedTabIds.includes(tabId) === true, 'The second session did not get the tab');
    await panelRequest(serviceWorker, { type: 'panel.t3ClaimRevoke', code: withdrawn.code });
    assert((await holder())?.sharedTabIds.includes(tabId) === false, 'A withdrawn, never-bound claim left its tab shared');
    console.log('Full access: confirmed by T3 per request with no live panel; unbound, lowered and unconfirmed threads prompt, reads included; a withdrawn claim takes its tab back');
  } finally {
    await setT3Mode(fakes, 'running');
    await first.client.close().catch(() => undefined);
    await second.client.close().catch(() => undefined);
    const origins = servers.map((server) => `http://127.0.0.1:${server.address().port}/`);
    await serviceWorker.evaluate(async (urls) => {
      const tabs = await chrome.tabs.query({});
      await chrome.tabs.remove(tabs.filter((entry) => urls.some((url) => entry.url?.startsWith(url) || entry.pendingUrl?.startsWith(url))).map((entry) => entry.id));
    }, origins);
    for (const server of servers) {
      server.closeAllConnections();
      await closeServer(server);
    }
  }
}

async function calls(fakes) {
  const source = await readFile(join(fakes.fakeDir, 'calls.jsonl'), 'utf8').catch(() => '');
  return source.split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

async function setT3Mode(fakes, mode) {
  await writeFile(join(fakes.fakeDir, 't3-mode'), mode);
}

// A 1x1 PNG, and a few bytes of a PDF.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64');
const PDF = Buffer.from('%PDF-1.7\n%fake\n');

/**
 * Settings → Appearance: the color scheme is one segmented row, and the theme is one select-style menu with its actions
 * beside it. Files dropped on Settings, where there is no composer, are refused and nothing changes.
 */
async function checkAppearance({ livePanel, screenshotPath }) {
  await livePanel.locator('#btn-settings').click();
  await livePanel.locator('.settings-tabs').waitFor();
  const dropped = await livePanel.evaluate(() => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(['x'], 'note.txt', { type: 'text/plain' }));
    const target = document.querySelector('.settings-scroll');
    const fire = (type) => {
      const event = new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: transfer });
      target.dispatchEvent(event);
      return event.defaultPrevented;
    };
    fire('dragenter');
    const over = fire('dragover');
    const effect = transfer.dropEffect;
    const drop = fire('drop');
    return { over, effect, drop, overlay: document.querySelector('[data-panel-drop-overlay]') !== null, url: location.pathname };
  });
  assert(dropped.over && dropped.drop && !dropped.overlay && dropped.url.endsWith('sidepanel.html'), `A file dropped on Settings: ${JSON.stringify(dropped)}`);

  const scheme = livePanel.getByRole('radiogroup', { name: 'Color scheme' });
  const schemeBox = await scheme.boundingBox();
  assert(schemeBox !== null && schemeBox.height <= 28.5, `The color scheme control is ${schemeBox?.height} px tall`);
  await scheme.getByRole('radio', { name: 'Dark' }).click();
  assert(await livePanel.evaluate(() => document.documentElement.classList.contains('dark')), 'Dark did not apply');
  await scheme.getByRole('radio', { name: 'System' }).click();

  const trigger = livePanel.locator('.theme-trigger');
  // A fresh install is on T3 Code's built-in theme; the theme T3 shares for its environment is not followed.
  assert((await trigger.innerText()).trim() === 'T3 Code', `The theme trigger reads ${await trigger.innerText()}`);
  const canvasBefore = await livePanel.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--app-theme-canvas'));
  await livePanel.evaluate(() => {
    const client = window.__t3tabT3;
    client.onConfig({ type: 'settingsUpdated', payload: { settings: { defaultTheme: 'grove', defaultAppearance: 'dark' } } });
    client.onConfig({ type: 'environmentThemesUpdated', payload: { themes: [{ id: 'shared', name: 'Shared by T3', appearance: 'dark', canvas: '#203040', accent: '#ff7a59' }] } });
  });
  await sleep(200);
  const canvasAfter = await livePanel.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--app-theme-canvas'));
  assert(canvasAfter === canvasBefore && (await trigger.innerText()).trim() === 'T3 Code', `T3's environment theme changed the panel: ${canvasBefore} -> ${canvasAfter}`);
  await trigger.click();
  const menu = livePanel.getByRole('listbox', { name: 'Theme' });
  const names = await menu.getByRole('option').allInnerTexts();
  assert(names[0]?.trim() === 'T3 Code' && names.length >= 3 && !names.some((name) => /Follow|Shared by T3/.test(name)) && (await menu.locator('.theme-orbs').count()) === names.length, `The theme menu: ${JSON.stringify(names)}`);
  const pick = names[1].split('\n')[0].trim();
  if (screenshotPath !== undefined) {
    for (const width of [320, 360, 400]) {
      await livePanel.setViewportSize({ width, height: 640 });
      for (const colorScheme of ['light', 'dark']) {
        await livePanel.emulateMedia({ colorScheme });
        await sleep(250);
        await livePanel.screenshot({ path: join(dirname(screenshotPath), `settings-theme-menu-${width}-${colorScheme}.png`), animations: 'disabled' });
      }
    }
  }
  await menu.getByRole('option', { name: pick }).click();
  assert((await trigger.innerText()).includes(pick), `Picking ${pick} left the trigger at ${await trigger.innerText()}`);
  await livePanel.getByRole('button', { name: `Theme actions for ${pick}` }).click();
  const actions = await livePanel.getByRole('menu').getByRole('menuitem').allInnerTexts();
  assert(actions.some((text) => text.includes(`Duplicate ${pick}`)) && actions.some((text) => text.includes(`Export ${pick}`)), `Theme actions: ${JSON.stringify(actions)}`);
  await livePanel.getByRole('button', { name: `Theme actions for ${pick}` }).click();
  await trigger.click();
  for (const name of ['Create theme', 'Add theme']) assert((await livePanel.locator('.theme-popover').getByRole('button', { name }).count()) === 1, `${name} is not in the theme menu`);
  await menu.getByRole('option', { name: 'T3 Code', exact: true }).click();
  if (screenshotPath !== undefined) {
    for (const width of [320, 360, 400]) {
      await livePanel.setViewportSize({ width, height: 640 });
      for (const colorScheme of ['light', 'dark']) {
        await livePanel.emulateMedia({ colorScheme });
        await sleep(250);
        await livePanel.screenshot({ path: join(dirname(screenshotPath), `settings-${width}-${colorScheme}.png`), animations: 'disabled' });
      }
    }
    await livePanel.emulateMedia({ colorScheme: 'light' });
    await livePanel.setViewportSize({ width: 360, height: 800 });
  }
  await livePanel.locator('#btn-settings-back').click();
  console.log(`Settings appearance: a 28 px color scheme row, T3 Code's theme by default and not T3's shared one, a theme menu of ${names.length} themes with swatches, ${pick} picked and its actions listed; a file dropped on Settings was refused`);
}

/**
 * The composer as T3 Code lays it out: the paperclip at the left end, then the model, the mic and send; no access row
 * under the box. A
 * file a direct run cannot take is named and holds the message; an image goes to the agent with the message; the mic
 * says why it cannot record when T3 is not connected. With T3 connected, the access level is in the model picker.
 */
async function checkComposer({ livePanel, fakes, screenshotPath }) {
  await livePanel.keyboard.press('Escape');
  // The new-thread button is off on the new-thread screen itself.
  if (await livePanel.locator('#btn-new').isEnabled()) await livePanel.locator('#btn-new').click();
  await livePanel.locator('.hero h1').waitFor();
  // Where its controls' ink sits is checkLayout's (checks-layout.mjs); here, that every control is there in order and
  // nothing scrolls sideways.
  for (const width of [320, 360, 400]) {
    await livePanel.setViewportSize({ width, height: 760 });
    await sleep(100);
    const order = await livePanel.evaluate(() =>
      ['[aria-label="Attach files"]', '.model-chip', '.mic-btn', '.send-btn'].map((selector) => document.querySelector(`.composer-row ${selector}`)?.getBoundingClientRect().left ?? null),
    );
    assert(order.every((left, index) => left !== null && (index === 0 || left > order[index - 1])), `Composer controls at ${width}px: ${JSON.stringify(order)}`);
    assert(!(await livePanel.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)), `The panel scrolls sideways at ${width}px`);
  }
  await livePanel.setViewportSize({ width: 360, height: 800 });
  assert((await livePanel.locator('.under-composer, .runtime-btn').count()) === 0, 'The access row is still under the composer');

  // The mic, with T3 not connected: it says why rather than doing nothing.
  const mic = livePanel.locator('.composer-row .mic-btn');
  assert(((await mic.getAttribute('title')) ?? '').includes('Connect T3 Code'), `The mic's title: ${await mic.getAttribute('title')}`);
  await mic.click();
  await livePanel.locator('.composer-notice').filter({ hasText: 'Connect T3 Code' }).waitFor();
  console.log(`Composer mic without T3: ${await livePanel.locator('.composer-notice').innerText()}`);

  // A PDF cannot go to a direct run: it is named, and the message waits until it is removed.
  const chooser = livePanel.locator('.composer input[type="file"]');
  assert((await chooser.getAttribute('accept')) === 'image/png,image/jpeg,image/gif,image/webp', `The chooser offers: ${await chooser.getAttribute('accept')}`);
  await livePanel.locator('.composer-input').fill('What is in this picture?');
  await chooser.setInputFiles([{ name: 'spec.pdf', mimeType: 'application/pdf', buffer: PDF }]);
  await livePanel.locator('.file-chip.problem').filter({ hasText: 'spec.pdf' }).waitFor();
  const problem = await livePanel.locator('.composer-notice.problem').innerText();
  assert(problem.includes("spec.pdf can't go to Claude Code") && problem.includes('Remove it to send'), `The PDF's problem: ${problem}`);
  assert(await livePanel.getByRole('button', { name: 'Send', exact: true }).isDisabled(), 'Send is enabled with a file the agent cannot take');
  await livePanel.getByRole('button', { name: 'Remove spec.pdf' }).click();
  // A pasted file is attached too.
  await livePanel.locator('.composer-input').evaluate((input, bytes) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([new Uint8Array(bytes)], 'pasted.png', { type: 'image/png' }));
    input.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer }));
  }, [...PNG]);
  await livePanel.locator('.file-chip').filter({ hasText: 'pasted.png' }).waitFor();
  await livePanel.getByRole('button', { name: 'Remove pasted.png' }).click();
  // Files dragged anywhere over the panel, here over the heading, show the whole-panel overlay and drop into the composer.
  const drag = async (type, selector) =>
    await livePanel.evaluate(
      ({ type, selector, bytes }) => {
        const transfer = new DataTransfer();
        transfer.items.add(new File([new Uint8Array(bytes)], 'dot.png', { type: 'image/png' }));
        const event = new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: transfer });
        document.querySelector(selector).dispatchEvent(event);
        return { prevented: event.defaultPrevented, effect: transfer.dropEffect };
      },
      { type, selector, bytes: [...PNG] },
    );
  await drag('dragenter', '.hero h1');
  const over = await drag('dragover', '.hero h1');
  // Chromium ignores dropEffect on a DataTransfer made by script, so only the handled drag is checked here.
  assert(over.prevented, `A drag over the heading was not taken: ${JSON.stringify(over)}`);
  await livePanel.locator('[data-panel-drop-overlay]').waitFor();
  const frame = await livePanel.locator('[data-panel-drop-overlay]').evaluate((overlay) => {
    const box = overlay.getBoundingClientRect();
    return { left: box.left, top: box.top, right: window.innerWidth - box.right, bottom: window.innerHeight - box.bottom };
  });
  assert(Object.values(frame).every((inset) => Math.abs(inset - 8) < 0.5), `The drop overlay does not cover the panel: ${JSON.stringify(frame)}`);
  if (screenshotPath !== undefined) {
    for (const width of [320, 360, 400]) {
      await livePanel.setViewportSize({ width, height: 640 });
      for (const scheme of ['light', 'dark']) {
        await livePanel.emulateMedia({ colorScheme: scheme });
        await sleep(250);
        await livePanel.screenshot({ path: join(dirname(screenshotPath), `drop-overlay-${width}-${scheme}.png`), animations: 'disabled' });
      }
    }
    await livePanel.emulateMedia({ colorScheme: 'light' });
    await livePanel.setViewportSize({ width: 360, height: 800 });
  }
  await drag('drop', '.hero h1');
  await livePanel.locator('[data-panel-drop-overlay]').waitFor({ state: 'detached' });
  await livePanel.locator('.file-chip img').waitFor();
  assert((await livePanel.locator('.file-chip').count()) === 1, `Chips after the drop: ${await livePanel.locator('.file-chip').count()}`);
  // Leaving the panel takes the overlay away.
  await drag('dragenter', '.hero h1');
  await livePanel.locator('[data-panel-drop-overlay]').waitFor();
  await drag('dragleave', '.hero h1');
  await livePanel.locator('[data-panel-drop-overlay]').waitFor({ state: 'detached' });
  console.log(`Composer drop: a PNG dropped on the heading was attached; the overlay covered the panel ${frame.left} px in; paste attaches too`);
  assert((await livePanel.locator('.file-chip.problem').count()) === 0, 'The PNG is marked as a problem');
  if (screenshotPath !== undefined) {
    for (const width of [320, 360, 400]) {
      await livePanel.setViewportSize({ width, height: 640 });
      for (const scheme of ['light', 'dark']) {
        await livePanel.emulateMedia({ colorScheme: scheme });
        await sleep(250);
        await livePanel.screenshot({ path: join(dirname(screenshotPath), `composer-direct-${width}-${scheme}.png`), animations: 'disabled' });
      }
    }
    await livePanel.emulateMedia({ colorScheme: 'light' });
    await livePanel.setViewportSize({ width: 360, height: 800 });
  }

  // The image goes with the message: Claude Code reads it from stdin as an image block.
  const before = (await calls(fakes)).filter((call) => call.name === 'claude').length;
  await livePanel.getByRole('button', { name: 'Send', exact: true }).click();
  await livePanel.locator('.screen[data-thread-id]').waitFor();
  let sent;
  for (let attempt = 0; attempt < 100 && sent === undefined; attempt += 1) {
    sent = (await calls(fakes)).filter((call) => call.name === 'claude')[before];
    if (sent === undefined) await sleep(100);
  }
  assert(sent !== undefined, 'No Claude Code run started from the composer');
  const line = JSON.parse(sent.input);
  const [textBlock, imageBlock] = line.message?.content ?? [];
  assert(sent.args[sent.args.indexOf('--input-format') + 1] === 'stream-json', `Claude Code args: ${JSON.stringify(sent.args)}`);
  assert(textBlock?.text === 'What is in this picture?' && imageBlock?.type === 'image' && imageBlock.source?.data === PNG.toString('base64'), `Claude Code got: ${sent.input.slice(0, 200)}`);
  await livePanel.locator('.user-bubble, article').filter({ hasText: '[image: dot.png]' }).first().waitFor();
  console.log('Composer image: the PNG went to Claude Code as an image block with the message');

  // T3 connected (its config handed to the panel's client, as its stream would send it): the access level is in the
  // model picker's footer, not under the box.
  await livePanel.locator('#btn-new').click();
  await livePanel.locator('.hero h1').waitFor();
  await livePanel.evaluate(() => {
    const client = window.__t3tabT3;
    client.onConfig({
      type: 'snapshot',
      config: {
        providers: [
          {
            instanceId: 'claudeAgent',
            driver: 'claudeAgent',
            displayName: 'Claude',
            enabled: true,
            installed: true,
            status: 'ready',
            supportedRuntimeModes: ['approval-required', 'auto-accept-edits', 'auto', 'full-access'],
            models: [
              {
                slug: 'claude-opus-5-5',
                name: 'Claude Opus 5.5',
                shortName: 'Opus 5.5',
                isDefault: true,
                capabilities: { optionDescriptors: [{ id: 'effort', label: 'Reasoning', type: 'select', role: 'reasoning', options: [{ id: 'low', label: 'Low' }, { id: 'medium', label: 'Medium', isDefault: true }, { id: 'high', label: 'High' }] }] },
              },
              { slug: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', shortName: 'Sonnet 5.5' },
            ],
          },
        ],
        settings: {},
        environment: { capabilities: { voiceTranscription: true } },
      },
    });
    client.set({ status: 'ready' });
  });
  await livePanel.locator('.composer-row .model-chip').filter({ hasText: 'Opus 5.5' }).waitFor();
  assert((await livePanel.locator('.under-composer, .runtime-btn').count()) === 0, 'The access row is under the composer with T3 connected');
  assert(((await livePanel.locator('.composer-row .model-chip').getAttribute('title')) ?? '').includes('Full access'), 'The model chip does not name the access level');
  await livePanel.locator('.composer-row .model-chip').click();
  await livePanel.locator('.model-popover .model-footer .access-btn').filter({ hasText: 'Full access' }).waitFor();
  if (screenshotPath !== undefined) {
    for (const width of [320, 360, 400]) {
      await livePanel.setViewportSize({ width, height: 640 });
      for (const scheme of ['light', 'dark']) {
        await livePanel.emulateMedia({ colorScheme: scheme });
        await sleep(250);
        await livePanel.screenshot({ path: join(dirname(screenshotPath), `composer-t3-picker-${width}-${scheme}.png`), animations: 'disabled' });
      }
    }
  }
  await livePanel.locator('.access-btn').click();
  await livePanel.getByRole('menuitemradio', { name: /Supervised/ }).click();
  await livePanel.locator('.model-popover .access-btn').filter({ hasText: 'Supervised' }).waitFor();
  if (screenshotPath !== undefined) {
    await livePanel.locator('.access-btn').click();
    for (const width of [320, 360, 400]) {
      await livePanel.setViewportSize({ width, height: 640 });
      for (const scheme of ['light', 'dark']) {
        await livePanel.emulateMedia({ colorScheme: scheme });
        await sleep(250);
        await livePanel.screenshot({ path: join(dirname(screenshotPath), `composer-t3-access-${width}-${scheme}.png`), animations: 'disabled' });
      }
    }
    await livePanel.keyboard.press('Escape');
  }
  await livePanel.keyboard.press('Escape');
  const t3Layout = await layoutProblems(livePanel, 'T3 composer');
  assert(t3Layout.length === 0, t3Layout.join('\n'));
  if (screenshotPath !== undefined) {
    for (const width of [320, 360, 400]) {
      await livePanel.setViewportSize({ width, height: 640 });
      for (const scheme of ['light', 'dark']) {
        await livePanel.emulateMedia({ colorScheme: scheme });
        await sleep(250);
        await livePanel.screenshot({ path: join(dirname(screenshotPath), `composer-t3-${width}-${scheme}.png`), animations: 'disabled' });
      }
    }
  }
  await livePanel.emulateMedia({ colorScheme: 'light' });
  await livePanel.setViewportSize({ width: 360, height: 800 });
  // The choice is the composer's own; it is put back for anything after this.
  await livePanel.locator('.composer-row .model-chip').click();
  await livePanel.locator('.access-btn').click();
  await livePanel.getByRole('menuitemradio', { name: /Full access/ }).click();
  await livePanel.keyboard.press('Escape');
  await livePanel.evaluate(() => window.__t3tabT3.set({ status: 'off', providers: [] }));
  console.log('Composer with T3: the access level is in the model picker; Supervised was chosen there and Full access put back');
}
