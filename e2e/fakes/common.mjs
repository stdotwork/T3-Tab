// Shared by the fake `t3`, `claude` and `codex` commands the end-to-end run puts on the daemon's PATH. They record
// how they were called and drive the real `t3-tab mcp` server the way an agent would, then print what the real
// CLI prints. They never start a model.
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

export const fakeDir = process.env.T3_TAB_FAKE_DIR ?? '';

export function record(name, args, input) {
  appendFileSync(join(fakeDir, 'calls.jsonl'), `${JSON.stringify({ name, args, input })}\n`);
}

export function readStdin() {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

/** Starts the MCP server the way an agent CLI does and connects to it as `clientName`. */
export async function connect(clientName, server) {
  const transport = new StdioClientTransport({ command: server.command, args: server.args, env: server.env, stderr: 'ignore' });
  const client = new Client({ name: clientName, version: '1.0.0' });
  await client.connect(transport);
  return client;
}

export function textOf(result) {
  return (result.content ?? []).filter((item) => item.type === 'text').map((item) => item.text).join('\n');
}

/** Lists the session's tabs (claiming the owner's first when a code is given) and reads the first one. */
export async function lookAtTabs(client, claim) {
  const tabs = await client.callTool({ name: 'tabs', arguments: claim === undefined ? {} : { claim } });
  const tabsText = textOf(tabs);
  if (tabs.isError === true) return `tabs failed: ${tabsText}`;
  const tabId = Number(/^(\d+)/m.exec(tabsText)?.[1]);
  const read = await client.callTool({ name: 'read', arguments: Number.isInteger(tabId) ? { tab: tabId } : {} });
  const firstLine = textOf(read).split('\n')[0];
  return `tabs:\n${tabsText}\nread: ${read.isError === true ? 'failed: ' : ''}${firstLine}`;
}
