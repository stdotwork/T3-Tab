// Approving only what the owner saw and chose, on the headless panel: a thread waiting on a T3 approval with browser
// prompts drawn from supplied state. The panel's `panel.decide` requests are recorded by a bridge and its T3 client's
// answers by a stand-in for `respond`, so a check can see an answer that was given and one that was not.
import { assert, panelRequest, sleep } from './harness.mjs';

const SETTLED = 700;
const session = { id: 'keys-session', name: 'Claude Code' };
const prompt = (id, tool, extra = {}) => ({ id, origin: 'http://127.0.0.1:41889', tool, session, tab: { id: 4242, title: `Card ${id}` }, ...extra });
const command = (requestId, options, extra = {}) => ({ requestId, responseCapability: 'live', kind: 'command', title: `npm run ${requestId}`, detail: 'in /tmp/keys-project', options, ...extra });
const BOTH = [
  { decision: 'decline', label: 'Decline' },
  { decision: 'acceptForSession', label: 'Always allow this session' },
  { decision: 'accept', label: 'Approve' },
];

export async function checkApprovalKeys({ panelPage: page, serviceWorker }) {
  await page.setViewportSize({ width: 400, height: 760 });
  await page.emulateMedia({ colorScheme: 'light' });
  await page.evaluate(() => {
    window.__decided = [];
    window.__responded = [];
    window.__t3tabPanelBridge = async (request) => {
      if (request.type === 'panel.decide') {
        window.__decided.push(request);
        return { ok: true };
      }
      return await chrome.runtime.sendMessage(request);
    };
    const client = window.__t3tabT3;
    client.respond = async (_thread, requestId, answer) => {
      window.__responded.push({ requestId, ...answer });
    };
    const at = new Date(Date.now() - 600_000).toISOString();
    client.set({ status: 'ready' });
    client.onConfig({ type: 'snapshot', config: { providers: [], settings: {}, environment: { capabilities: {} } } });
    client.onShell({
      kind: 'snapshot',
      snapshot: {
        threads: [{ id: 'keys-thread', projectId: 'keys-project', title: 'Keys thread', status: 'running', interactionMode: 'default', createdAt: at, updatedAt: at, latestRunId: 'run-k', latestRunRequestedAt: at, latestRunStartedAt: at, latestRunCompletedAt: null, activeRunId: 'run-k', activityRunStatus: 'waiting', pendingRuntimeRequest: null, lineage: { relationshipToParent: null, parentThreadId: null }, archivedAt: null, settledOverride: null, settledAt: null }],
        projects: [{ id: 'keys-project', title: 'keys-project', workspaceRoot: '/tmp/keys-project' }],
      },
    });
    client.watches.set('keys-thread', { listeners: new Set(), stop() {} });
  });
  /** Hands the thread a view: its T3 approval, inline at its work-log row or not, after `before` user messages. */
  const view = async (approval, { inline = false, before = 1 } = {}) =>
    await page.evaluate(
      ([pending, atRow, count]) => {
        const rows = Array.from({ length: count }, (_, index) => ({ kind: 'user', id: `u${index}`, text: `Message ${index + 1}: restyle the checkout button and check the build`, at: Date.now() - 120_000 }));
        const entries = [{ id: 'e1', icon: 'edit', label: 'Edited checkout.css', status: 'done' }, ...(pending === null ? [] : [{ id: 'e-approval', icon: 'approval', label: 'Waiting for approval', status: 'waiting' }])];
        rows.push({ kind: 'work', id: 'w1', running: true, startedAt: Date.now() - 100_000, entries });
        const next = { id: 'keys-thread', source: 't3', title: 'Keys thread', running: false, failed: false, queued: [], projectId: 'keys-project', rows, ...(pending === null ? {} : { approval: { ...pending, ...(atRow ? { entryId: 'e-approval' } : {}) } }) };
        const watch = window.__t3tabT3.watches.get('keys-thread');
        watch.view = next;
        for (const listener of watch.listeners) listener(next);
      },
      [approval, inline, before],
    );
  const prompts = async (pending) => await page.evaluate((next) => globalThis.__t3tabRenderPanelState({ pending: next, sites: [], currentTab: { id: 4242, title: 'Card', url: 'http://127.0.0.1:41889/' } }), pending);
  const decided = async () => await page.evaluate(() => window.__decided.map((entry) => `${entry.promptId}:${entry.decision}`));
  const responded = async () => await page.evaluate(() => window.__responded.map((entry) => `${entry.requestId}:${entry.decision}`));
  const keyed = async () =>
    await page.evaluate(() => {
      const cards = [...document.querySelectorAll('.approval-card[data-keyed]')];
      return cards.map((card) => card.closest('[data-prompt-id]')?.getAttribute('data-prompt-id') ?? card.getAttribute('data-request-id'));
    });
  const card = (requestId) => page.locator(`.approval-card[data-request-id="${requestId}"]`);
  const promptCard = (id) => page.locator(`li.prompt-card[data-prompt-id="${id}"] .approval-card`);
  const blur = async () => await page.evaluate(() => document.activeElement?.blur());

  await view(null);
  await page.locator('#btn-threads').click();
  await page.locator('.thread-row').filter({ hasText: 'Keys thread' }).first().click();
  await page.locator('.screen[data-thread-id="keys-thread"]').waitFor();
  await blur();

  // 1. A browser prompt above a T3 approval goes: the approval is locked at once, to clicks and keys alike.
  await view(command('r1', BOTH));
  await prompts([prompt('p1', 'act')]);
  await card('r1').waitFor();
  await sleep(SETTLED);
  assert(JSON.stringify(await keyed()) === JSON.stringify(['p1']), `The browser prompt above is not the keyed card: ${JSON.stringify(await keyed())}`);
  const primary = promptCard('p1').locator('.answer-btn.primary');
  const box = await primary.boundingBox();
  await primary.click();
  await prompts([]);
  const t3Buttons = await card('r1').locator('.answer-btn').evaluateAll((buttons) => buttons.map((button) => button.disabled));
  assert(t3Buttons.length === 3 && t3Buttons.every(Boolean), `The T3 approval was not locked when the prompt above it went: ${JSON.stringify(t3Buttons)}`);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.keyboard.press('Enter');
  await sleep(100);
  assert((await responded()).length === 0, `A second click or Enter right after the prompt went answered the T3 approval: ${JSON.stringify(await responded())}`);
  assert(JSON.stringify(await decided()) === JSON.stringify(['p1:allow-once']), `The prompt was answered other than once: ${JSON.stringify(await decided())}`);
  await sleep(SETTLED);
  // As in T3's own client, a T3 approval takes clicks only: never keyed, no key hints, Enter and Escape give nothing.
  assert((await keyed()).length === 0 && (await card('r1').locator('.key-hint').count()) === 0, `A T3 approval took the keys: ${JSON.stringify(await keyed())}`);
  await page.keyboard.press('Enter');
  await page.keyboard.press('Escape');
  await sleep(100);
  assert((await responded()).length === 0, `A key answered a T3 approval: ${JSON.stringify(await responded())}`);
  await card('r1').locator('.answer-btn.primary').click();
  await sleep(100);
  assert(JSON.stringify(await responded()) === JSON.stringify(['r1:accept']), `A click on the settled T3 approval: ${JSON.stringify(await responded())}`);
  console.log('Approval keys: a T3 approval under a browser prompt was locked when the prompt went (a second click and an Enter at once answered nothing); it takes no keys at all, and a later click approved it');

  // 5. An Enter still held from the answer before answers nothing on the next card until it is released.
  await view(null);
  await prompts([prompt('h1', 'act'), prompt('h2', 'read')]);
  await promptCard('h2').waitFor();
  await sleep(SETTLED);
  await page.keyboard.down('Enter');
  await sleep(50);
  assert((await decided()).includes('h1:allow-once'), `The held Enter did not answer the card it began on: ${JSON.stringify(await decided())}`);
  await prompts([prompt('h2', 'read')]);
  await sleep(SETTLED);
  assert(JSON.stringify(await keyed()) === JSON.stringify(['h2']), `The next card is not keyed: ${JSON.stringify(await keyed())}`);
  await page.evaluate(() => document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })));
  await sleep(100);
  assert(!(await decided()).includes('h2:allow-once'), 'A keydown while the Enter that answered the card before was still held answered the next card');
  await page.keyboard.up('Enter');
  await page.keyboard.press('Enter');
  await sleep(100);
  assert((await decided()).includes('h2:allow-once'), `A fresh Enter after the release did not answer: ${JSON.stringify(await decided())}`);
  await prompts([]);
  console.log('Approval keys: an Enter held through the change of card answered nothing until it was released');

  // Keys never answer a card something covers: with the new-thread screen's project popover open, Enter gives nothing;
  // once it is closed, it does.
  await page.locator('#btn-new').click();
  await page.locator('.hero h1').waitFor();
  await prompts([prompt('c1', 'act')]);
  await promptCard('c1').waitFor();
  await sleep(SETTLED);
  // T3's project picker, or the folder picker of a direct run: both open a popover with role dialog.
  await page.locator('.hero button').first().click();
  await page.locator('.popover[role="dialog"]').waitFor();
  await blur();
  await page.keyboard.press('Enter');
  await sleep(100);
  assert(!(await decided()).includes('c1:allow-once'), 'Enter answered a card while a popover was open');
  await page.mouse.click(5, 5);
  assert((await page.locator('.popover').count()) === 0, 'The popover did not close');
  await blur();
  await page.keyboard.press('Enter');
  await sleep(100);
  assert((await decided()).includes('c1:allow-once'), `Enter did not answer once the popover closed: ${JSON.stringify(await decided())}`);
  await prompts([]);
  await page.locator('#btn-threads').click();
  await page.locator('.thread-row').filter({ hasText: 'Keys thread' }).first().click();
  await page.locator('.screen[data-thread-id="keys-thread"]').waitFor();
  await blur();
  console.log('Approval keys: with the project popover open, Enter answered nothing; once it closed, Enter answered');

  // Shown again after it was hidden, the panel locks every card for a moment.
  await prompts([prompt('v1', 'act')]);
  await promptCard('v1').waitFor();
  await sleep(SETTLED);
  assert(!(await promptCard('v1').locator('.answer-btn.primary').isDisabled()), 'The card did not settle');
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  assert(await promptCard('v1').locator('.answer-btn.primary').isDisabled(), 'The card was not locked when the panel was shown again');
  await page.keyboard.press('Enter');
  await sleep(100);
  assert(!(await decided()).includes('v1:allow-once'), 'Enter answered a card right after the panel was shown again');
  await sleep(SETTLED);
  assert(!(await promptCard('v1').locator('.answer-btn.primary').isDisabled()), 'The card did not unlock after the panel was shown again');
  await prompts([]);
  console.log('Approval keys: the panel shown again locked its cards for a moment');

  // 2. A card scrolled out of view is never keyed: the list's first card, and a T3 approval scrolled off the work log.
  await view(null);
  await page.setViewportSize({ width: 400, height: 440 });
  await prompts([prompt('q1', 'act'), prompt('q2', 'read'), prompt('q3', 'run_js')]);
  await promptCard('q3').waitFor({ state: 'attached' });
  await sleep(SETTLED);
  assert(JSON.stringify(await keyed()) === JSON.stringify(['q1']), `With the list at its top, keyed: ${JSON.stringify(await keyed())}`);
  await page.locator('.prompt-list').evaluate((list) => list.scrollTo(0, list.scrollHeight));
  await sleep(SETTLED);
  const scrolledKeyed = await keyed();
  assert(scrolledKeyed.length === 1 && scrolledKeyed[0] !== 'q1', `With the list scrolled down, the first card is still keyed: ${JSON.stringify(scrolledKeyed)}`);
  const q1Shown = await promptCard('q1').evaluate((node) => {
    const list = node.closest('.prompt-list').getBoundingClientRect();
    const rect = node.getBoundingClientRect();
    return rect.top >= list.top - 0.5 && rect.bottom <= list.bottom + 0.5;
  });
  assert(!q1Shown, 'The first card stayed fully on screen, so the scroll check checked nothing');
  await page.keyboard.press('Enter');
  await sleep(100);
  const afterScroll = await decided();
  assert(afterScroll.at(-1) === `${scrolledKeyed[0]}:allow-once` && !afterScroll.includes('q1:allow-once'), `Enter answered a card out of view: ${JSON.stringify(afterScroll)}`);
  await prompts([]);
  await page.setViewportSize({ width: 400, height: 760 });
  console.log(`Approval keys: with the prompt list scrolled, Enter answered ${scrolledKeyed[0]}, not the first card out of view`);

  // 3. No answer T3 did not offer: without accept there is no primary button and Enter gives nothing; without decline, Escape.
  await view(command('r4', [{ decision: 'acceptForSession', label: 'Always allow this session' }, { decision: 'cancel', label: 'Cancel' }]));
  await card('r4').waitFor();
  await sleep(SETTLED);
  const drawn = await card('r4').locator('.answer-btn').evaluateAll((buttons) => buttons.map((button) => button.dataset.decision ?? button.getAttribute('aria-label')));
  assert(JSON.stringify(drawn) === JSON.stringify(['More approval options']), `A T3 approval without accept or decline drew ${JSON.stringify(drawn)}`);
  await blur();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Escape');
  await sleep(100);
  assert(!(await responded()).some((entry) => entry.startsWith('r4:')), `A key gave an answer T3 did not offer: ${JSON.stringify(await responded())}`);
  console.log('Approval keys: a T3 approval offering neither accept nor decline drew only More, and Enter and Escape gave nothing');

  // T3's warning on an answer; the card named by its ask line; no answer once T3 says the provider is gone.
  await view(command('r5', [{ decision: 'decline', label: 'Decline' }, { decision: 'accept', label: 'Approve', warning: 'Runs outside the sandbox' }]));
  await card('r5').waitFor();
  await sleep(SETTLED);
  const approve = card('r5').locator('.answer-btn.primary');
  assert((await approve.getAttribute('aria-description')) === 'Runs outside the sandbox' && (await approve.locator('.answer-warning').count()) === 1, 'T3\'s warning is not shown on its answer');
  await page.getByRole('group', { name: 'Run npm run r5' }).waitFor();
  await view(command('r6', BOTH, { responseCapability: 'not_resumable' }));
  await card('r6').waitFor();
  await sleep(SETTLED);
  const goneButtons = await card('r6').locator('.answer-btn').evaluateAll((buttons) => buttons.map((button) => button.disabled));
  assert(goneButtons.length === 3 && goneButtons.every(Boolean), `A T3 approval T3 cannot take an answer for has live buttons: ${JSON.stringify(goneButtons)}`);
  await card('r6').getByText('Provider process is gone. Interrupt or restart the run to respond.').waitFor();
  await card('r6').locator('.answer-btn.primary').click({ force: true });
  await sleep(100);
  assert(!(await responded()).some((entry) => entry.startsWith('r6:')), `A T3 approval whose provider is gone was answered: ${JSON.stringify(await responded())}`);
  console.log('Approval keys: T3\'s warning is on its answer; the card is named by its ask; with the provider gone the card says so in T3\'s words and takes no answer');

  // Escape declines only from the panel body or the card, never from another control.
  await view(null);
  await prompts([prompt('x1', 'act')]);
  await promptCard('x1').waitFor();
  await sleep(SETTLED);
  await page.locator('#btn-settings').focus();
  await page.keyboard.press('Escape');
  await sleep(100);
  assert(!(await decided()).includes('x1:decline'), 'Escape on another control declined the card');
  await blur();
  await page.keyboard.press('Escape');
  await sleep(100);
  assert((await decided()).includes('x1:decline'), `Escape from the panel body did not decline: ${JSON.stringify(await decided())}`);
  await prompts([]);
  console.log('Approval keys: Escape on another control did nothing, and from the panel body declined');

  // 4. A goto names its address and the tab it moves, and says when that is another tab.
  await view(null);
  await prompts([prompt('g1', 'open', { url: 'https://shop.test/cart?step=2', tab: { id: 9001, title: 'Checkout' } })]);
  const gotoCard = promptCard('g1');
  await gotoCard.waitFor();
  const gotoText = await gotoCard.innerText();
  assert(gotoText.includes('https://shop.test/cart?step=2') && gotoText.includes('in "Checkout"') && gotoText.includes('On another tab') && gotoText.includes('Go to tab'), `A goto card reads:\n${gotoText}`);
  console.log('Approval keys: a goto card names the address, in "Checkout", and that it is another tab');

  await prompts([]);
  await page.evaluate(() => {
    const client = window.__t3tabT3;
    delete client.respond;
    client.watches.delete('keys-thread');
    client.onShell({ kind: 'snapshot', snapshot: { threads: [], projects: [] } });
    client.set({ status: 'off' });
    delete window.__t3tabPanelBridge;
    delete window.__decided;
    delete window.__responded;
  });
  if ((await page.locator('#btn-new').count()) > 0 && (await page.locator('#btn-new').isEnabled())) await page.locator('#btn-new').click();
  await page.setViewportSize({ width: 360, height: 800 });
  await page.evaluate((next) => globalThis.__t3tabRenderPanelState(next), await panelRequest(serviceWorker, { type: 'panel.state' }));
}
