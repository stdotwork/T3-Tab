// Side-panel sessions (slice 8): the panel starts a T3 thread, or a direct Claude Code or Codex run, with the
// owner's current tab, follows its replies and continues it. `t3`, `claude` and `codex` are fakes from
// e2e/fakes on the daemon's PATH, inside the temporary HOME; they drive the real `t3-tab mcp` server.
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join, relative, dirname } from 'node:path';

import { startFakeT3 } from './fakes/t3-server.mjs';
import { createServer } from 'node:http';

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
 * Starts the fake T3 environment (OAuth and `/mcp`) and records it the way a running T3 server does, in
 * `<T3 home>/userdata/server-runtime.json` under the temporary HOME, with this process as its live pid.
 */
export async function startFakeT3Environment(home) {
  const fake = await startFakeT3();
  const userdata = join(home.tempHome, '.t3', 'userdata');
  await mkdir(userdata, { recursive: true });
  const port = Number(new URL(fake.origin).port);
  await writeFile(
    join(userdata, 'server-runtime.json'),
    JSON.stringify({ version: 1, pid: process.pid, port, origin: fake.origin, startedAt: new Date().toISOString() }),
  );
  return fake;
}

export async function checkPanelSessions({ browserContext, serviceWorker, panelPage, siteUrl, fakes, fakeT3, home, mcpClient, screenshotPath }) {
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

  await checkT3SignIn({ browserContext, serviceWorker, fakes, fakeT3, home, tabId });

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
 * The panel's read-only sign-in to T3 Code (the fake one): a broader grant is refused, a forged answer is ignored, a
 * read-only grant is stored in a 0600 file and gives the panel T3's project and model lists, a thread starts with a
 * listed project and model, and sign-out deletes the file. The token never shows up anywhere but that file.
 */
async function checkT3SignIn({ browserContext, serviceWorker, fakes, fakeT3, home, tabId }) {
  const credentialFile = join(home.stateDir, 't3-credential.json');
  const replies = [];
  const ask = async (request) => {
    const reply = await panelRequest(serviceWorker, request);
    replies.push(JSON.stringify(reply));
    return reply;
  };
  let state = await ask({ type: 'panel.agents', refresh: true, tabId });
  assert(state.t3Access.state === 'signed-out' && state.t3Access.catalog === undefined, `Before sign-in: ${JSON.stringify(state.t3Access)}`);
  console.log('T3 sign-in: signed out, no lists');

  // First approval grants more than read-only: T3-Tab keeps nothing.
  let approval = await openSignIn(browserContext, serviceWorker, fakeT3);
  const redirectUri = new URL(approval.url()).searchParams.get('redirect_uri');
  assert(/^http:\/\/127\.0\.0\.1:\d+\/callback$/.test(redirectUri ?? ''), `The sign-in returns to ${redirectUri}`);
  await approval.getByText('T3-Tab wants access').waitFor();
  const forged = new URL(redirectUri);
  forged.searchParams.set('code', 'forged');
  forged.searchParams.set('state', 'forged');
  const forgedAnswer = await fetch(forged);
  assert(forgedAnswer.status === 400, `A forged answer got ${forgedAnswer.status}`);
  state = await ask({ type: 'panel.agents', tabId });
  assert(state.t3Access.state === 'signing-in', `After a forged answer: ${JSON.stringify(state.t3Access)}`);
  await approval.getByRole('button', { name: 'Approve: Full access' }).click();
  await approval.getByText('granted more than read-only access').waitFor();
  state = await ask({ type: 'panel.agents', tabId });
  assert(state.t3Access.state === 'signed-out' && state.t3Access.detail.includes('choose Read only'), `After a full-access grant: ${JSON.stringify(state.t3Access)}`);
  assert(!(await exists(credentialFile)), 'A full-access token was stored');
  await approval.close();
  console.log(`T3 sign-in: a forged answer was refused (HTTP 400); a full-access grant was not kept: ${state.t3Access.detail}`);

  // Read only: stored, listed.
  approval = await openSignIn(browserContext, serviceWorker, fakeT3);
  await approval.getByRole('button', { name: 'Approve: Read only' }).click();
  await approval.getByText('Signed in to T3 Code with read-only access').waitFor();
  await approval.waitForURL((url) => url.pathname === '/done');
  assert(!approval.url().includes('code='), `The sign-in tab still shows the code: ${approval.url()}`);
  await approval.close();
  const mode = (await stat(credentialFile)).mode & 0o777;
  assert(mode === 0o600, `The credential file has mode ${mode.toString(8)}`);
  state = await ask({ type: 'panel.agents', tabId });
  const catalog = state.t3Access.catalog;
  assert(state.t3Access.state === 'signed-in' && state.t3Access.environment === fakeT3.origin, `Signed in: ${JSON.stringify(state.t3Access)}`);
  assert(JSON.stringify(catalog?.projects.map((project) => project.id)) === JSON.stringify(['proj-demo', 'proj-docs', 'proj-api']), `Projects: ${JSON.stringify(catalog)}`);
  assert(catalog.providers.find((provider) => provider.instanceId === 'opencode')?.unavailable === 'Provider executable is not installed.', 'The unavailable provider is not marked');
  console.log(`T3 sign-in: read-only grant stored in ${relative(home.tempHome, credentialFile)} (mode 0${mode.toString(8)}); lists: ${catalog.projects.length} projects, ${catalog.providers.length} providers`);

  // A thread started with a listed project and model; it still runs through `t3 thread start`.
  const claudeProvider = catalog.providers.find((provider) => provider.instanceId === 'claudeAgent');
  const started = await ask({
    type: 'panel.agentStart',
    via: 't3',
    project: catalog.projects[0].id,
    provider: claudeProvider.instanceId,
    model: claudeProvider.models[1].id,
    message: 'Summarise with a listed model',
    tabId,
  });
  await waitForConversation(serviceWorker, started.conversation.id, (conversation) => conversation.status === 'idle' && conversation.messages.length >= 2);
  const startCall = (await calls(fakes)).filter((call) => call.name === 't3' && call.args[1] === 'start').at(-1);
  assert(
    JSON.stringify(startCall?.args) === JSON.stringify(['thread', 'start', '--json', '--provider', 'claudeAgent', '--model', 'claude-haiku-5-5', 'proj-demo', '-']),
    `t3 thread start with listed values: ${JSON.stringify(startCall?.args)}`,
  );
  console.log(`T3 sign-in: a thread started with listed values: t3 ${startCall.args.join(' ')}`);

  // Where the token went: only to /mcp, only for the two listing tools, and stored only in the credential file.
  const tokens = fakeT3.issued();
  assert(tokens.length === 2, `The fake issued ${tokens.length} tokens`);
  const log = fakeT3.log();
  assert(log.filter((entry) => tokens.includes(entry.bearer)).every((entry) => entry.path === '/mcp'), 'A token was sent somewhere other than /mcp');
  const tools = [...new Set(log.flatMap((entry) => (entry.tool === undefined ? [] : [entry.tool])))];
  assert(JSON.stringify(tools) === JSON.stringify(['t3_project_list', 'orchestrator_capabilities']), `T3 tools called: ${JSON.stringify(tools)}`);
  const holders = await filesContaining(home.tempHome, tokens);
  assert(JSON.stringify(holders) === JSON.stringify([{ file: relative(home.tempHome, credentialFile), token: 1 }]), `Files holding a token: ${JSON.stringify(holders)}`);
  assert(!replies.some((reply) => tokens.some((token) => reply.includes(token))), 'A panel reply carried a token');
  const tokenHashes = tokens.map((token) => createHash('sha256').update(token).digest('hex'));
  const leakingCall = (await calls(fakes)).find(
    (call) =>
      (call.envHashes ?? []).some((hash) => tokenHashes.includes(hash)) ||
      tokens.some((token) => JSON.stringify([call.args, call.input]).includes(token)),
  );
  assert(leakingCall === undefined, `A command the daemon started got a token: ${leakingCall?.name}`);
  const daemonPid = JSON.parse(await readFile(home.statePath, 'utf8')).pid;
  for (const part of ['cmdline', 'environ']) {
    const source = await readFile(`/proc/${daemonPid}/${part}`, 'utf8').catch(() => undefined);
    assert(source === undefined || !tokens.some((token) => source.includes(token)), `The daemon's ${part} holds a token`);
  }
  console.log(`T3 sign-in: the tokens reached only /mcp and ${relative(home.tempHome, credentialFile)}; no panel reply, file, command argument or environment held one`);

  // Sign out deletes the file.
  const signedOut = await ask({ type: 'panel.t3SignOut' });
  assert(signedOut.state === 'signed-out' && signedOut.detail.includes('Settings → Sharing & access'), `Sign out: ${JSON.stringify(signedOut)}`);
  assert(!(await exists(credentialFile)), 'Sign out left the credential file');
  state = await ask({ type: 'panel.agents', tabId });
  assert(state.t3Access.state === 'signed-out' && state.t3Access.catalog === undefined, `After sign-out: ${JSON.stringify(state.t3Access)}`);
  console.log(`T3 sign-in: signed out and the file was deleted: ${signedOut.detail}`);
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

async function openSignIn(browserContext, serviceWorker, fakeT3) {
  const opened = browserContext.waitForEvent('page', { predicate: (page) => page.url().startsWith(fakeT3.origin) || page.url() === 'about:blank' });
  await panelRequest(serviceWorker, { type: 'panel.t3SignIn' });
  const page = await opened;
  await page.waitForURL((url) => url.origin === fakeT3.origin && url.pathname === '/connect-agent');
  return page;
}

async function exists(path) {
  return await stat(path).then(
    () => true,
    () => false,
  );
}

/** Every regular file under `root` that holds one of the tokens, with the index of the token it holds. */
async function filesContaining(root, tokens) {
  const found = [];
  const walk = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) {
        const content = await readFile(path).catch(() => undefined);
        if (content === undefined) continue;
        const index = tokens.findIndex((token) => content.includes(token));
        if (index !== -1) found.push({ file: relative(root, path), token: index });
      }
    }
  };
  await walk(root);
  return found;
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
    await opensWithoutPrompt(unbound, 'A bound thread in Full access');

    await setMode('approval-required');
    await sleep(2_100);
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
    console.log('Full access: confirmed by T3 per request with no live panel; unbound, lowered and unconfirmed threads prompt; a withdrawn claim takes its tab back');
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
