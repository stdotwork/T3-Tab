// Fake `claude` and `codex` for direct runs from the side panel. Each run starts the MCP server it was given
// (`--mcp-config` for Claude Code, `-c mcp_servers.t3-tab.*` for Codex), looks at its tabs, and prints the
// JSON lines the real CLI prints. Usage: direct.mjs claude|codex <the CLI's arguments>.
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { connect, fakeDir, lookAtTabs, readStdin, record, valueOf } from './common.mjs';

const [name, ...args] = process.argv.slice(2);
const input = readStdin();
record(name, args, input);

if (name === 'claude') {
  const config = JSON.parse(valueOf(args, '--mcp-config'));
  const server = config.mcpServers['t3-tab'];
  spoilClaimFile(server.args);
  // Claude Code starts a stdio server with its own environment plus the server's `env`.
  const client = await connect('claude-code', { command: server.command, args: server.args, env: { ...process.env, ...server.env } });
  const sessionId = valueOf(args, '--resume') ?? randomUUID();
  line({ type: 'system', subtype: 'init', session_id: sessionId, model: valueOf(args, '--model') ?? 'default' });
  const seen = await lookAtTabs(client, undefined);
  await holdIfAsked();
  await client.close();
  line({ type: 'assistant', session_id: sessionId, message: { content: [{ type: 'text', text: `Claude fake (${input.trim()}).\n${seen}` }] } });
  line({ type: 'result', subtype: 'success', is_error: false, result: 'done', session_id: sessionId });
} else if (name === 'codex') {
  const settings = new Map(
    args.flatMap((value, index) => (args[index - 1] === '-c' ? [value.split(/=(.*)/s).slice(0, 2)] : [])),
  );
  const command = JSON.parse(settings.get('mcp_servers.t3-tab.command'));
  const serverArgs = JSON.parse(settings.get('mcp_servers.t3-tab.args'));
  const serverEnv = Object.fromEntries(
    [...settings.get('mcp_servers.t3-tab.env').matchAll(/([A-Z0-9_]+) = ("(?:[^"\\]|\\.)*")/g)].map((match) => [match[1], JSON.parse(match[2])]),
  );
  // Codex starts a stdio server with a short list of variables plus the server's `env`.
  const base = Object.fromEntries(['HOME', 'PATH', 'USER', 'LANG', 'TMPDIR'].flatMap((key) => (process.env[key] === undefined ? [] : [[key, process.env[key]]])));
  const client = await connect('codex-mcp-client', { command, args: serverArgs, env: { ...base, ...serverEnv } });
  const resumed = args[1] === 'resume' ? args.at(-2) : undefined;
  line({ type: 'thread.started', thread_id: resumed ?? randomUUID() });
  line({ type: 'turn.started' });
  const seen = await lookAtTabs(client, undefined);
  await client.close();
  line({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: `Codex fake (${input.trim()}).\n${seen}` } });
  line({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } });
} else {
  process.stderr.write(`unknown fake ${name}\n`);
  process.exit(2);
}

/** A message with `[claim-file:<how>]` damages this turn's private claim file before the MCP server reads it. */
function spoilClaimFile(serverArgs) {
  const how = /\[claim-file:(missing|mode|replaced)\]/.exec(input)?.[1];
  if (how === undefined) return;
  const file = serverArgs[serverArgs.indexOf('--claim-file') + 1];
  if (how === 'mode') {
    chmodSync(file, 0o644);
    return;
  }
  rmSync(file);
  if (how === 'replaced') {
    const elsewhere = join(fakeDir, 'not-the-claim');
    writeFileSync(elsewhere, 'abcdefghijklmnop1234', { mode: 0o600 });
    symlinkSync(elsewhere, file);
  }
}

/** A message with `[hold]` keeps this turn's session open until the run writes `release`, so the owner can act on it. */
async function holdIfAsked() {
  if (!input.includes('[hold]')) return;
  const deadline = Date.now() + 30_000;
  while (!existsSync(join(fakeDir, 'release')) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
}

function line(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}
