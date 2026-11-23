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

async function waitForHelper(serviceWorker, connected, timeoutMs = 25_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await panelRequest(serviceWorker, { type: 'panel.helper' });
    if (last.connected === connected) return last;
    await sleep(500);
  }
  throw new Error(`The panel never showed the helper as ${connected ? 'connected' : 'missing'}; last: ${JSON.stringify(last)}`);
}

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

    // 2. One command from a folder that is not the repository.
    const printed = await run(join(nodeDir, 'npx'), ['--yes', `--package=${tarball}`, 't3-tab', 'setup', '--print']);
    assert(printed.includes('Would install T3-Tab') && !(await exists(root)), `setup --print changed something or said nothing:\n${printed}`);
    const installed = await run(join(nodeDir, 'npx'), ['--yes', `--package=${tarball}`, 't3-tab', 'setup']);
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
    const removed = await run(join(root, 't3-tab'), ['uninstall']);
    assert(removed.includes('Removed the helper'), `uninstall output:\n${removed}`);
    for (const path of [root, manifest, home.stateDir]) assert(!(await exists(path)), `Uninstall left ${path}`);
    const afterUninstall = JSON.parse(await readFile(claudeConfig, 'utf8').catch(() => '{}'));
    assert(afterUninstall.mcpServers?.['t3-tab'] === undefined, 'Uninstall left the Claude Code entry');
    assert(!isAlive(fresh.pid), 'Uninstall left the daemon running');
    const gone = await waitForHelper(serviceWorker, false);
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

    // 8. A browser started with its own profile folder reads that folder, not ~/.config/chromium.
    const custom = { ...home, profileDir: join(home.tempHome, 'my-test-profile', 'chromium-data') };
    await mkdir(custom.profileDir, { recursive: true });
    context = await launchBrowser(custom);
    const second = await extensionWorker(context);
    await waitForHelper(second.serviceWorker, false, 5_000);
    await run(join(nodeDir, 'npx'), ['--yes', `--package=${tarball}`, 't3-tab', 'setup']);
    const customManifest = join(custom.profileDir, 'NativeMessagingHosts', 'com.t3tab.native.json');
    assert(await exists(customManifest), 'setup did not register in the running browser\'s own profile folder');
    await waitForHelper(second.serviceWorker, true);
    await run(join(root, 't3-tab'), ['uninstall']);
    assert(!(await exists(customManifest)), 'Uninstall left the manifest in the custom profile folder');
    console.log('Product install: a browser with its own --user-data-dir found the helper too, and uninstall cleaned that profile');
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
