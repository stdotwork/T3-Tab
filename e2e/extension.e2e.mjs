import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { chromium } from 'playwright';

const execFileAsync = promisify(execFile);
const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const extensionDir =
  process.env.T3_TAB_E2E_EXTENSION_DIR ?? join(rootDir, 'packages/extension/.output/chrome-mv3');
const cliPath = join(rootDir, 'packages/server/dist/cli.js');
const tempHome = await mkdtemp(join(tmpdir(), 't3-tab-e2e-'));
const profileDir = join(tempHome, '.config', 'chromium');
const stateDir = join(tempHome, '.local', 'state', 't3-tab');
const statePath = join(stateDir, 'daemon.json');
const childEnv = cleanEnv({
  ...process.env,
  HOME: tempHome,
  XDG_STATE_HOME: join(tempHome, '.local', 'state'),
  XDG_CONFIG_HOME: join(tempHome, '.config'),
  XDG_CACHE_HOME: join(tempHome, '.cache'),
  XDG_DATA_HOME: join(tempHome, '.local', 'share'),
});

const SITE_NOT_FOUND = '<!doctype html><html lang="en"><head><title>Not found</title></head><body><h1>Not found</h1></body></html>';

const SITE = {
  '/': `<!doctype html>
<html lang="en">
  <head><meta charset="UTF-8" /><title>T3-Tab E2E</title></head>
  <body>
    <h1>T3-Tab E2E</h1>
    <nav aria-label="Main">
      <a href="/">Home</a> <a href="/about">About</a> <a href="/docs">Docs</a> <a href="/contact">Contact</a>
    </nav>
    <main>
      <h2>Sign up</h2>
      <form aria-label="Sign up" onsubmit="return false">
        <label>Name <input name="name" type="text" required></label>
        <label>Email <input name="email" type="email"></label>
        <label>Password <input name="password" type="password"></label>
        <label>Country
          <select name="country"><option>Australia</option><option>Brazil</option><option>Canada</option></select>
        </label>
        <fieldset>
          <legend>Plan</legend>
          <label><input type="radio" name="plan" value="free" checked> Free</label>
          <label><input type="radio" name="plan" value="pro"> Pro</label>
        </fieldset>
        <label><input type="checkbox" name="terms"> I agree to the terms</label>
        <label>Notes <textarea name="notes"></textarea></label>
        <button type="submit">Create account</button>
        <button type="reset">Reset</button>
      </form>
      <h2>Details</h2>
      <button id="toggle" aria-expanded="false">Show details</button>
      <section id="details" hidden>
        <p>Release 1.2 notes are here.</p>
        <a href="/notes">Release notes</a>
      </section>
    </main>
    <script>
      const toggle = document.getElementById('toggle');
      const details = document.getElementById('details');
      toggle.addEventListener('click', () => {
        const open = details.hidden;
        details.hidden = !open;
        toggle.textContent = open ? 'Hide details' : 'Show details';
        toggle.setAttribute('aria-expanded', String(open));
      });
    </script>
  </body>
</html>`,
  '/about': `<!doctype html>
<html lang="en">
  <head><meta charset="UTF-8" /><title>About</title></head>
  <body>
    <h1>About</h1>
    <p>A page to open and read next to the main one.</p>
    <a href="/">Back home</a>
  </body>
</html>`,
};

let browserContext;
let mcpClient;
let mcpTransport;
let pageServer;

try {
  await stat(join(extensionDir, 'manifest.json'));
  await mkdir(profileDir, { recursive: true });

  pageServer = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    const body = SITE[path];
    response.writeHead(body === undefined ? 404 : 200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(body ?? SITE_NOT_FOUND);
  });

  await new Promise((resolve, reject) => {
    pageServer.once('error', reject);
    pageServer.listen(0, '127.0.0.1', resolve);
  });

  const address = pageServer.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Test page server did not bind to a TCP address');
  }

  await execFileAsync(
    process.execPath,
    [cliPath, 'native-host', 'install', '--browser', 'chromium'],
    { env: childEnv },
  );

  browserContext = await chromium.launchPersistentContext(profileDir, {
    channel: 'chromium',
    headless: true,
    // No viewport emulation: the window is wider than 1280, so a screenshot has to be scaled down.
    viewport: null,
    env: childEnv,
    args: [
      '--window-size=1600,1000',
      `--disable-extensions-except=${extensionDir}`,
      `--load-extension=${extensionDir}`,
    ],
  });

  const page = browserContext.pages()[0] ?? (await browserContext.newPage());
  await page.goto(`http://127.0.0.1:${address.port}`);
  await page.getByRole('heading', { name: 'T3-Tab E2E' }).waitFor();
  const siteUrl = `http://127.0.0.1:${address.port}`;

  const isExtensionWorker = (worker) => worker.url().startsWith('chrome-extension://');
  let serviceWorker = browserContext.serviceWorkers().find(isExtensionWorker);
  if (serviceWorker === undefined) {
    serviceWorker = await browserContext.waitForEvent('serviceworker', {
      predicate: isExtensionWorker,
      timeout: 15_000,
    });
  }

  const extensionId = await serviceWorker.evaluate(() => chrome.runtime.id);
  if (!/^[a-p]{32}$/.test(extensionId)) {
    throw new Error(`Unexpected extension id from service worker: ${extensionId}`);
  }
  console.log(`Extension ID: ${extensionId}`);

  mcpTransport = new StdioClientTransport({
    command: process.execPath,
    args: [cliPath, 'mcp'],
    env: childEnv,
    stderr: 'pipe',
  });
  mcpTransport.stderr?.on('data', (chunk) => process.stderr.write(chunk));
  mcpClient = new Client({ name: 't3-tab-e2e', version: '1.0.0' });
  await mcpClient.connect(mcpTransport);

  let statusText = '';
  let tabCount = 0;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const result = await mcpClient.callTool({ name: 'status', arguments: {} });
    statusText = result.content
      .filter((item) => item.type === 'text')
      .map((item) => item.text)
      .join('\n');
    tabCount = parseStatusTabCount(statusText);
    if (/^Browsers: 1$/m.test(statusText) && tabCount >= 1) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  if (!/^Browsers: 1$/m.test(statusText) || tabCount < 1) {
    throw new Error(`Expected one connected browser with at least one tab. Got:\n${statusText}`);
  }
  console.log(`MCP status result:\n${statusText}`);

  const state = JSON.parse(await readFile(statePath, 'utf8'));
  if (typeof state.port !== 'number') {
    throw new Error(`Daemon state has no port: ${JSON.stringify(state)}`);
  }
  const refused = await wrongTokenIsRefused(state.port);
  if (!refused) {
    throw new Error('A control connection with the wrong token was accepted');
  }
  console.log('Wrong-token control connection: refused');

  await checkBrowserTools({ mcpClient, page, siteUrl });
} finally {
  if (mcpClient !== undefined) {
    await mcpClient.close().catch(() => undefined);
  }
  if (browserContext !== undefined) {
    await browserContext.close();
  }
  if (pageServer !== undefined) {
    await new Promise((resolve, reject) => {
      pageServer.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }
  await stopDaemon();
  await rm(tempHome, { recursive: true, force: true });
}

async function checkBrowserTools({ mcpClient, page, siteUrl }) {
  const { tools } = await mcpClient.listTools();
  const names = tools.map((tool) => tool.name).sort();
  assert(JSON.stringify(names) === JSON.stringify(['read', 'screenshot', 'status', 'tabs']), `Unexpected tools: ${names}`);
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
  assert(refusedOpen.isError === true && /Only http and https/.test(text(refusedOpen)), `tabs open chrome://: ${text(refusedOpen)}`);
  const switched = await call(mcpClient, 'tabs', { action: 'switch', tab: frontId });
  show('tabs switch', switched);
  assert(text(switched).startsWith(`Switched to tab ${frontId} [front] T3-Tab E2E`), `tabs switch: ${text(switched)}`);
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
  const everything = await call(mcpClient, 'read', { all: true });
  assert(!text(everything).includes('hunter2'), 'The password came back in clear in all mode');
  assert(text(everything).includes('Release 1.2 notes are here.'), 'all mode includes the page text');

  // find: only the matching lines.
  const found = await call(mcpClient, 'read', { find: 'password' });
  show('read (find "password")', found);
  assert(/textbox "Password"/.test(text(found)), 'find shows the password field');
  assert(!text(found).includes('link "Contact"'), 'find leaves out the rest of the page');
  assert(text(found).length < firstText.length / 3, `find (${text(found).length}) is not much shorter than the page (${firstText.length})`);
  const foundRegex = await call(mcpClient, 'read', { find: 'link "(about|home)"' });
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

async function call(client, name, args) {
  return await client.callTool({ name, arguments: args });
}

function text(result) {
  return result.content
    .filter((item) => item.type === 'text')
    .map((item) => item.text)
    .join('\n');
}

function replySize(result) {
  const characters = result.content.reduce((total, item) => total + (item.type === 'text' ? item.text.length : item.data.length), 0);
  return `${characters} characters${result.isError === true ? ', error' : ''}`;
}

function show(label, result) {
  console.log(`--- ${label} (${replySize(result)}) ---\n${text(result)}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

/** Pixel size of a JPEG, from its start-of-frame marker. */
function jpegSize(bytes) {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined;
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1];
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: (bytes[offset + 5] << 8) | bytes[offset + 6], width: (bytes[offset + 7] << 8) | bytes[offset + 8] };
    }
    offset += 2 + ((bytes[offset + 2] << 8) | bytes[offset + 3]);
  }
  return undefined;
}

function cleanEnv(env) {
  return Object.fromEntries(Object.entries(env).filter((entry) => entry[1] !== undefined));
}

function parseStatusTabCount(text) {
  const match = /^- .*: (\d+) tabs?$/m.exec(text);
  return match === null ? 0 : Number(match[1]);
}

async function wrongTokenIsRefused(port) {
  return await new Promise((resolve) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/?token=wrong-token`);
    const timer = setTimeout(() => {
      socket.close();
      resolve(false);
    }, 3_000);
    socket.addEventListener('open', () => {
      clearTimeout(timer);
      socket.close();
      resolve(false);
    });
    socket.addEventListener('error', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

async function stopDaemon() {
  try {
    const state = JSON.parse(await readFile(statePath, 'utf8'));
    if (typeof state.pid === 'number') {
      process.kill(state.pid, 'SIGTERM');
      for (let attempt = 0; attempt < 40; attempt += 1) {
        if (!processIsAlive(state.pid)) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
  } catch {
    // The daemon never started, or it exited before cleanup.
  }
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
