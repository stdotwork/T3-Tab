import { execFile } from 'node:child_process';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { join, dirname } from 'node:path';
import { promisify } from 'node:util';

import { assert, cleanEnv } from './harness.mjs';

const execFileAsync = promisify(execFile);

export async function checkInstallCommand({ cliPath, tempHome, childEnv }) {
  const emptyPath = join(tempHome, 'empty-path');
  const claudeConfigPath = join(tempHome, '.claude.json');
  const codexConfigPath = join(tempHome, '.codex', 'config.toml');
  const nativeManifestPath = join(tempHome, '.config', 'chromium', 'NativeMessagingHosts', 'com.t3tab.native.json');
  const hiddenCliEnv = cleanEnv({ ...childEnv, PATH: emptyPath });
  await mkdir(emptyPath, { recursive: true });
  await mkdir(dirname(codexConfigPath), { recursive: true });

  const claudeOriginal = `${JSON.stringify(
    {
      existing: { keep: true },
      mcpServers: { other: { type: 'stdio', command: 'other-mcp', args: [] } },
    },
    null,
    2,
  )}\n`;
  const codexOriginal = `# Keep this top-level comment.
model = "gpt-5"

[mcp_servers.other]
# Keep this server.
command = "other-mcp"
args = ["--stdio"]

[ui]
show_tooltips = true
`;
  await writeFile(claudeConfigPath, claudeOriginal);
  await writeFile(codexConfigPath, codexOriginal);

  const printed = await execFileAsync(
    process.execPath,
    [cliPath, 'install', '--print'],
    { env: hiddenCliEnv, maxBuffer: 4 * 1024 * 1024 },
  );
  assert(printed.stdout.includes('Claude Code: would register t3-tab'), `Install --print did not describe Claude Code:\n${printed.stdout}`);
  assert(printed.stdout.includes('Codex: would register t3-tab'), `Install --print did not describe Codex:\n${printed.stdout}`);
  assert((await readFile(claudeConfigPath, 'utf8')) === claudeOriginal, 'Install --print changed the Claude Code config');
  assert((await readFile(codexConfigPath, 'utf8')) === codexOriginal, 'Install --print changed the Codex config');
  assert(!(await fileExists(nativeManifestPath)), 'Install --print installed a native host manifest');
  console.log('Install --print: described both agents and the native host; no files changed');

  const first = await execFileAsync(
    process.execPath,
    [cliPath, 'install'],
    { env: hiddenCliEnv, maxBuffer: 4 * 1024 * 1024 },
  );
  assert(first.stdout.includes('with file edit'), `Install did not use the file-edit path:\n${first.stdout}`);
  const claudeInstalledText = await readFile(claudeConfigPath, 'utf8');
  const claudeInstalled = JSON.parse(claudeInstalledText);
  assert(claudeInstalled.existing?.keep === true, 'Install dropped an existing Claude Code key');
  assert(claudeInstalled.mcpServers?.other?.command === 'other-mcp', 'Install dropped another Claude Code MCP server');
  const claudeServer = claudeInstalled.mcpServers?.['t3-tab'];
  assert(claudeServer?.type === 'stdio', `Claude Code did not get a stdio t3-tab server: ${claudeInstalledText}`);
  assert(claudeServer.command === process.execPath, `Claude Code server does not use the absolute node path: ${claudeInstalledText}`);
  assert(
    JSON.stringify(claudeServer.args) === JSON.stringify([cliPath, 'mcp']),
    `Claude Code server does not use the absolute CLI path: ${claudeInstalledText}`,
  );

  const codexInstalledText = await readFile(codexConfigPath, 'utf8');
  assert(codexInstalledText.startsWith(codexOriginal), 'Codex install changed or dropped existing content');
  assert(countMatches(codexInstalledText, /^\[mcp_servers\.t3-tab\]$/gm) === 1, `Codex install did not add exactly one server:\n${codexInstalledText}`);
  assert(codexInstalledText.includes(`command = ${JSON.stringify(process.execPath)}`), 'Codex server does not use the absolute node path');
  assert(codexInstalledText.includes(`args = [${JSON.stringify(cliPath)}, "mcp"]`), 'Codex server does not use the absolute CLI path');
  assert(await fileExists(nativeManifestPath), 'Install did not add the Chromium native host manifest');
  console.log(`Install file edit: Claude Code and Codex registered; native host at ${nativeManifestPath}`);

  const second = await execFileAsync(
    process.execPath,
    [cliPath, 'install'],
    { env: hiddenCliEnv, maxBuffer: 4 * 1024 * 1024 },
  );
  assert(second.stdout.includes('with file edit'), `Second install did not use the file-edit path:\n${second.stdout}`);
  assert((await readFile(claudeConfigPath, 'utf8')) === claudeInstalledText, 'Second install changed the Claude Code config');
  assert((await readFile(codexConfigPath, 'utf8')) === codexInstalledText, 'Second install changed the Codex config');
  assert(countMatches(await readFile(codexConfigPath, 'utf8'), /^\[mcp_servers\.t3-tab\]$/gm) === 1, 'Second install left more than one Codex server');
  console.log('Install idempotency: second run left one entry in each config');

  const uninstall = await execFileAsync(
    process.execPath,
    [cliPath, 'uninstall'],
    { env: hiddenCliEnv, maxBuffer: 4 * 1024 * 1024 },
  );
  assert(uninstall.stdout.includes('removed t3-tab'), `Uninstall did not report removal:\n${uninstall.stdout}`);
  const claudeRemaining = JSON.parse(await readFile(claudeConfigPath, 'utf8'));
  assert(claudeRemaining.existing?.keep === true, 'Uninstall dropped an existing Claude Code key');
  assert(claudeRemaining.mcpServers?.other?.command === 'other-mcp', 'Uninstall dropped another Claude Code MCP server');
  assert(!Object.hasOwn(claudeRemaining.mcpServers ?? {}, 't3-tab'), 'Uninstall left the Claude Code server');
  assert((await readFile(codexConfigPath, 'utf8')) === codexOriginal, 'Uninstall did not restore the rest of the Codex config');
  assert(!(await fileExists(nativeManifestPath)), 'Uninstall left the native host manifest');
  console.log('Install uninstall: both servers and the native host removed; other config preserved');

  const claudeCli = await commandOnPath('claude', process.env.PATH);
  const codexCli = await commandOnPath('codex', process.env.PATH);
  if (claudeCli === undefined || codexCli === undefined) {
    console.log('Install CLI path: skipped (claude and codex are not both on PATH)');
    return;
  }

  const cliEnv = cleanEnv({ ...childEnv, PATH: process.env.PATH });
  const cliInstall = await execFileAsync(
    process.execPath,
    [cliPath, 'install'],
    { env: cliEnv, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 },
  );
  assert(cliInstall.stdout.includes('with claude mcp add'), `Install did not use claude mcp add:\n${cliInstall.stdout}`);
  assert(cliInstall.stdout.includes('with codex mcp add'), `Install did not use codex mcp add:\n${cliInstall.stdout}`);
  const [claudeList, codexList] = await Promise.all([
    execFileAsync(claudeCli, ['mcp', 'list'], { env: cliEnv, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 }),
    execFileAsync(codexCli, ['mcp', 'list'], { env: cliEnv, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 }),
  ]);
  assert(claudeList.stdout.includes('t3-tab'), `claude mcp list does not show t3-tab:\n${claudeList.stdout}`);
  assert(codexList.stdout.includes('t3-tab'), `codex mcp list does not show t3-tab:\n${codexList.stdout}`);
  await execFileAsync(
    process.execPath,
    [cliPath, 'uninstall'],
    { env: cliEnv, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 },
  );
  console.log('Install CLI path: claude mcp add/codex mcp add registered t3-tab; both mcp list commands showed it');
}

async function fileExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function commandOnPath(name, pathValue) {
  for (const directory of (pathValue ?? '').split(':')) {
    if (directory === '') continue;
    const candidate = join(directory, name);
    try {
      await access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // Keep looking on PATH.
    }
  }
  return undefined;
}

function countMatches(value, expression) {
  return [...value.matchAll(expression)].length;
}
