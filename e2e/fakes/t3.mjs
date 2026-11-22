// A fake `t3` with the `thread start|send|show|list --json` behaviour T3-Tab relies on. `t3-mode` in the fake
// folder says whether the "server" is running. A started thread gets a long-lived agent process (t3-agent.mjs),
// as a T3 provider session keeps its MCP servers across turns.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { fakeDir, readStdin, record, valueOf } from './common.mjs';

const args = process.argv.slice(2);
const mode = existsSync(join(fakeDir, 't3-mode')) ? readFileSync(join(fakeDir, 't3-mode'), 'utf8').trim() : 'running';
const json = args.includes('--json');
const input = args.at(-1) === '-' ? readStdin() : undefined;
record('t3', args, input);

if (args[0] !== 'thread') fail('fake t3 supports only `thread`');
if (mode !== 'running') fail('No running T3 Code server uses /fake/.t3. Start T3 Code, then retry.');
if (!json) fail('fake t3 needs --json');

const command = args[1];
const positional = positionals(args.slice(2));
if (command === 'list') {
  const project = valueOf(args, '--project');
  if (project === '/') fail("No T3 Code project matches '/'. Pass a project id or a path inside a project.");
  print([]);
} else if (command === 'start') {
  const [project, message] = positional;
  if (project === undefined || message !== '-') fail('usage: t3 thread start <project> <message>');
  const id = `thread-${Date.now().toString(36)}`;
  writeThread(id, {
    threadId: id,
    title: input.split('\n')[0].slice(0, 80),
    status: 'running',
    latestRunId: 'run-1',
    providerInstanceId: valueOf(args, '--provider') ?? 'default',
    model: valueOf(args, '--model') ?? 'default',
    pendingRequestCount: 0,
    messages: [{ role: 'user', runId: 'run-1', text: input }],
  });
  const agent = spawn(process.execPath, [join(fileURLToPath(new URL('.', import.meta.url)), 't3-agent.mjs'), id], {
    detached: true,
    stdio: 'ignore',
    env: process.env,
  });
  agent.unref();
  print({ threadId: id, projectId: 'project-1', runId: 'run-1' });
} else if (command === 'send') {
  const [id, message] = positional;
  if (message !== '-') fail('usage: t3 thread send <thread> <message>');
  const thread = readThread(id);
  const runId = `run-${thread.messages.filter((entry) => entry.role === 'user').length + 1}`;
  thread.messages.push({ role: 'user', runId, text: input });
  thread.status = 'running';
  thread.latestRunId = runId;
  writeThread(id, thread);
  print({ threadId: id, messageId: `message-${runId}`, runId, status: 'queued', delivery: 'started' });
} else if (command === 'show') {
  const [id] = positional;
  const { messages, ...thread } = readThread(id);
  print({ thread, messages: messages.slice(-Number(valueOf(args, '--messages') ?? 10)) });
} else {
  fail(`fake t3 does not know thread ${command}`);
}

function positionals(rest) {
  const values = [];
  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index];
    if (value === '--json') continue;
    if (value.startsWith('--')) index += 1;
    else values.push(value);
  }
  return values;
}

function threadPath(id) {
  if (!/^thread-[a-z0-9]+$/.test(id ?? '')) fail(`'${id}' is not a thread id.`);
  return join(fakeDir, `${id}.json`);
}

function readThread(id) {
  return JSON.parse(readFileSync(threadPath(id), 'utf8'));
}

function writeThread(id, thread) {
  writeFileSync(threadPath(id), JSON.stringify(thread));
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
  process.exit(0);
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
