// The "agent" of a fake T3 thread: one MCP session for the thread's whole life, as a T3 provider keeps its MCP
// servers between turns. It answers each new user message: the first by claiming the tabs its message names.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { connect, fakeDir, lookAtTabs } from './common.mjs';

const id = process.argv[2];
const path = join(fakeDir, `${id}.json`);
const server = { command: process.env.T3_TAB_E2E_NODE, args: [process.env.T3_TAB_E2E_CLI, 'mcp'], env: process.env };
const client = await connect('fake-t3-agent', server);
const deadline = Date.now() + 180_000;
let answered = 0;

while (Date.now() < deadline && existsSync(path)) {
  const thread = JSON.parse(readFileSync(path, 'utf8'));
  const users = thread.messages.filter((entry) => entry.role === 'user');
  if (users.length > answered) {
    const message = users[answered].text;
    const claim = /\{"claim": "([A-Za-z0-9_-]+)"\}/.exec(message)?.[1];
    const seen = await lookAtTabs(client, answered === 0 ? claim : undefined);
    answered += 1;
    const latest = JSON.parse(readFileSync(path, 'utf8'));
    latest.messages.push({ role: 'assistant', runId: latest.latestRunId, text: `Turn ${answered}. ${claim === undefined ? 'no claim' : 'claimed'}\n${seen}` });
    latest.status = 'idle';
    writeFileSync(path, JSON.stringify(latest));
  }
  await new Promise((resolve) => setTimeout(resolve, 100));
}
await client.close();
