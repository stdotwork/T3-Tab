import { assert, panelRequest, refFor, setSite, sleep, text } from './harness.mjs';
import { call, rawCall, show } from './checks-tools.mjs';

export async function checkPermissions({ mcpClient, mcpClientB, page, serviceWorker, panelPage, siteUrl, otherSiteUrl, browserContext }) {
  const sessions = await waitForSessions(serviceWorker, 2);
  const sessionA = sessions.find((session) => session.name.startsWith('t3-tab-e2e-a ·'));
  const sessionB = sessions.find((session) => session.name.startsWith('t3-tab-e2e-b ·'));
  assert(sessionA && sessionB, `Both MCP sessions are not listed:\n${JSON.stringify(sessions, null, 2)}`);
  assert(sessionA.name.endsWith(sessionA.id.slice(0, 8)), `Session A name lacks its short id: ${sessionA.name}`);
  console.log('Panel UI: headless harness uses the side panel handler directly; sender validation is unit-tested.');
  console.log(`Permission sessions: ${sessionA.name}; ${sessionB.name}`);

  await setSite(serviceWorker, siteUrl, 'ask');
  await setSite(serviceWorker, otherSiteUrl, 'ask');

  const openA = rawCall(mcpClient, 'tabs', { action: 'open', url: `${siteUrl}/perm-a` });
  const openPromptA = await waitForPrompt(serviceWorker, (prompt) => prompt.session.id === sessionA.id && prompt.tool === 'open');
  assertPromptTab(openPromptA, 'Permission A');
  await assertPromptMetadata(serviceWorker, openPromptA);
  await assertPromptUi(panelPage, serviceWorker, openPromptA);
  const badgeWhilePending = await serviceWorker.evaluate(() => chrome.action.getBadgeText({}));
  assert(badgeWhilePending === '1', `The action badge does not show the pending prompt: ${badgeWhilePending}`);
  console.log(`Permission badge while waiting: ${badgeWhilePending}`);
  await decidePrompt(serviceWorker, openPromptA.id, 'allow-once');
  const openedA = await openA;
  assert(openedA.isError !== true, `Session A could not open its tab: ${text(openedA)}`);
  const tabA = Number(/^Opened tab (\d+)/.exec(text(openedA))?.[1]);
  assert(Number.isInteger(tabA), `Session A open reply has no tab id: ${text(openedA)}`);
  assert(openPromptA.tab.id === tabA, `The open prompt named tab ${openPromptA.tab.id}, opened ${tabA}`);
  const badgeAfterDecision = await serviceWorker.evaluate(() => chrome.action.getBadgeText({}));
  assert(badgeAfterDecision === '', `The action badge was not cleared: ${badgeAfterDecision}`);
  console.log(`Open approval named tab ${openPromptA.tab.id} "${openPromptA.tab.title}" at ${openPromptA.origin}`);
  await assertPromptRows(panelPage, serviceWorker);

  const openB = rawCall(mcpClientB, 'tabs', { action: 'open', url: `${otherSiteUrl}/perm-b` });
  const openPromptB = await waitForPrompt(serviceWorker, (prompt) => prompt.session.id === sessionB.id && prompt.tool === 'open');
  assertPromptTab(openPromptB, 'Permission B');
  await decidePrompt(serviceWorker, openPromptB.id, 'allow-once');
  const openedB = await openB;
  assert(openedB.isError !== true, `Session B could not open its tab: ${text(openedB)}`);
  const tabB = Number(/^Opened tab (\d+)/.exec(text(openedB))?.[1]);
  assert(Number.isInteger(tabB), `Session B open reply has no tab id: ${text(openedB)}`);

  const groupA = await tabGroup(serviceWorker, tabA);
  const groupB = await tabGroup(serviceWorker, tabB);
  assert(groupA.groupId >= 0 && groupB.groupId >= 0, `Opened tabs are not grouped: A ${JSON.stringify(groupA)}, B ${JSON.stringify(groupB)}`);
  assert(groupA.groupId !== groupB.groupId, `Both sessions use group ${groupA.groupId}`);
  assert(groupA.title === sessionA.name && groupB.title === sessionB.name, `Group titles do not name their sessions: ${JSON.stringify({ groupA, groupB })}`);
  console.log(`Tab groups: A ${groupA.groupId} "${groupA.title}", B ${groupB.groupId} "${groupB.title}"`);

  const ownerTabs = await serviceWorker.evaluate(async () => (await chrome.tabs.query({})).map((tab) => ({ id: tab.id, url: tab.url, title: tab.title })));
  const ownerTab = ownerTabs.find((tab) => tab.url === `${siteUrl}/`);
  assert(ownerTab?.id !== undefined, `The owner's ungrouped tab is missing: ${JSON.stringify(ownerTabs)}`);

  const listA = await rawCall(mcpClient, 'tabs', {});
  assert(!listsTab(listA, tabB), `Session A can list session B's tab:\n${text(listA)}`);
  assert(!listsTab(listA, ownerTab.id), `Session A can list the unshared owner tab:\n${text(listA)}`);

  const crossSessionCalls = [
    ['read B', rawCall(mcpClient, 'read', { tab: tabB })],
    ['act B', rawCall(mcpClient, 'act', { tab: tabB, steps: [{ action: 'scroll', dy: 1 }] })],
    ['run_js B', rawCall(mcpClient, 'run_js', { tab: tabB, expression: '1' })],
    ['read owner', rawCall(mcpClient, 'read', { tab: ownerTab.id })],
    ['act owner', rawCall(mcpClient, 'act', { tab: ownerTab.id, steps: [{ action: 'scroll', dy: 1 }] })],
    ['run_js owner', rawCall(mcpClient, 'run_js', { tab: ownerTab.id, expression: '1' })],
  ];
  for (const [label, pending] of crossSessionCalls) {
    const refused = await pending;
    assert(refused.isError === true && /not available to this session/.test(text(refused)), `${label} was not refused: ${text(refused)}`);
  }
  const refusedAFromB = await rawCall(mcpClientB, 'read', { tab: tabA });
  assert(refusedAFromB.isError === true && /not available to this session/.test(text(refusedAFromB)), `Session B was not refused A's tab: ${text(refusedAFromB)}`);
  console.log("Membership refusals: A cannot use B's tab or the unshared owner tab; B cannot use A's tab");

  await panelRequest(serviceWorker, { type: 'panel.shareTab', sessionId: sessionA.id, tabId: ownerTab.id });
  const sharedRead = await rawCall(mcpClient, 'read', { tab: ownerTab.id });
  assert(sharedRead.isError !== true && text(sharedRead).includes('# T3-Tab E2E'), `Session A cannot read the shared owner tab: ${text(sharedRead)}`);
  const sharedList = await rawCall(mcpClient, 'tabs', {});
  assert(listsTab(sharedList, ownerTab.id), `The shared owner tab is not listed:\n${text(sharedList)}`);

  await page.goto(otherSiteUrl);
  await page.getByRole('heading', { name: 'T3-Tab E2E' }).waitFor();
  await page.bringToFront();
  const movedShareRead = rawCall(mcpClient, 'read', { tab: ownerTab.id });
  const movedSharePrompt = await waitForPrompt(serviceWorker, (prompt) => prompt.session.id === sessionA.id && prompt.tool === 'read' && prompt.tab.id === ownerTab.id);
  assert(movedSharePrompt.origin === otherSiteUrl, `The shared tab's new origin was not prompted: ${movedSharePrompt.origin}`);
  await decidePrompt(serviceWorker, movedSharePrompt.id, 'decline');
  const movedShareResult = await movedShareRead;
  assert(movedShareResult.isError === true && /Permission declined/.test(text(movedShareResult)), `A share covered a different origin: ${text(movedShareResult)}`);
  console.log(`Share no longer covered tab ${ownerTab.id} after it moved to ${otherSiteUrl}`);
  await page.goto(siteUrl);
  await page.getByRole('heading', { name: 'T3-Tab E2E' }).waitFor();
  await page.bringToFront();

  await panelRequest(serviceWorker, { type: 'panel.unshareTab', sessionId: sessionA.id, tabId: ownerTab.id });
  const unsharedRead = await rawCall(mcpClient, 'read', { tab: ownerTab.id });
  assert(unsharedRead.isError === true && /not available to this session/.test(text(unsharedRead)), `Session A can read the unshared owner tab: ${text(unsharedRead)}`);
  console.log(`Share covers the origin shown when shared: tab ${ownerTab.id} readable at ${siteUrl}, then refused after unshare`);

  const pageA = await rawCall(mcpClient, 'read', { tab: tabA, full: true });
  const actionRef = refFor(text(pageA), 'button "Action A"');
  assert(actionRef, `Session A's action page has no button ref:\n${text(pageA)}`);

  const firstAct = rawCall(mcpClient, 'act', { tab: tabA, steps: [{ action: 'click', ref: actionRef }] });
  const actPrompt = await waitForPrompt(serviceWorker, (prompt) => prompt.session.id === sessionA.id && prompt.tool === 'act');
  assertPromptTab(actPrompt, 'Permission A');
  await decidePrompt(serviceWorker, actPrompt.id, 'allow-once');
  const allowedAct = await firstAct;
  assert(allowedAct.isError !== true && text(allowedAct).includes('Action A completed'), `Allow once did not run the act: ${text(allowedAct)}`);
  console.log(`Ask origin, Allow once: act succeeded on tab ${actPrompt.tab.id} "${actPrompt.tab.title}"`);

  const secondAct = rawCall(mcpClient, 'act', { tab: tabA, steps: [{ action: 'click', ref: actionRef }] });
  const declinePrompt = await waitForPrompt(serviceWorker, (prompt) => prompt.session.id === sessionA.id && prompt.tool === 'act');
  await decidePrompt(serviceWorker, declinePrompt.id, 'decline');
  const declinedAct = await secondAct;
  assert(declinedAct.isError === true && /Permission declined/.test(text(declinedAct)), `Decline did not refuse the act: ${text(declinedAct)}`);
  console.log('Ask origin, Decline: act refused');

  const alwaysAct = rawCall(mcpClient, 'act', { tab: tabA, steps: [{ action: 'click', ref: actionRef }] });
  const alwaysPrompt = await waitForPrompt(serviceWorker, (prompt) => prompt.session.id === sessionA.id && prompt.tool === 'act');
  await decidePrompt(serviceWorker, alwaysPrompt.id, 'always-allow');
  const alwaysResult = await alwaysAct;
  assert(alwaysResult.isError !== true, `Always allow did not run the first act: ${text(alwaysResult)}`);
  const noPromptAct = await withDeadline(
    rawCall(mcpClient, 'act', { tab: tabA, steps: [{ action: 'click', ref: actionRef }] }),
    2_000,
    'second act after Always allow',
  );
  assert(noPromptAct.isError !== true, `The second act after Always allow failed: ${text(noPromptAct)}`);
  assert((await pendingPrompts(serviceWorker)).length === 0, 'Always allow left a prompt waiting');
  await setSite(serviceWorker, siteUrl, 'ask');
  console.log('Always allow: the second act ran without a prompt');

  await serviceWorker.evaluate(() => chrome.storage.local.set({ permissionTimeoutMs: 1_200 }));
  const timeoutStarted = Date.now();
  const timedOutAct = await rawCall(mcpClient, 'act', { tab: tabA, steps: [{ action: 'click', ref: actionRef }] });
  const timeoutElapsed = Date.now() - timeoutStarted;
  assert(timedOutAct.isError === true && /timed out and was declined/.test(text(timedOutAct)), `The prompt timeout did not decline: ${text(timedOutAct)}`);
  assert(timeoutElapsed >= 900 && timeoutElapsed < 4_000, `The configured timeout took ${timeoutElapsed} ms`);
  await serviceWorker.evaluate(() => chrome.storage.local.remove('permissionTimeoutMs'));
  console.log(`Prompt timeout: declined after ${timeoutElapsed} ms`);

  await panelRequest(serviceWorker, { type: 'panel.shareTab', sessionId: sessionA.id, tabId: ownerTab.id });
  const unsharedWhileWaiting = rawCall(mcpClient, 'act', { tab: ownerTab.id, steps: [{ action: 'scroll', dy: 1 }] });
  const unsharePrompt = await waitForPrompt(serviceWorker, (prompt) => prompt.session.id === sessionA.id && prompt.tool === 'act');
  assertPromptTab(unsharePrompt, 'T3-Tab E2E');
  await panelRequest(serviceWorker, { type: 'panel.unshareTab', sessionId: sessionA.id, tabId: ownerTab.id });
  await decidePrompt(serviceWorker, unsharePrompt.id, 'allow-once');
  const unsharedAct = await unsharedWhileWaiting;
  assert(unsharedAct.isError === true && /not available to this session/.test(text(unsharedAct)), `Allow after unshare still acted: ${text(unsharedAct)}`);
  console.log(`Unshared while waiting: Allow once still refused tab ${ownerTab.id}`);

  const runJsOnX = rawCall(mcpClient, 'run_js', { tab: tabA, expression: 'document.title' });
  const runJsPrompt = await waitForPrompt(serviceWorker, (prompt) => prompt.session.id === sessionA.id && prompt.tool === 'run_js');
  await decidePrompt(serviceWorker, runJsPrompt.id, 'allow-once');
  const runJsResult = await runJsOnX;
  assert(runJsResult.isError !== true && text(runJsResult) === '"Permission A"', `Approved run_js failed: ${text(runJsResult)}`);
  console.log(`Approved run_js on ${siteUrl}: ${text(runJsResult)}`);

  const navigate = rawCall(mcpClient, 'run_js', {
    tab: tabA,
    expression: `const target = ${JSON.stringify(`${otherSiteUrl}/perm-b`)}; setTimeout(() => { location.href = target; }, 0); return 'navigating';`,
  });
  const navigationPrompt = await waitForPrompt(serviceWorker, (prompt) => prompt.session.id === sessionA.id && prompt.tool === 'run_js');
  await decidePrompt(serviceWorker, navigationPrompt.id, 'allow-once');
  const navigateResult = await navigate;
  assert(navigateResult.isError !== true, `Navigation run_js failed before moving: ${text(navigateResult)}`);
  await waitForTabUrl(serviceWorker, tabA, `${otherSiteUrl}/perm-b`);
  console.log(`Tab ${tabA} navigated from ${siteUrl} to ${otherSiteUrl}`);

  const pendingRead = rawCall(mcpClient, 'read', { tab: tabA });
  const crossOriginPrompt = await waitForPrompt(serviceWorker, (prompt) => prompt.session.id === sessionA.id && prompt.tool === 'read');
  assertPromptTab(crossOriginPrompt, 'Permission B');
  assert(crossOriginPrompt.origin === otherSiteUrl, `Read prompt used origin ${crossOriginPrompt.origin}`);
  await decidePrompt(serviceWorker, crossOriginPrompt.id, 'decline');
  const crossOriginRead = await pendingRead;
  assert(crossOriginRead.isError === true && /Permission declined/.test(text(crossOriginRead)), `Cross-origin read was answered without approval: ${text(crossOriginRead)}`);
  console.log(`Cross-origin read on tab ${crossOriginPrompt.tab.id} "${crossOriginPrompt.tab.title}" prompted (kind ${crossOriginPrompt.tool}) at ${otherSiteUrl} and was declined`);

  const screenshotOnY = rawCall(mcpClient, 'screenshot', { tab: tabA, maxEdge: 320 });
  const screenshotPrompt = await waitForPrompt(serviceWorker, (prompt) => prompt.session.id === sessionA.id && prompt.tool === 'read');
  await decidePrompt(serviceWorker, screenshotPrompt.id, 'allow-once');
  const screenshotResult = await screenshotOnY;
  assert(screenshotResult.isError !== true && screenshotResult.content.some((item) => item.type === 'image'), `Screenshot did not get read approval: ${text(screenshotResult)}`);
  console.log('Screenshot used a read prompt, then returned an image after Allow once');

  // A tab the owner opens from their own tab during a long run_js is not pulled into the session's group,
  // even when the run_js text mentions window.open( without calling it.
  const beforeOwnerPopup = new Set(await serviceWorker.evaluate(async () => (await chrome.tabs.query({})).map((tab) => tab.id)));
  const longRun = rawCall(mcpClient, 'run_js', {
    tab: tabA,
    expression: "await new Promise((resolve) => setTimeout(resolve, 3000)); // window.open( is only named in this comment\nreturn 'long run done';",
  });
  const longRunPrompt = await waitForPrompt(serviceWorker, (prompt) => prompt.session.id === sessionA.id && prompt.tool === 'run_js');
  await decidePrompt(serviceWorker, longRunPrompt.id, 'allow-once');
  await sleep(600);
  await page.evaluate((url) => {
    window.open(url, '_blank');
  }, `${siteUrl}/about`);
  const ownerPopup = await waitForNewTab(serviceWorker, beforeOwnerPopup, `${siteUrl}/about`);
  const longRunResult = await longRun;
  assert(longRunResult.isError !== true && text(longRunResult) === '"long run done"', `The long run_js failed: ${text(longRunResult)}`);
  await sleep(500);
  const ownerPopupGroup = await tabGroup(serviceWorker, ownerPopup.id);
  assert(ownerPopupGroup.groupId === -1, `The owner's popup tab ${ownerPopup.id} was pulled into group ${ownerPopupGroup.groupId} during a run_js`);
  await serviceWorker.evaluate((id) => chrome.tabs.remove(id), ownerPopup.id);
  console.log(`Owner popup opened during a long run_js stayed out of group ${groupA.groupId} (tab ${ownerPopup.id} ungrouped)`);

  const beforePopup = new Set(await serviceWorker.evaluate(async () => (await chrome.tabs.query({})).map((tab) => tab.id)));
  const popupCall = rawCall(mcpClient, 'run_js', {
    tab: tabA,
    expression: `const opened = window.open(${JSON.stringify(`${siteUrl}/perm-a`)}, '_blank'); return 'opened';`,
  });
  const popupPrompt = await waitForPrompt(serviceWorker, (prompt) => prompt.session.id === sessionA.id && prompt.tool === 'run_js');
  await decidePrompt(serviceWorker, popupPrompt.id, 'allow-once');
  const popupResult = await popupCall;
  assert(popupResult.isError !== true, `window.open run_js failed: ${text(popupResult)}`);
  const popupTab = await waitForNewTab(serviceWorker, beforePopup, `${siteUrl}/perm-a`);
  await waitForTabGroup(serviceWorker, popupTab.id, groupA.groupId, 'window.open tab');
  const popupRead = rawCall(mcpClient, 'read', { tab: popupTab.id });
  const popupReadPrompt = await waitForPrompt(serviceWorker, (prompt) => prompt.session.id === sessionA.id && prompt.tool === 'read' && prompt.tab.id === popupTab.id);
  await decidePrompt(serviceWorker, popupReadPrompt.id, 'decline');
  const popupReadResult = await popupRead;
  assert(popupReadResult.isError === true && /Permission declined/.test(text(popupReadResult)), `window.open tab was readable without approval: ${text(popupReadResult)}`);
  console.log(`window.open created grouped tab ${popupTab.id} "${popupTab.title}"; read prompt (kind ${popupReadPrompt.tool}) was declined`);

  // tabs list shows only the origin of a member tab the session has not approved, and the title of one it has.
  const listWithPopup = text(await rawCall(mcpClient, 'tabs', {}));
  const popupLine = listWithPopup.split('\n').find((line) => line.startsWith(`${popupTab.id} `));
  assert(
    new RegExp(`^${popupTab.id}( \\[front\\])? \\[needs approval\\] ${escapeRegExp(siteUrl)}$`).test(popupLine ?? ''),
    `An unapproved member tab shows more than its origin: ${popupLine}\n${listWithPopup}`,
  );
  const approvedLine = listWithPopup.split('\n').find((line) => line.startsWith(`${tabA} `));
  assert(approvedLine?.includes('Permission B'), `An approved member tab lost its title: ${approvedLine}`);
  console.log(`tabs list: unapproved tab ${popupTab.id} shows "${popupLine}"; approved tab ${tabA} shows "${approvedLine}"`);

  await checkReadGrant({ mcpClient, serviceWorker, sessionA, siteUrl, popupTab, tabA });
  await checkRaces({ mcpClient, serviceWorker, sessionA, siteUrl, otherSiteUrl, tabA });

  const restricted = await browserContext.newPage();
  await restricted.goto('chrome://version');
  const restrictedId = await serviceWorker.evaluate(async () => (await chrome.tabs.query({})).find((tab) => tab.url?.startsWith('chrome://version'))?.id);
  assert(Number.isInteger(restrictedId), 'The harness could not find its chrome://version tab');
  await panelRequest(serviceWorker, { type: 'panel.shareTab', sessionId: sessionA.id, tabId: restrictedId });
  const restrictedRead = await rawCall(mcpClient, 'read', { tab: restrictedId });
  assert(restrictedRead.isError === true && /T3-Tab cannot access this page/.test(text(restrictedRead)), `chrome://version was not refused by T3-Tab policy: ${text(restrictedRead)}`);
  console.log(`Restricted page refused by T3-Tab policy: ${text(restrictedRead)}`);
  await restricted.close();


  await page.goto(`${siteUrl}/regex`);
  await page.getByRole('heading', { name: 'Regex timeout' }).waitFor();
  await page.bringToFront();
  await panelRequest(serviceWorker, { type: 'panel.shareTab', sessionId: sessionA.id, tabId: ownerTab.id });
  const started = Date.now();
  const heavy = await rawCall(mcpClient, 'read', { tab: ownerTab.id, find: '(a+)+$', regex: true });
  const elapsed = Date.now() - started;
  assert(heavy.isError === true && /Find regex timed out/.test(text(heavy)), `Regex-heavy find did not time out: ${text(heavy)}`);
  assert(elapsed < 3_000, `Regex-heavy find took ${elapsed} ms`);
  console.log(`Regex-heavy find declined promptly: ${elapsed} ms`);

  assert((await pendingPrompts(serviceWorker)).length === 0, 'Permission checks left a prompt waiting');
  console.log('Permissions: all checks passed');
  return { sessionA, sessionB, tabA, tabB, ownerTabId: ownerTab.id };
}

/** A read prompt's lasting choice grants reading only; the other prompts' lasting choice grants everything. */
async function checkReadGrant({ mcpClient, serviceWorker, sessionA, siteUrl, popupTab, tabA }) {
  const siteSetting = async () =>
    (await panelRequest(serviceWorker, { type: 'panel.state' })).sites.find((site) => site.origin === siteUrl)?.setting;
  const noPrompts = async (label) => assert((await pendingPrompts(serviceWorker)).length === 0, `${label} left a prompt waiting`);
  await setSite(serviceWorker, siteUrl, 'ask');

  const firstRead = rawCall(mcpClient, 'read', { tab: popupTab.id });
  const readPrompt = await waitForPrompt(serviceWorker, (prompt) => prompt.session.id === sessionA.id && prompt.tool === 'read' && prompt.tab.id === popupTab.id);
  await assertDecisionRefused(serviceWorker, readPrompt.id, 'always-allow', /only for reading/);
  await decidePrompt(serviceWorker, readPrompt.id, 'always-allow-read');
  const firstReadResult = await firstRead;
  assert(firstReadResult.isError !== true && text(firstReadResult).includes('# Permission A'), `Always allow reading did not let the read through: ${text(firstReadResult)}`);
  assert((await siteSetting()) === 'read', `Always allow reading stored ${await siteSetting()} for ${siteUrl}, expected read`);
  console.log(`Read prompt, "Always allow reading on this site": site ${siteUrl} is now "read"; always-allow (full) is refused on a read prompt`);

  // A second tab the session has no approval for: reading it needs no prompt, everything else still asks.
  const before = new Set(await serviceWorker.evaluate(async () => (await chrome.tabs.query({})).map((tab) => tab.id)));
  const opener = rawCall(mcpClient, 'run_js', {
    tab: tabA,
    expression: `const opened = window.open(${JSON.stringify(`${siteUrl}/perm-a`)}, '_blank'); return 'opened';`,
  });
  const openerPrompt = await waitForPrompt(serviceWorker, (prompt) => prompt.session.id === sessionA.id && prompt.tool === 'run_js');
  await decidePrompt(serviceWorker, openerPrompt.id, 'allow-once');
  assert((await opener).isError !== true, 'The run_js that opens the second popup failed');
  const second = await waitForNewTab(serviceWorker, before, `${siteUrl}/perm-a`);
  await waitForTabGroup(serviceWorker, second.id, (await tabGroup(serviceWorker, tabA)).groupId, 'second popup');

  const listed = text(await rawCall(mcpClient, 'tabs', {}));
  assert(
    listed.split('\n').some((line) => line.startsWith(`${second.id} `) && line.includes('Permission A') && !line.includes('needs approval')),
    `A tab on a site with a read grant is still hidden:\n${listed}`,
  );
  const silentRead = await withDeadline(rawCall(mcpClient, 'read', { tab: second.id, full: true }), 3_000, 'read on a site with a read grant');
  assert(silentRead.isError !== true && text(silentRead).includes('# Permission A'), `Read on a read-granted site failed: ${text(silentRead)}`);
  await noPrompts('A read on a read-granted site');
  const buttonRef = refFor(text(silentRead), 'button "Action A"');
  assert(buttonRef, `The second popup has no button ref:\n${text(silentRead)}`);

  const declineNext = async (call, tool, label) => {
    const pending = call();
    const prompt = await waitForPrompt(serviceWorker, (candidate) => candidate.session.id === sessionA.id && candidate.tool === tool);
    assert(prompt.origin === siteUrl, `${label} prompted for ${prompt.origin}`);
    await decidePrompt(serviceWorker, prompt.id, 'decline');
    const result = await pending;
    assert(result.isError === true && /Permission declined/.test(text(result)), `${label} was not declined: ${text(result)}`);
  };
  await declineNext(() => rawCall(mcpClient, 'act', { tab: second.id, steps: [{ action: 'click', ref: buttonRef }] }), 'act', 'act on a read-granted site');
  await declineNext(() => rawCall(mcpClient, 'run_js', { tab: second.id, expression: 'document.title' }), 'run_js', 'run_js on a read-granted site');
  await declineNext(() => rawCall(mcpClient, 'tabs', { action: 'open', url: `${siteUrl}/about` }), 'open', 'opening on a read-granted site');
  assert((await siteSetting()) === 'read', 'A declined prompt changed the read grant');
  console.log('Read grant: read needs no prompt; act, run_js and open each still prompt (kinds act, run_js, open) and were declined');

  // The full grant, from an act prompt, covers reading, run_js and opening as well.
  const acting = rawCall(mcpClient, 'act', { tab: second.id, steps: [{ action: 'click', ref: buttonRef }] });
  const actPrompt = await waitForPrompt(serviceWorker, (prompt) => prompt.session.id === sessionA.id && prompt.tool === 'act');
  await assertDecisionRefused(serviceWorker, actPrompt.id, 'always-allow-read', /only from a read request/);
  await decidePrompt(serviceWorker, actPrompt.id, 'always-allow');
  const actingResult = await acting;
  assert(actingResult.isError !== true, `Always allow on an act prompt did not run the act: ${text(actingResult)}`);
  assert((await siteSetting()) === 'allow', `Always allow stored ${await siteSetting()} for ${siteUrl}, expected allow`);
  const quick = async (label, request) => {
    const result = await withDeadline(request, 3_000, label);
    assert(result.isError !== true, `${label} failed: ${text(result)}`);
    await noPrompts(label);
    return result;
  };
  await quick('read on a fully allowed site', rawCall(mcpClient, 'read', { tab: second.id }));
  await quick('run_js on a fully allowed site', rawCall(mcpClient, 'run_js', { tab: second.id, expression: 'document.title' }));
  const openedAbout = await quick('open on a fully allowed site', rawCall(mcpClient, 'tabs', { action: 'open', url: `${siteUrl}/about` }));
  await rawCall(mcpClient, 'tabs', { action: 'close', tab: Number(/^Opened tab (\d+)/.exec(text(openedAbout))?.[1]) });
  console.log('Full grant: after Always allow on an act prompt, read, act, run_js and open all ran without a prompt');

  await rawCall(mcpClient, 'tabs', { action: 'close', tab: second.id });
  await setSite(serviceWorker, siteUrl, 'ask');
}

/** Each check changes the page between the approval and the browser command that uses it. */
async function checkRaces({ mcpClient, serviceWorker, sessionA, siteUrl, otherSiteUrl, tabA }) {
  const decideNext = async (tool) => {
    const prompt = await waitForPrompt(serviceWorker, (candidate) => candidate.session.id === sessionA.id && candidate.tool === tool);
    await decidePrompt(serviceWorker, prompt.id, 'allow-once');
  };
  await waitForTabUrl(serviceWorker, tabA, `${otherSiteUrl}/perm-b`);

  // run_js: an expression that closes the wrapper and reads the page, on a page that replaced the approved one.
  const escapeExpression = '0); })(); ((v)=>(f)=>()=>v)(document.body.innerText)(function(){ return (0';
  await installDebuggerHook(serviceWorker, { method: 'Runtime.evaluate', tabId: tabA, action: 'navigate', url: `${siteUrl}/secret` });
  const escaping = rawCall(mcpClient, 'run_js', { tab: tabA, expression: escapeExpression });
  await decideNext('run_js');
  const escaped = await escaping;
  assert(await hookFired(serviceWorker), 'The run_js race was not exercised: the page never changed before the evaluation');
  assert(!text(escaped).includes('SECRET-OF-SITE-A-INBOX'), `run_js read a page of an unapproved origin: ${text(escaped)}`);
  assert(escaped.isError === true && /page changed before run_js could start/.test(text(escaped)), `The escaping run_js was not refused: ${text(escaped)}`);
  console.log(`run_js escape expression on a tab that moved from ${otherSiteUrl} to ${siteUrl} before it ran: ${text(escaped)}`);

  // screenshot: the page changes while the image is taken, so the image is discarded.
  await waitForTabUrl(serviceWorker, tabA, `${siteUrl}/secret`);
  await installDebuggerHook(serviceWorker, { method: 'Page.captureScreenshot', tabId: tabA, action: 'navigate', url: `${otherSiteUrl}/perm-b` });
  const shooting = rawCall(mcpClient, 'screenshot', { tab: tabA, maxEdge: 320 });
  await decideNext('read');
  const shot = await shooting;
  assert(await hookFired(serviceWorker), 'The screenshot race was not exercised: the page never changed during the capture');
  assert(
    shot.isError === true && /changed while the screenshot was being taken/.test(text(shot)) && !shot.content.some((item) => item.type === 'image'),
    `A screenshot of a page that changed was returned: ${text(shot)}`,
  );
  console.log(`Screenshot on a tab that moved during the capture: ${text(shot)}`);

  // act: input without a ref while the document is replaced on the same origin goes on, as a key press
  // that submits a form does.
  await waitForTabUrl(serviceWorker, tabA, `${otherSiteUrl}/perm-b`);
  await installDebuggerHook(serviceWorker, { method: 'Input.dispatchKeyEvent', tabId: tabA, action: 'reload' });
  const pressing = rawCall(mcpClient, 'act', { tab: tabA, steps: [{ action: 'press', key: 'Tab' }, { action: 'press', key: 'Tab' }] });
  await decideNext('act');
  const pressed = await pressing;
  assert(await hookFired(serviceWorker), 'The act race was not exercised: the document was never replaced during the key press');
  assert(pressed.isError !== true && !/failed/.test(text(pressed)), `A key press into a same-origin replacement was stopped: ${text(pressed)}`);
  assert(text(pressed).includes('Permission B'), `The act reply does not show the replaced page: ${text(pressed)}`);
  console.log(`act press while the document was replaced on the same origin: ran both steps, reply starts "${text(pressed).split('\n')[0]}"`);

  // act: the same, but the new document is on another origin, so the batch stops before step 2.
  await installDebuggerHook(serviceWorker, { method: 'Input.dispatchKeyEvent', tabId: tabA, action: 'navigate', url: `${siteUrl}/secret` });
  const crossing = rawCall(mcpClient, 'act', { tab: tabA, steps: [{ action: 'press', key: 'Tab' }, { action: 'press', key: 'Tab' }] });
  await decideNext('act');
  const crossed = await crossing;
  assert(await hookFired(serviceWorker), 'The cross-origin act race was not exercised: the page never moved during the key press');
  assert(crossed.isError === true && /Step 1 \(press\)/.test(text(crossed)), `A key press into another origin was not stopped: ${text(crossed)}`);
  assert(!/Step 2/.test(text(crossed)), `The batch went on after the page moved to another origin: ${text(crossed)}`);
  assert(!text(crossed).includes('SECRET-OF-SITE-A-INBOX'), `act showed a page of an unapproved origin: ${text(crossed)}`);
  console.log(`act press while the page moved to another origin: ${text(crossed).split('\n')[0]}`);
  assert((await pendingPrompts(serviceWorker)).length === 0, 'The race checks left a prompt waiting');
}

/** One-shot: the next command `method` for `tabId` first changes the page, then goes on. */
async function installDebuggerHook(serviceWorker, hook) {
  await serviceWorker.evaluate(({ method, tabId, action, url }) => {
    const original = chrome.debugger.sendCommand.bind(chrome.debugger);
    globalThis.__t3tabHookFired = false;
    chrome.debugger.sendCommand = async (target, name, params) => {
      if (name === method && target.tabId === tabId && globalThis.__t3tabHookFired === false) {
        globalThis.__t3tabHookFired = true;
        chrome.debugger.sendCommand = original;
        await new Promise((resolve) => {
          const done = (id, info) => {
            if (id !== tabId || info.status !== 'complete') return;
            chrome.tabs.onUpdated.removeListener(done);
            resolve(undefined);
          };
          chrome.tabs.onUpdated.addListener(done);
          if (action === 'reload') void chrome.tabs.reload(tabId);
          else void chrome.tabs.update(tabId, { url });
        });
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
      return await original(target, name, params);
    };
  }, hook);
}

async function hookFired(serviceWorker) {
  return await serviceWorker.evaluate(() => globalThis.__t3tabHookFired === true);
}

async function assertDecisionRefused(serviceWorker, promptId, decision, pattern) {
  let refusal;
  try {
    await decidePrompt(serviceWorker, promptId, decision);
  } catch (error) {
    refusal = error.message;
  }
  assert(refusal !== undefined && pattern.test(refusal), `Decision ${decision} was not refused as expected: ${refusal}`);
}

async function waitForTabGroup(serviceWorker, tabId, groupId, label) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if ((await tabGroup(serviceWorker, tabId)).groupId === groupId) return;
    await sleep(100);
  }
  throw new Error(`${label} ${tabId} is in group ${(await tabGroup(serviceWorker, tabId)).groupId}, expected ${groupId}`);
}

/** A page with a cross-origin iframe: read names the origin it left out and does not return its text. */
export async function checkFrames({ mcpClient, siteUrl, otherSiteUrl }) {
  const frontId = Number(/^(\d+) \[front\]/m.exec(text(await call(mcpClient, 'tabs', {})))?.[1]);
  assert(Number.isInteger(frontId), 'The session has no front tab before the frames check');
  const opened = await call(mcpClient, 'tabs', { action: 'open', url: `${siteUrl}/frames` });
  const tabId = Number(/^Opened tab (\d+)/.exec(text(opened))?.[1]);
  assert(Number.isInteger(tabId), `tabs open: ${text(opened)}`);
  await sleep(500);
  const framed = await call(mcpClient, 'read', { tab: tabId, full: true });
  show('read (page with a cross-origin iframe)', framed);
  assert(framed.isError !== true && text(framed).includes('# Frames page'), `The frames page was not read: ${text(framed)}`);
  assert(!text(framed).includes('Session B private tab'), `The cross-origin iframe's text was returned:\n${text(framed)}`);
  const marks = text(framed).split('\n').filter((line) => line.includes('frame omitted'));
  assert(
    marks.length === 1 && marks[0].includes(`frame omitted: ${otherSiteUrl}`),
    `Expected one line naming ${otherSiteUrl} as an omitted frame, got: ${JSON.stringify(marks)}`,
  );
  const everything = await call(mcpClient, 'read', { tab: tabId, all: true });
  assert(!text(everything).includes('Session B private tab'), 'The cross-origin iframe text came back in all mode');
  console.log(`Cross-origin iframe: read shows "${marks[0].trim()}" and none of its text`);
  await call(mcpClient, 'tabs', { action: 'close', tab: tabId });
  await call(mcpClient, 'tabs', { action: 'switch', tab: frontId });
}

/** The panel shows prompt buttons that say what they grant, locks them again when rows shift, and lists read grants. */
async function assertPromptRows(panelPage, serviceWorker) {
  const base = await panelRequest(serviceWorker, { type: 'panel.state' });
  const session = { id: 'synthetic', name: 'Synthetic session' };
  const prompt = (number, tool, title) => ({ id: `row-${number}`, origin: 'http://synthetic.test', tool, session, tab: { id: 900 + number, title } });
  const show = async (pending, sites = base.sites) => await renderPanelState(panelPage, { ...base, pending, sites });
  const row = (title) => panelPage.locator('li.prompt-card').filter({ hasText: title });
  const disabledStates = async (title) => {
    const states = await row(title).locator('.prompt-btn').evaluateAll((buttons) => buttons.map((button) => button.disabled));
    assert(states.length === 3, `Row "${title}" shows ${states.length} buttons, expected 3`);
    return states;
  };
  const labels = async (title) => await row(title).locator('.prompt-btn-label').allTextContents();
  const allDisabled = async (title) => (await disabledStates(title)).every(Boolean);
  const allEnabled = async (title) => (await disabledStates(title)).every((disabled) => !disabled);
  const settle = async () => await sleep(650);

  const one = prompt(1, 'read', 'Row one');
  const two = prompt(2, 'act', 'Row two');
  await show([one, two]);
  const readLabels = await labels('Row one');
  const actLabels = await labels('Row two');
  assert(JSON.stringify(readLabels) === JSON.stringify(['Allow reading once', 'Decline', 'Always allow reading on this site']), `Read prompt buttons: ${JSON.stringify(readLabels)}`);
  assert(
    JSON.stringify(actLabels) === JSON.stringify(['Allow acting once', 'Decline', 'Always allow everything on this site']),
    `Act prompt buttons: ${JSON.stringify(actLabels)}`,
  );
  await row('Row one').getByText('Opening, acting and JavaScript still ask').waitFor();
  await row('Row two').getByText('Reading, opening, acting and JavaScript').waitFor();
  await settle();
  assert((await allEnabled('Row one')) && (await allEnabled('Row two')), 'Prompt buttons did not enable after the delay');

  await show([two]);
  assert(await allDisabled('Row two'), 'A row that moved up after the row above it went away kept live buttons');
  await settle();
  assert(await allEnabled('Row two'), 'Buttons did not come back after a row went away');

  const zero = prompt(0, 'run_js', 'Row zero');
  await show([zero, two]);
  assert((await allDisabled('Row two')) && (await allDisabled('Row zero')), 'A row pushed down by a new row above it kept live buttons');
  await settle();
  assert((await allEnabled('Row two')) && (await allEnabled('Row zero')), 'Buttons did not come back after a row was inserted');

  const three = prompt(3, 'open', 'Row three');
  await show([zero, two, three]);
  assert(await allEnabled('Row two'), 'A row added below locked the rows above it');
  assert(await allDisabled('Row three'), 'A new row started with live buttons');
  await settle();
  await show([zero, two]);
  assert(await allEnabled('Row two'), 'A row removed below locked the rows above it');
  console.log('Prompt rows: buttons say what they grant; removing or inserting a row above another disabled all buttons for 500 ms; rows added or removed below did not');

  const sites = [
    { origin: 'http://ask.test', setting: 'ask' },
    { origin: 'http://all.test', setting: 'allow' },
    { origin: 'http://read.test', setting: 'read' },
  ];
  await show([], sites);
  await panelPage.locator('#btn-settings').click();
  await panelPage.locator('.settings-tabs').getByRole('button', { name: 'Sites', exact: true }).click();
  const readSite = panelPage.locator('#site-permissions li').filter({ hasText: 'http://read.test' });
  await readSite.getByText('Reading allowed; opening, acting and JavaScript ask').waitFor();
  const readSiteChoices = await readSite.getByRole('radio').evaluateAll((radios) => radios.map((radio) => [radio.getAttribute('aria-label'), radio.getAttribute('aria-checked')]));
  assert(
    JSON.stringify(readSiteChoices) === JSON.stringify([['Ask every time', 'false'], ['Always allow reading', 'true'], ['Always allow everything', 'false']]),
    `Read-only site choices: ${JSON.stringify(readSiteChoices)}`,
  );
  await panelPage.locator('#site-permissions li').filter({ hasText: 'http://all.test' }).getByText('Everything allowed: reading, opening, acting, JavaScript').waitFor();
  console.log('Site list: a read-only grant is shown as "Reading allowed; opening, acting and JavaScript ask"');
  await panelPage.locator('#btn-settings-back').click();
  await show([]);
}

async function assertPromptMetadata(serviceWorker, prompt) {
  const pending = await pendingPrompts(serviceWorker);
  assert(pending[0]?.id === prompt.id, 'The newest prompt is not first in arrival order');
  assertPromptTab(prompt, 'Permission A');
}

async function assertPromptUi(panelPage, serviceWorker, prompt) {
  const state = await panelRequest(serviceWorker, { type: 'panel.state' });
  await renderPanelState(panelPage, state);
  // The prompt names its tab by title and, in a span of the same line, by id, both in the same card.
  const card = panelPage.locator('li.prompt-card').filter({ hasText: `"${prompt.tab.title}"` });
  assert((await card.getAttribute('data-tab-id')) === String(prompt.tab.id), 'The prompt card is not tied to its tab');
  const allow = panelPage.getByRole('button', { name: 'Allow opening once' });
  await allow.waitFor();
  assert(await allow.isDisabled(), 'New prompt buttons were enabled immediately');
  const handle = await allow.elementHandle();
  assert(handle !== null, 'Could not hold the prompt button');
  await handle.evaluate((element) => {
    element.dataset.stabilityCheck = 'kept';
  });
  await sleep(650);
  assert(!(await allow.isDisabled()), 'Prompt buttons did not enable after the short delay');
  await renderPanelState(panelPage, state);
  assert(
    await handle.evaluate((element) => element.isConnected && element.dataset.stabilityCheck === 'kept'),
    'A rendered prompt item was rebuilt instead of kept',
  );
  console.log(`Prompt UI: tab ${prompt.tab.id} "${prompt.tab.title}", buttons delayed, item kept across rerender`);
}

async function renderPanelState(panelPage, state) {
  await panelPage.evaluate((next) => {
    const render = globalThis.__t3tabRenderPanelState;
    if (typeof render !== 'function') throw new Error('Panel renderer is unavailable');
    render(next);
  }, state);
}

function assertPromptTab(prompt, expectedTitle) {
  assert(Number.isInteger(prompt.tab?.id) && prompt.tab.id >= 0, `Prompt has no tab id: ${JSON.stringify(prompt)}`);
  assert(typeof prompt.tab.title === 'string' && prompt.tab.title.length > 0, `Prompt has no tab title: ${JSON.stringify(prompt)}`);
  assert(prompt.tab.title.includes(expectedTitle), `Prompt named "${prompt.tab.title}", expected "${expectedTitle}"`);
}

async function waitForSessions(serviceWorker, minimum) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const state = await panelRequest(serviceWorker, { type: 'panel.state' });
    if (state.sessions?.length >= minimum) return state.sessions;
    await sleep(100);
  }
  throw new Error(`The panel did not list ${minimum} MCP sessions`);
}

async function waitForPrompt(serviceWorker, match) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const prompt = (await pendingPrompts(serviceWorker)).find(match);
    if (prompt !== undefined) return prompt;
    await sleep(100);
  }
  throw new Error('The side panel did not show the expected permission request');
}

export async function pendingPrompts(serviceWorker) {
  const state = await panelRequest(serviceWorker, { type: 'panel.state' });
  return state.pending ?? [];
}

export async function decidePrompt(serviceWorker, promptId, decision) {
  await panelRequest(serviceWorker, { type: 'panel.decide', promptId, decision });
}

async function tabGroup(serviceWorker, tabId) {
  return await serviceWorker.evaluate(async (id) => {
    const tab = await chrome.tabs.get(id);
    if (tab.groupId < 0) return { groupId: tab.groupId, title: '' };
    const group = await chrome.tabGroups.get(tab.groupId);
    return { groupId: tab.groupId, title: group.title ?? '' };
  }, tabId);
}

async function waitForTabUrl(serviceWorker, tabId, expectedUrl) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const tab = await serviceWorker.evaluate(async (id) => await chrome.tabs.get(id), tabId);
    if (tab.url === expectedUrl) return tab;
    await sleep(100);
  }
  throw new Error(`Tab ${tabId} did not navigate to ${expectedUrl}`);
}

async function waitForNewTab(serviceWorker, before, expectedUrl) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const tabs = await serviceWorker.evaluate(async () => (await chrome.tabs.query({})).map((tab) => ({ id: tab.id, url: tab.url, title: tab.title })));
    const found = tabs.find((tab) => tab.id !== undefined && !before.has(tab.id) && tab.url === expectedUrl);
    if (found !== undefined) return found;
    await sleep(100);
  }
  throw new Error(`No new tab committed to ${expectedUrl}`);
}

async function withDeadline(promise, milliseconds, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} did not finish within ${milliseconds} ms`)), milliseconds);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function listsTab(result, tabId) {
  return text(result)
    .split('\n')
    .some((line) => line.startsWith(`${tabId} `));
}
