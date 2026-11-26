// The helper installed the way a user installs it: from the tarball `npm pack` makes, run from a folder outside the
// repository, with a temporary HOME, while a headless Chromium that has the extension loaded is already running.
// Nothing here touches the machine's own browser profiles or agent configuration.
import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { promisify } from 'node:util';

import { assert, cleanEnv, createHome, extensionWorker, launchBrowser, panelRequest, requireBuild, sleep, stopDaemon, text } from './harness.mjs';

const execFileAsync = promisify(execFile);
const nodeDir = dirname(process.execPath);
const exists = async (path) => access(path).then(() => true, () => false);

/** `npm pack` of the helper package into a folder of its own. Returns the tarball's path. */
export async function packHelper(rootDir) {
  const out = await mkdtemp(join(tmpdir(), 't3-tab-pack-'));
  await execFileAsync(join(nodeDir, 'npm'), ['pack', '--silent', '--pack-destination', out], {
    cwd: join(rootDir, 'packages', 'helper'),
    env: cleanEnv({ ...process.env, PATH: `${nodeDir}${delimiter}${process.env.PATH ?? ''}` }),
  });
  const [file] = (await readdir(out)).filter((name) => name.endsWith('.tgz'));
  assert(file !== undefined, 'npm pack made no tarball');
  return { tarball: join(out, file), out };
}

// The worker's reconnect delay is capped at 30 s plus up to 0.25 s of jitter (`scheduleReconnect` in background.ts), so a
// wait for the helper to come back has to outlast that, or the check races the retry timer.
const RECONNECT_MAX_MS = 30_000 + 250;
async function waitForHelper(serviceWorker, connected, timeoutMs = RECONNECT_MAX_MS + 10_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await panelRequest(serviceWorker, { type: 'panel.helper' });
    if (last.connected === connected) return last;
    await sleep(500);
  }
  throw new Error(`The panel never showed the helper as ${connected ? 'connected' : 'missing'}; last: ${JSON.stringify(last)}`);
}

/**
 * The real side panel open on a tab. Playwright does not list a side panel among its pages, so this reaches it over the
 * DevTools protocol, through a page of the same browser. `evaluate` runs an expression there and returns its value.
 */
async function sidePanelOn(page, tabId, timeoutMs = 10_000) {
  const cdp = await page.context().newCDPSession(page);
  const deadline = Date.now() + timeoutMs;
  let target;
  while (target === undefined && Date.now() < deadline) {
    target = (await cdp.send('Target.getTargets')).targetInfos.find((info) => info.url.endsWith(`/sidepanel.html?tabId=${tabId}`));
    if (target === undefined) await sleep(100);
  }
  assert(target !== undefined, `No side panel opened on tab ${tabId}`);
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: false });
  let nextId = 0;
  const waiting = new Map();
  cdp.on('Target.receivedMessageFromTarget', (event) => {
    if (event.sessionId !== sessionId) return;
    const message = JSON.parse(event.message);
    waiting.get(message.id)?.(message);
    waiting.delete(message.id);
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      nextId += 1;
      waiting.set(nextId, (message) => (message.error === undefined ? resolve(message.result) : reject(new Error(`${method}: ${message.error.message}`))));
      void cdp.send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id: nextId, method, params }) }).catch(reject);
    });
  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails !== undefined) throw new Error(`In the side panel: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`);
    return result.result.value;
  };
  const until = async (what, expression, waitMs = 15_000) => {
    const end = Date.now() + waitMs;
    while (Date.now() < end) {
      if ((await evaluate(expression).catch(() => false)) === true) return;
      await sleep(100);
    }
    throw new Error(`The side panel never showed ${what}; it shows: ${await evaluate('document.body.innerText').catch(() => '(unreadable)')}`);
  };
  return { url: target.url, send, evaluate, until };
}

const SETUP_CARD = "document.querySelector('[data-setup-card]')";
const COMPOSER = "document.querySelector('.composer-input')";
const SEND = "document.querySelector('.send-btn')";

/** The environment a user's terminal has: the home's own, with `npx` on PATH and a cache of its own. */
export function userEnv(home) {
  return cleanEnv({
    ...home.childEnv,
    PATH: `${nodeDir}${delimiter}${process.env.PATH ?? ''}`,
    npm_config_cache: join(home.tempHome, '.npm'),
    npm_config_update_notifier: 'false',
  });
}

/** Runs the product's setup command from a folder outside the repository: `npx --package <tarball> t3-tab setup`. */
export async function runSetupFromTarball(home, tarball, args = []) {
  const runDir = await mkdtemp(join(tmpdir(), 't3-tab-run-'));
  try {
    return (await execFileAsync(join(nodeDir, 'npx'), ['--yes', `--package=${tarball}`, 't3-tab', 'setup', ...args], { cwd: runDir, env: userEnv(home), maxBuffer: 8 * 1024 * 1024, timeout: 120_000 })).stdout;
  } finally {
    await rm(runDir, { recursive: true, force: true });
  }
}

export async function checkProductInstall() {
  const home = await createHome();
  await requireBuild(home);
  const { tarball, out: packDir } = await packHelper(home.rootDir);
  const env = userEnv(home);
  // A folder that is not the repository, not the npx cache and not inside the temporary HOME.
  const runDir = await mkdtemp(join(tmpdir(), 't3-tab-run-'));
  const root = join(home.tempHome, '.local', 'share', 't3-tab');
  const manifest = join(home.profileDir, 'NativeMessagingHosts', 'com.t3tab.native.json');
  const claudeConfig = join(home.tempHome, '.claude.json');
  const run = async (command, args, extraEnv = {}) =>
    (await execFileAsync(command, args, { cwd: runDir, env: { ...env, ...extraEnv }, maxBuffer: 8 * 1024 * 1024, timeout: 120_000 })).stdout;

  let context;
  try {
    // 1. The browser is already running, with the extension and no helper.
    context = await launchBrowser(home);
    const { serviceWorker } = await extensionWorker(context);
    await serviceWorker.evaluate(() => { globalThis.__t3tabBeforeSetup = true; });
    const before = await waitForHelper(serviceWorker, false, 5_000);
    assert(before.problem === 'missing', `Before setup the panel should call the helper missing: ${JSON.stringify(before)}`);
    console.log(`Product install: before setup the panel says the helper is "${before.problem}"`);

    // 1b. The extension opened its welcome tab by itself. Its one button copies the setup command and opens the real side
    // panel on that tab, which is the new-thread screen with the setup card: no setup screen, no Start, the composer usable.
    let welcome;
    for (let attempt = 0; attempt < 100 && welcome === undefined; attempt += 1) {
      welcome = context.pages().find((page) => page.url().endsWith('/welcome.html'));
      if (welcome === undefined) await sleep(100);
    }
    assert(welcome !== undefined, `The extension opened no welcome tab on install: ${JSON.stringify(context.pages().map((page) => page.url()))}`);
    await welcome.evaluate(() => {
      const write = navigator.clipboard.writeText.bind(navigator.clipboard);
      window.__copied = [];
      navigator.clipboard.writeText = async (value) => {
        window.__copied.push(value);
        await write(value);
      };
    });
    await welcome.getByRole('button', { name: 'Copy the command and open T3-Tab' }).click();
    await welcome.getByText('Copied.', { exact: false }).waitFor({ timeout: 5_000 });
    const shownCommand = (await welcome.locator('.command-line code').textContent())?.trim();
    const copied = await welcome.evaluate(() => window.__copied);
    assert(copied.length === 1 && copied[0] === shownCommand, `The welcome button copied ${JSON.stringify(copied)}, not the command it shows (${shownCommand})`);
    const welcomeTab = await welcome.evaluate(async () => (await chrome.tabs.getCurrent()).id);
    const sidePanel = await sidePanelOn(welcome, welcomeTab);
    await sidePanel.until('the setup card with the command over a composer', `${SETUP_CARD}?.querySelector('.command-line') != null && ${SETUP_CARD}.textContent.includes('Run this in a terminal') && ${COMPOSER} != null`);
    const startOrWelcome = await sidePanel.evaluate("[...document.querySelectorAll('button')].some((button) => button.textContent.trim() === 'Start') || document.body.innerText.includes('Welcome to T3-Tab') || document.body.innerText.includes('Your own agents')");
    assert(startOrWelcome === false, 'The side panel still shows a setup screen, a Start button or the agents section');
    // The owner writes the task while the helper is not there yet; Send waits for it.
    const task = 'Which of these cables is cheapest?';
    await sidePanel.evaluate(`${COMPOSER}.focus()`);
    await sidePanel.send('Input.insertText', { text: task });
    await sidePanel.until('the typed task in the composer', `${COMPOSER}.value === ${JSON.stringify(task)}`);
    assert((await sidePanel.evaluate(`${SEND}.disabled`)) === true, 'Send is enabled before the helper is there');
    console.log(`Product install: the welcome tab opened on install; its button copied the command and opened the side panel on it (${sidePanel.url}): the new-thread screen with the setup card and no Start; a task typed before the helper exists waits with Send off`);

    // 2. One command from a folder that is not the repository.
    const printed = await run(join(nodeDir, 'npx'), ['--yes', `--package=${tarball}`, 't3-tab', 'setup', '--print']);
    assert(printed.includes('Would install T3-Tab') && !(await exists(root)), `setup --print changed something or said nothing:\n${printed}`);
    const installed = await run(join(nodeDir, 'npx'), ['--yes', `--package=${tarball}`, 't3-tab', 'setup']);
    const setupExited = Date.now();
    assert(installed.includes('Registered the browser link'), `setup registered no browser:\n${installed}`);
    for (const file of ['cli.js', 't3-tab', 'native-host', 'install.json']) assert(await exists(join(root, file)), `setup did not write ${file}`);
    const launcher = await readFile(join(root, 't3-tab'), 'utf8');
    assert(launcher.includes(process.execPath) && launcher.includes(join(root, 'cli.js')), `The launcher does not name the Node and the installed program:\n${launcher}`);
    assert(!installed.includes('_npx') && !JSON.stringify(await readFile(manifest, 'utf8')).includes('_npx'), 'The install depends on the npx cache');
    console.log(`Product install: setup ran from ${runDir} and installed ${root}`);

    // 3. The same browser, with no reload, finds the helper, and the browser starts the background program itself.
    const found = await waitForHelper(serviceWorker, true);
    assert(await serviceWorker.evaluate(() => globalThis.__t3tabBeforeSetup === true), 'The extension was reloaded to find the helper');
    const state = JSON.parse(await readFile(home.statePath, 'utf8'));
    assert(state.helperVersion === JSON.parse(await readFile(join(home.rootDir, 'packages/helper/package.json'), 'utf8')).version, `The daemon does not report the helper version: ${JSON.stringify({ ...state, token: undefined })}`);
    console.log(`Product install: the running browser found the helper without a reload (${JSON.stringify(found)}); daemon pid ${state.pid} started by the browser`);

    // 3b. The side panel moves on by itself: the setup card goes, the task typed before is still there, and Send works.
    await sidePanel.until('the setup card gone', `${SETUP_CARD} === null && ${COMPOSER} != null`, RECONNECT_MAX_MS + 10_000);
    const cardGoneMs = Date.now() - setupExited;
    assert((await sidePanel.evaluate(`${COMPOSER}.value`)) === task, 'The task typed before the helper arrived was lost');
    // Send turns on when the helper found an agent to run the task; with none (a machine without Claude Code or Codex), the
    // screen says so in place of the disabled Start the setup screen had, and Send stays off.
    const anyAgent = (await panelRequest(serviceWorker, { type: 'panel.setup', refresh: true })).agents.some((agent) => agent.found);
    if (anyAgent) await sidePanel.until('Send enabled for the typed task', `${SEND}.disabled === false`);
    else {
      await sidePanel.until('that no agent was found', "document.body.innerText.includes('No agent found on this machine')");
      assert((await sidePanel.evaluate(`${SEND}.disabled`)) === true, 'Send is enabled with no agent to run the task');
    }
    console.log(`Product install: with no click in the panel, the setup card went ${cardGoneMs} ms after setup exited and the task typed before is kept; ${anyAgent ? 'an agent was found and Send is on' : 'no agent was found, the screen says so and Send stays off'}`);

    // 4. The panel's Add for Claude Code writes an entry that points at the installed helper, and that entry runs.
    await panelRequest(serviceWorker, { type: 'panel.addAgent', agent: 'claude' });
    const entry = JSON.parse(await readFile(claudeConfig, 'utf8')).mcpServers?.['t3-tab'];
    assert(entry?.command === join(root, 't3-tab') && JSON.stringify(entry.args) === '["mcp"]', `Add for Claude Code wrote ${JSON.stringify(entry)}`);
    assert(!JSON.stringify(entry).includes(home.rootDir), 'The agent entry names the checkout');
    // Run the entry's own command: the installed launcher with `mcp`.
    const entryClient = await connectEntry(entry, env);
    const entryStatus = text(await entryClient.client.callTool({ name: 'status', arguments: {} }));
    assert(/^Browsers: 1$/m.test(entryStatus), `The agent entry's command did not reach the browser:\n${entryStatus}`);
    await entryClient.client.close();
    console.log('Product install: Add for Claude Code wrote an entry for the installed launcher; its `mcp` server sees the browser');

    // 4b. `uninstall --claude` takes out that agent's entry and nothing else: helper, browser link, state and daemon stay.
    const daemonBefore = JSON.parse(await readFile(home.statePath, 'utf8'));
    const partial = await run(join(root, 't3-tab'), ['uninstall', '--claude']);
    assert(/Kept the helper/.test(partial), `uninstall --claude did not say what it kept:\n${partial}`);
    assert(JSON.parse(await readFile(claudeConfig, 'utf8')).mcpServers?.['t3-tab'] === undefined, 'uninstall --claude left the Claude Code entry');
    for (const path of [root, join(root, 'cli.js'), manifest, home.statePath]) assert(await exists(path), `uninstall --claude removed ${path}`);
    assert(isAlive(daemonBefore.pid), 'uninstall --claude stopped the daemon');
    await panelRequest(serviceWorker, { type: 'panel.addAgent', agent: 'claude' });
    console.log('Product install: uninstall --claude removed only the Claude Code entry; the helper, browser link, state and daemon stayed');

    // 5. An update: a daemon of another version is stopped by setup and the browser reconnects to a new one.
    const stateFile = home.statePath;
    const old = JSON.parse(await readFile(stateFile, 'utf8'));
    await writeStateVersion(stateFile, { ...old, helperVersion: '0.0.0-old' });
    const updated = await run(join(nodeDir, 'npx'), ['--yes', `--package=${tarball}`, 't3-tab', 'setup']);
    assert(updated.includes('Stopped the older background program'), `A second setup did not stop the older daemon:\n${updated}`);
    await waitForHelper(serviceWorker, true);
    const fresh = JSON.parse(await readFile(stateFile, 'utf8'));
    assert(fresh.pid !== old.pid, 'The browser did not start a new daemon after the update');
    console.log('Product install: running setup again over an older daemon stopped it, and the browser reconnected to a new one by itself');

    // 6. One command removes everything.
    // The test pause holds the gap after each stage open for 4 s, long enough for the browser to reconnect and start a new
    // daemon if the browser link were still registered when the daemon was stopped.
    const removed = await run(join(root, 't3-tab'), ['uninstall'], { T3_TAB_TEST_UNINSTALL_PAUSE_MS: '4000' });
    assert(removed.includes('Removed the helper'), `uninstall output:\n${removed}`);
    for (const path of [root, manifest, home.stateDir]) assert(!(await exists(path)), `Uninstall left ${path}`);
    const afterUninstall = JSON.parse(await readFile(claudeConfig, 'utf8').catch(() => '{}'));
    assert(afterUninstall.mcpServers?.['t3-tab'] === undefined, 'Uninstall left the Claude Code entry');
    assert(!isAlive(fresh.pid), 'Uninstall left the daemon running');
    let gone = await waitForHelper(serviceWorker, false);
    // The link closing is reported first; then the browser's own answer, that it knows no helper.
    for (let attempt = 0; attempt < 20 && gone.problem !== 'missing'; attempt += 1) {
      await sleep(500);
      gone = await panelRequest(serviceWorker, { type: 'panel.helper' });
    }
    assert(gone.problem === 'missing', `After uninstall the panel should call the helper missing: ${JSON.stringify(gone)}`);
    console.log('Product install: uninstall removed the program, launchers, manifest, state and agent entry, and stopped the daemon');

    // 7. The test build's install script does the same through a file URL.
    const script = join(home.rootDir, 'scripts', 'install-test-build.sh');
    const scripted = await run('sh', [script], { T3_TAB_HELPER_URL: `file://${tarball}` });
    assert(scripted.includes('Registered the browser link'), `install-test-build.sh output:\n${scripted}`);
    await waitForHelper(serviceWorker, true);
    await run(join(root, 't3-tab'), ['uninstall']);
    assert(!(await exists(root)), 'Uninstall after the script left the helper folder');
    console.log('Product install: scripts/install-test-build.sh installed the same helper; the browser found it; uninstalled');
    await context.close();
    context = undefined;

    // 8. A browser started with its own profile folder reads that folder, not ~/.config/chromium. This one is headless in a
    // temporary folder, which setup leaves alone on its own, so the folder is named with --user-data-dir.
    const custom = { ...home, profileDir: join(home.tempHome, 'my-test-profile', 'chromium-data') };
    await mkdir(custom.profileDir, { recursive: true });
    context = await launchBrowser(custom);
    const second = await extensionWorker(context);
    await waitForHelper(second.serviceWorker, false, 5_000);
    const customManifest = join(custom.profileDir, 'NativeMessagingHosts', 'com.t3tab.native.json');
    await run(join(nodeDir, 'npx'), ['--yes', `--package=${tarball}`, 't3-tab', 'setup']);
    assert(!(await exists(customManifest)), `setup wrote into the profile folder of a headless browser in a temporary folder: ${await readFile(customManifest, 'utf8').catch(() => '')}`);
    await run(join(nodeDir, 'npx'), ['--yes', `--package=${tarball}`, 't3-tab', 'setup', '--user-data-dir', custom.profileDir]);
    assert(await exists(customManifest), 'setup --user-data-dir did not register in the named profile folder');
    await waitForHelper(second.serviceWorker, true);
    await run(join(root, 't3-tab'), ['uninstall']);
    assert(!(await exists(customManifest)), 'Uninstall left the manifest in the custom profile folder');
    console.log('Product install: a headless test browser is left alone; named with --user-data-dir it found the helper too, and uninstall cleaned that profile');

    // 9. Help is for people who type it: stdout, exit 0. With no browser anywhere, setup says what to do and exits non-zero.
    const bundle = join(home.rootDir, 'packages', 'helper', 'dist', 'cli.js');
    const bare = join(home.tempHome, 'no-browser');
    const bareEnv = cleanEnv({ HOME: bare, XDG_CONFIG_HOME: join(bare, '.config'), XDG_STATE_HOME: join(bare, '.state'), XDG_DATA_HOME: join(bare, '.share'), PATH: nodeDir });
    await mkdir(bare, { recursive: true });
    const attempt = (args) => execFileAsync(process.execPath, [bundle, ...args], { cwd: runDir, env: bareEnv, timeout: 60_000 }).then((r) => ({ code: 0, ...r }), (e) => ({ code: e.code, stdout: e.stdout ?? '', stderr: e.stderr ?? '' }));
    for (const args of [['--help'], ['-h'], ['help'], ['setup', '--help'], ['uninstall', '--help']]) {
      const out = await attempt(args);
      assert(out.code === 0 && out.stdout.startsWith(args[0] === 'setup' || args[0] === 'uninstall' ? `Usage: t3-tab ${args[0]}` : 't3-tab:'), `t3-tab ${args.join(' ')} exited ${out.code}:\n${out.stdout}${out.stderr}`);
    }
    const none = await attempt(['setup']);
    assert(none.code === 1 && none.stdout.includes('--browser <chromium|chrome|brave|edge|vivaldi>') && none.stdout.includes('--user-data-dir <folder>'), `setup with no browser exited ${none.code}:\n${none.stdout}${none.stderr}`);
    const printOnly = await attempt(['setup', '--print']);
    assert(printOnly.code === 0, `setup --print with no browser exited ${printOnly.code}`);
    console.log('Product install: --help prints usage and exits 0; setup with no browser names --browser and --user-data-dir and exits 1; setup --print exits 0');
  } finally {
    await context?.close().catch(() => undefined);
    await stopDaemon(home.statePath);
    await rm(runDir, { recursive: true, force: true });
    await rm(packDir, { recursive: true, force: true });
    await rm(home.tempHome, { recursive: true, force: true });
  }
}

async function connectEntry(entry, env) {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const transport = new StdioClientTransport({ command: entry.command, args: entry.args, env, stderr: 'pipe' });
  const client = new Client({ name: 'agent-entry', version: '1.0.0' });
  await client.connect(transport);
  return { client };
}

async function writeStateVersion(path, state) {
  const { writeFile } = await import('node:fs/promises');
  await writeFile(path, `${JSON.stringify(state)}\n`, { mode: 0o600 });
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
