import { assert, jpegSize, parseStatusTabCount, refFor, sleep, text } from './harness.mjs';
import { decidePrompt, pendingPrompts } from './checks-permissions.mjs';

let autoPromptSessionId;
let permissionServiceWorker;

export function setAutoPrompt(serviceWorker, sessionId) {
  permissionServiceWorker = serviceWorker;
  autoPromptSessionId = sessionId;
}

export async function checkBrowserTools({ mcpClient, page, siteUrl }) {
  const { tools } = await mcpClient.listTools();
  const names = tools.map((tool) => tool.name).sort();
  assert(JSON.stringify(names) === JSON.stringify(['act', 'read', 'run_js', 'screenshot', 'status', 'tabs']), `Unexpected tools: ${names}`);
  const sizes = tools.map((tool) => `${tool.name} ${JSON.stringify(tool).length}`);
  const definitionChars = JSON.stringify(tools).length;
  console.log(
    `Tool definitions: ${definitionChars} characters, about ${Math.round(definitionChars / 4)} tokens (${sizes.join(', ')})`,
  );

  // tabs: list, open, switch, close.
  const listed = await call(mcpClient, 'tabs', {});
  show('tabs list', listed);
  assert(/^\d+ \[front\] T3-Tab E2E — http:\/\/127\.0\.0\.1:\d+\/?$/m.test(text(listed)), `tabs list does not show the front test tab:\n${text(listed)}`);
  const frontId = Number(/^(\d+) \[front\]/m.exec(text(listed))?.[1]);

  const opened = await call(mcpClient, 'tabs', { action: 'open', url: `${siteUrl}/about` });
  show('tabs open', opened);
  assert(/^Opened tab \d+ \[front\] About — /.test(text(opened)), `tabs open: ${text(opened)}`);
  const aboutId = Number(/^Opened tab (\d+)/.exec(text(opened))?.[1]);
  const refusedOpen = await call(mcpClient, 'tabs', { action: 'open', url: 'chrome://settings' });
  assert(refusedOpen.isError === true && /restricted/.test(text(refusedOpen)), `tabs open chrome://: ${text(refusedOpen)}`);
  const switched = await call(mcpClient, 'tabs', { action: 'switch', tab: frontId });
  show('tabs switch', switched);
  assert(text(switched).startsWith(`Switched to tab ${frontId} [current] T3-Tab E2E`), `tabs switch: ${text(switched)}`);
  const closed = await call(mcpClient, 'tabs', { action: 'close', tab: aboutId });
  show('tabs close', closed);
  assert(text(closed) === `Closed tab ${aboutId}.`, `tabs close: ${text(closed)}`);
  assert(!new RegExp(`^${aboutId}\\b`, 'm').test(text(await call(mcpClient, 'tabs', {}))), 'The closed tab is still listed');
  const missingTab = await call(mcpClient, 'tabs', { action: 'close', tab: aboutId });
  assert(missingTab.isError === true && /No tab with id/.test(text(missingTab)), `closing a closed tab: ${text(missingTab)}`);

  // read: the first read of the page is the full text, with refs.
  const first = await call(mcpClient, 'read', {});
  show('read (first)', first);
  const firstText = text(first);
  for (const expected of [
    '# T3-Tab E2E',
    '## Sign up',
    'link "About"',
    'form "Sign up"',
    'textbox "Name"',
    'textbox "Email"',
    'textbox "Password"',
    'combobox "Country"',
    'radio "Free" [checked]',
    'radio "Pro"',
    'checkbox "I agree to the terms"',
    'textbox "Notes"',
    'button "Create account"',
    'button "Show details" [collapsed]',
  ]) {
    assert(firstText.includes(expected), `First read lacks ${expected}:\n${firstText}`);
  }
  assert(/^\s*e\d+ button "Create account"$/m.test(firstText), 'Interactive elements carry a ref');
  assert(!firstText.includes('Release 1.2 notes'), 'The hidden details are not in the first read');
  const refOf = (label) => /^\s*(e\d+) /.exec(firstText.split('\n').find((line) => line.includes(label)) ?? '')?.[1];
  const formRef = refOf('form "Sign up"');
  assert(formRef !== undefined, 'The form has a ref');

  // The page changes: a click reveals a section. The next read is only the difference.
  await page.getByRole('button', { name: 'Show details' }).click();
  const second = await call(mcpClient, 'read', {});
  show('read (after the page changed)', second);
  const secondText = text(second);
  assert(secondText.includes('Changed since the last read:'), `Second read is not a diff:\n${secondText}`);
  assert(secondText.includes('button "Hide details" [expanded]'), 'The diff shows the button now says Hide details');
  assert(secondText.includes('link "Release notes"'), 'The diff shows the new link');
  assert(!secondText.includes('textbox "Name"'), 'The diff leaves out what did not change');
  assert(secondText.length < firstText.length / 2, `The diff (${secondText.length}) is not much shorter than the page (${firstText.length})`);
  const unchanged = await call(mcpClient, 'read', {});
  assert(text(unchanged).endsWith('No changes since the last read.'), `A third read: ${text(unchanged)}`);
  const whole = await call(mcpClient, 'read', { full: true });
  assert(text(whole).includes('textbox "Name"') && text(whole).includes('link "Release notes"'), 'full: true returns the whole page');

  // Typing is a change too, and a password must not come back in clear.
  await page.getByLabel('Name').fill('Ada Lovelace');
  await page.getByLabel('Password').fill('hunter2-secret');
  const typed = await call(mcpClient, 'read', {});
  show('read (after typing)', typed);
  assert(text(typed).includes('value="Ada Lovelace"'), `The typed name is shown:\n${text(typed)}`);
  assert(!text(typed).includes('hunter2'), `The password came back in clear:\n${text(typed)}`);
  assert(!text(typed).includes('•'), `The password length is visible as bullets:\n${text(typed)}`);
  assert(firstText.includes('textbox "Password" value=<redacted>'), 'The password field is not marked redacted');
  const everything = await call(mcpClient, 'read', { all: true });
  assert(!text(everything).includes('hunter2'), 'The password came back in clear in all mode');
  assert(text(everything).includes('textbox "Password" value=<redacted>'), 'The password is not masked in all mode');
  assert(text(everything).includes('Release 1.2 notes are here.'), 'all mode includes the page text');

  // find: only the matching lines.
  const found = await call(mcpClient, 'read', { find: 'password' });
  show('read (find "password")', found);
  assert(/textbox "Password"/.test(text(found)), 'find shows the password field');
  assert(!text(found).includes('link "Contact"'), 'find leaves out the rest of the page');
  assert(text(found).length < firstText.length / 3, `find (${text(found).length}) is not much shorter than the page (${firstText.length})`);
  const foundRegex = await call(mcpClient, 'read', { find: 'link "(about|home)"', regex: true });
  assert(text(foundRegex).includes('link "About"') && text(foundRegex).includes('link "Home"') && !text(foundRegex).includes('link "Contact"'), `find with a regex:\n${text(foundRegex)}`);
  const notFound = await call(mcpClient, 'read', { find: 'no such thing' });
  assert(text(notFound).includes('No matches for "no such thing"'), 'find reports no match');

  // A subtree by ref, with a depth.
  const subtree = await call(mcpClient, 'read', { ref: formRef });
  show(`read (ref ${formRef})`, subtree);
  assert(text(subtree).includes('textbox "Email"') && !text(subtree).includes('link "About"'), 'A ref reads only that element');
  const shallow = await call(mcpClient, 'read', { ref: formRef, depth: 0 });
  assert(text(shallow).split('\n').length === 2, `depth 0 shows only the element:\n${text(shallow)}`);

  // Navigation: the refs held for the page are void, and the next read is the whole new page.
  await page.goto(`${siteUrl}/about`);
  await page.getByRole('heading', { name: 'About' }).waitFor();
  const stale = await call(mcpClient, 'read', { ref: formRef });
  assert(stale.isError === true && /Unknown ref/.test(text(stale)), `A ref from before the navigation: ${text(stale)}`);
  const afterNavigation = await call(mcpClient, 'read', {});
  show('read (after navigation)', afterNavigation);
  assert(!text(afterNavigation).includes('Changed since') && text(afterNavigation).includes('# About'), 'A new page is read in full');
  assert(/^\s*e1 /m.test(text(afterNavigation)), 'Refs start again on a new page');
  await page.goto(siteUrl);
  await page.getByRole('heading', { name: 'T3-Tab E2E' }).waitFor();

  // screenshot: a JPEG whose long edge is at most 1280, in the viewport's proportions.
  const viewportBefore = await settledViewport(page);
  assert(viewportBefore[0] > 1280, `The test window is not wider than 1280: ${viewportBefore}`);
  const shot = await call(mcpClient, 'screenshot', {});
  const image = shot.content.find((item) => item.type === 'image');
  assert(image?.mimeType === 'image/jpeg', 'The screenshot is a JPEG image');
  const size = jpegSize(Buffer.from(image.data, 'base64'));
  assert(size !== undefined, 'The screenshot decodes as a JPEG');
  console.log(
    `--- screenshot (${replySize(shot)}) ---\n${text(shot)}\nimage/jpeg ${size.width}x${size.height}, ${Buffer.from(image.data, 'base64').length} bytes`,
  );
  assert(Math.max(size.width, size.height) <= 1280, `Screenshot is ${size.width}x${size.height}`);
  assert(size.width >= 1270, `A ${viewportBefore[0]} pixel wide viewport is not scaled to about 1280: ${size.width}x${size.height}`);
  assert(
    Math.abs(size.width / size.height - viewportBefore[0] / viewportBefore[1]) < 0.02,
    `The screenshot ${size.width}x${size.height} does not keep the viewport's proportions ${viewportBefore}`,
  );
  assert(text(shot).includes(`viewport ${viewportBefore[0]}x${viewportBefore[1]}`), `The reply names the viewport: ${text(shot)}`);
  const small = await call(mcpClient, 'screenshot', { maxEdge: 640 });
  const smallImage = small.content.find((item) => item.type === 'image');
  const smallSize = jpegSize(Buffer.from(smallImage.data, 'base64'));
  console.log(`--- screenshot maxEdge 640 (${replySize(small)}) ---\n${text(small)}\nimage/jpeg ${smallSize.width}x${smallSize.height}`);
  assert(Math.max(smallSize.width, smallSize.height) <= 640 && smallSize.width >= 630, `maxEdge 640 gave ${smallSize.width}x${smallSize.height}`);
  console.log('Browser tools: all checks passed');
}

export async function checkActionTools({ mcpClient, page }) {
  await page.getByRole('heading', { name: 'T3-Tab E2E' }).waitFor();
  await page.getByLabel('Name').fill('Old Name');
  const before = await call(mcpClient, 'read', { full: true });
  show('read before act', before);
  const beforeText = text(before);
  assert(beforeText.includes('textbox "Name" value="Old Name" [required]'), `The prefilled name is missing:\n${beforeText}`);
  const nameRef = refFor(beforeText, 'textbox "Name"');
  const emailRef = refFor(beforeText, 'textbox "Email"');
  const submitRef = refFor(beforeText, 'button "Create account"');
  assert(nameRef && emailRef && submitRef, `The form refs are missing:\n${beforeText}`);

  const acted = await call(mcpClient, 'act', {
    steps: [
      { action: 'fill', ref: nameRef, text: 'Ada Lovelace' },
      { action: 'fill', ref: emailRef, text: 'ada@example.com' },
      { action: 'click', ref: submitRef },
    ],
  });
  show('act (fill, fill, click)', acted);
  assert(acted.isError !== true, `act failed: ${text(acted)}`);
  assert(/Changed since the last read:/.test(text(acted)), `act did not return a diff:\n${text(acted)}`);
  assert(text(acted).includes('Welcome Ada Lovelace (ada@example.com)'), `act did not show the form result:\n${text(acted)}`);

  // A step that is missing a field, carries one its action does not take, or is in the old nested form is
  // refused with a message that says what is wrong, before anything reaches the page.
  for (const [bad, expected] of [
    [{ action: 'click' }, /click needs ref/],
    [{ action: 'click', ref: submitRef, text: 'x' }, /click does not take text/],
    [{ action: 'wait', ms: 99_999 }, /wait ms must be a whole number from 0 to 10000/],
    [{ action: 'scroll' }, /scroll needs either ref or dx\/dy/],
    [{ click: { ref: submitRef } }, /action/],
  ]) {
    const refusedStep = await rawCall(mcpClient, 'act', { steps: [bad] });
    assert(refusedStep.isError === true && expected.test(text(refusedStep)), `act accepted or mis-described ${JSON.stringify(bad)}: ${text(refusedStep)}`);
  }
  const unchangedForm = await call(mcpClient, 'read', {});
  assert(text(unchangedForm).endsWith('No changes since the last read.'), `A refused step changed the page: ${text(unchangedForm)}`);

  const title = await call(mcpClient, 'run_js', { expression: 'document.title' });
  show('run_js document.title', title);
  assert(title.isError !== true && text(title) === '"T3-Tab E2E"', `run_js returned: ${text(title)}`);
  const bodyTitle = await call(mcpClient, 'run_js', { expression: 'return document.title;' });
  show('run_js async body', bodyTitle);
  assert(bodyTitle.isError !== true && text(bodyTitle) === '"T3-Tab E2E"', `run_js body returned: ${text(bodyTitle)}`);

  const fresh = await call(mcpClient, 'read', { full: true });
  const freshText = text(fresh);
  const aboutRef = refFor(freshText, 'link "About"');
  const staleRef = refFor(freshText, 'textbox "Name"');
  assert(aboutRef && staleRef, `Navigation refs are missing:\n${freshText}`);
  const stale = await call(mcpClient, 'act', {
    steps: [{ action: 'click', ref: aboutRef }, { action: 'click', ref: staleRef }],
  });
  show('act (click navigation, then stale ref)', stale);
  assert(stale.isError === true, `A ref from before navigation was accepted: ${text(stale)}`);
  assert(
    new RegExp(`${staleRef} is no longer on the page; read again`).test(text(stale)),
    `The stale-ref error is unclear: ${text(stale)}`,
  );
  assert(text(stale).includes('# About'), `The failed act has no page diff after navigation: ${text(stale)}`);

  // A key press without a ref that submits a form replaces the document on the same origin: that is not
  // an error, and the reply shows the new page.
  await page.goto(new URL('/search', page.url()).href);
  await page.getByRole('heading', { name: 'Search' }).waitFor();
  const searchRef = refFor(text(await call(mcpClient, 'read', { full: true })), 'textbox "Query"');
  assert(searchRef, 'The search box ref is missing');
  const submitted = await call(mcpClient, 'act', { steps: [{ action: 'fill', ref: searchRef, text: 'refs' }, { action: 'press', key: 'Enter' }] });
  show('act (fill, press Enter submits the form)', submitted);
  assert(submitted.isError !== true, `Enter that submits a form failed: ${text(submitted)}`);
  assert(text(submitted).includes('# About') && page.url().includes('/about?q=refs'), `Enter did not submit the form: ${text(submitted)} at ${page.url()}`);
  console.log('Act, stale ref and run_js: all checks passed');
}

export async function checkKeepalive(mcpClient) {
  console.log('Keepalive: waiting 36 seconds past the service worker idle timeout...');
  await new Promise((resolve) => setTimeout(resolve, 36_000));
  const result = await call(mcpClient, 'status', {});
  show('status after 36s idle', result);
  assert(/^Browsers: 1$/m.test(text(result)), `The extension did not stay connected: ${text(result)}`);
  assert(parseStatusTabCount(text(result)) >= 1, `The kept-alive browser reported no tabs: ${text(result)}`);
  console.log('Keepalive after 36s: passed');
}

/** The page's viewport once it stops changing: attaching the debugger makes the browser show a banner, which resizes it. */
async function settledViewport(page) {
  let previous = '';
  let steady = 0;
  for (let attempt = 0; attempt < 40 && steady < 4; attempt += 1) {
    const size = await page.evaluate(() => [innerWidth, innerHeight]);
    steady = JSON.stringify(size) === previous ? steady + 1 : 0;
    previous = JSON.stringify(size);
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  assert(steady >= 4, `The viewport kept changing: ${previous}`);
  return JSON.parse(previous);
}

export async function rawCall(client, name, args) {
  return await client.callTool({ name, arguments: args });
}

export async function call(client, name, args) {
  if (autoPromptSessionId === undefined) return await rawCall(client, name, args);
  const result = rawCall(client, name, args);
  let settled = false;
  void result.then(
    () => { settled = true; },
    () => { settled = true; },
  );
  const decided = new Set();
  while (!settled) {
    const prompts = await pendingPrompts(permissionServiceWorker).catch(() => []);
    for (const prompt of prompts) {
      if (prompt.session.id !== autoPromptSessionId || decided.has(prompt.id)) continue;
      decided.add(prompt.id);
      await decidePrompt(permissionServiceWorker, prompt.id, 'allow-once');
    }
    if (!settled) await sleep(75);
  }
  return await result;
}

function replySize(result) {
  const characters = result.content.reduce((total, item) => total + (item.type === 'text' ? item.text.length : item.data.length), 0);
  return `${characters} characters${result.isError === true ? ', error' : ''}`;
}

export function show(label, result) {
  console.log(`--- ${label} (${replySize(result)}) ---\n${text(result)}`);
}
