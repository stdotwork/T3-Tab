import { readFile } from 'node:fs/promises';

import { assert, connectMcp, sleep, stopDaemon, text, waitForBrowser } from './harness.mjs';

const RESTARTED = 'your earlier browser session ended';

/**
 * A daemon that stops and starts again, as after a reinstall: an MCP client that was already running gets a new
 * session on its next call instead of failing for good. `status` says where the client's own link stands.
 */
export async function checkDaemonRestart({ home }) {
  const { client } = await connectMcp(home, 't3-tab-e2e-restart');
  try {
    const before = await client.callTool({ name: 'tabs', arguments: {} });
    assert(before.isError !== true, `tabs failed before the restart: ${text(before)}`);
    assert(!text(before).includes(RESTARTED), 'The restart notice appeared before any restart');
    const linked = text(await client.callTool({ name: 'status', arguments: {} }));
    assert(/session: connected\./.test(linked), `status does not report the session as connected: ${linked}`);

    const oldPid = JSON.parse(await readFile(home.statePath, 'utf8')).pid;
    await stopDaemon(home.statePath);
    // The client's socket closes with the daemon; give the close time to arrive.
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await sleep(100);
    }

    // `status` starts the new daemon (its own one-shot connection) and still reports this client's link as ended.
    const ended = text(await client.callTool({ name: 'status', arguments: {} }));
    assert(/session: ended/.test(ended), `status does not report the ended session: ${ended}`);
    const newPid = JSON.parse(await readFile(home.statePath, 'utf8')).pid;
    assert(newPid !== oldPid, `The daemon did not restart (pid ${oldPid})`);
    // The browser's own link comes back through the native host; wait for it before using a tab.
    await waitForBrowser(client);

    const after = await client.callTool({ name: 'tabs', arguments: {} });
    assert(after.isError !== true, `tabs failed after the daemon restarted: ${text(after)}`);
    assert(text(after).includes(RESTARTED), `The first reply after the restart has no notice: ${text(after)}`);
    const again = await client.callTool({ name: 'tabs', arguments: {} });
    assert(again.isError !== true && !text(again).includes(RESTARTED), `The notice was repeated or the call failed: ${text(again)}`);
    const relinked = text(await client.callTool({ name: 'status', arguments: {} }));
    assert(/session: connected\./.test(relinked), `status does not report the new session as connected: ${relinked}`);
    console.log(`Daemon restart: a running MCP client got a new session (daemon pid ${oldPid} -> ${newPid}), was told once, and its tool call worked`);
  } finally {
    await client.close().catch(() => undefined);
  }
}
