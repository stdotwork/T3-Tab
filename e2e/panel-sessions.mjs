// Side-panel sessions (slice 8): the panel starts a T3 thread, or a direct Claude Code or Codex run, with the
// owner's current tab, follows its replies and continues it. `t3`, `claude` and `codex` are fakes from
// e2e/fakes on the daemon's PATH, inside the temporary HOME; they drive the real `t3-tab mcp` server.
import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { assert, panelRequest, rootDir, sleep, text } from './harness.mjs';

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

export async function checkPanelSessions({ browserContext, serviceWorker, panelPage, siteUrl, fakes, mcpClient, screenshotPath }) {
  const ownerPage = await browserContext.newPage();
  await ownerPage.goto(`${siteUrl}/?agent=1`);
  await ownerPage.getByRole('heading', { name: 'T3-Tab E2E' }).waitFor();
  const tabId = await serviceWorker.evaluate(async () => (await chrome.tabs.query({})).find((tab) => tab.url?.endsWith('/?agent=1'))?.id);
  assert(Number.isInteger(tabId), 'The owner tab for the panel sessions has no id');
  const readLine = `tab ${tabId}: T3-Tab E2E — ${siteUrl}/?agent=1`;
  await setT3Mode(fakes, 'running');

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
  const showCall = (await calls(fakes)).find((call) => call.name === 't3' && call.args[1] === 'show');
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
  await renderAgents(panelPage, state);
  await panelPage.locator('#agent-conversations button').filter({ hasText: 'Between turns' }).click();
  await panelPage.locator('#agent-next-turn').getByText(`Your next message shares tab ${tabId} "T3-Tab E2E".`).waitFor();
  // The harness's panel is an ordinary tab, which the worker refuses as a sender, so this one click is passed on to
  // the same handler. The button, its request and the refresh after it are the real ones.
  await panelPage.exposeFunction('__t3tabForwardPanel', async (message) => await panelRequest(serviceWorker, message));
  await panelPage.evaluate(() => {
    globalThis.__t3tabSendMessage = chrome.runtime.sendMessage;
    chrome.runtime.sendMessage = async (message) => await globalThis.__t3tabForwardPanel(message);
  });
  await panelPage.getByRole('button', { name: `Remove tab ${tabId} from this conversation` }).click();
  await panelPage.locator('#agent-next-turn').getByText('Your next message shares no tabs.').waitFor();
  await panelPage.evaluate(() => {
    chrome.runtime.sendMessage = globalThis.__t3tabSendMessage;
  });
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

  // The panel itself: render the real state and check what it shows, then take the screenshot for the PR.
  state = await panelRequest(serviceWorker, { type: 'panel.agents', tabId });
  await renderAgents(panelPage, state);
  await panelPage.evaluate((next) => globalThis.__t3tabRenderPanelState(next), await panelRequest(serviceWorker, { type: 'panel.state', tabId }));
  await panelPage.locator('#agent-status').getByText('T3 Code is not running. You can run Claude Code or Codex directly instead.').waitFor();
  await panelPage.locator('#agent-share').getByText(`Shares tab ${tabId} "T3-Tab E2E"`).waitFor();
  await panelPage.locator('#agent-conversations button').filter({ hasText: 'Read it with Codex' }).click();
  await panelPage.locator('#agent-thread .message.assistant').filter({ hasText: readLine }).first().waitFor();
  assert((await panelPage.locator('#agent-via').inputValue()) === 'claude', 'With T3 stopped the panel does not default to a direct run');
  if (screenshotPath !== undefined) {
    await panelPage.setViewportSize({ width: 420, height: 900 });
    await panelPage.screenshot({ path: screenshotPath, fullPage: true });
    console.log(`Panel screenshot: ${screenshotPath}`);
  }
  console.log('Panel UI: status line, shared tab, conversation list and replies rendered from the real state');

  // T3 not installed at all.
  await rm(join(fakes.binDir, 't3'));
  state = await panelRequest(serviceWorker, { type: 'panel.agents', refresh: true, tabId });
  assert(state.status.t3.state === 'missing', `T3 missing: ${JSON.stringify(state.status.t3)}`);
  console.log('Panel with T3 missing: reported as not found');
  await ownerPage.close();
}

function claimFileOf(args) {
  const serverArgs = JSON.parse(args[args.indexOf('--mcp-config') + 1]).mcpServers['t3-tab'].args;
  const index = serverArgs.indexOf('--claim-file');
  return index === -1 ? undefined : serverArgs[index + 1];
}

async function renderAgents(panelPage, state) {
  await panelPage.evaluate((next) => {
    const render = globalThis.__t3tabRenderAgentState;
    if (typeof render !== 'function') throw new Error('Agent panel renderer is unavailable');
    render(next);
  }, state);
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

async function calls(fakes) {
  const source = await readFile(join(fakes.fakeDir, 'calls.jsonl'), 'utf8').catch(() => '');
  return source.split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

async function setT3Mode(fakes, mode) {
  await writeFile(join(fakes.fakeDir, 't3-mode'), mode);
}
