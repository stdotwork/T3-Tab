import { readFile } from 'node:fs/promises';

import { assert, connectMcp, sleep, stopDaemon, text } from './harness.mjs';

const RESTARTED = 'your earlier browser session ended';

/**
 * A daemon that stops and starts again, as after a reinstall: an MCP client that was already running gets a new
 * session on its next call instead of failing for good, and is told once, in the first reply of that new session,
 * that the earlier one ended. No tool reports the link on its own: the next call is how an agent learns.
 */
export async function checkDaemonRestart({ home }) {
  const { client } = await connectMcp(home, 't3-tab-e2e-restart');
  try {
    const before = await client.callTool({ name: 'tabs', arguments: {} });
    assert(before.isError !== true, `tabs failed before the restart: ${text(before)}`);
    assert(!text(before).includes(RESTARTED), 'The restart notice appeared before any restart');

    const oldPid = JSON.parse(await readFile(home.statePath, 'utf8')).pid;
    await stopDaemon(home.statePath);
    // The client's socket closes with the daemon; give the close time to arrive.
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await sleep(100);
    }

    // The next call starts a new daemon and a new session. Until the browser's link is back through the native host it
    // fails, saying why; the first reply of the new session, failed or not, carries the notice.
    const replies = [];
    for (let attempt = 0; attempt < 160; attempt += 1) {
      const reply = await client.callTool({ name: 'tabs', arguments: {} });
      replies.push(reply);
      if (reply.isError !== true) break;
      await sleep(250);
    }
    const last = replies.at(-1);
    assert(last.isError !== true, `tabs still failed after the daemon restarted: ${text(last)}`);
    const told = replies.filter((reply) => text(reply).includes(RESTARTED));
    assert(told.length === 1, `The notice came ${told.length} times in ${replies.length} replies: ${replies.map(text).join('\n---\n')}`);
    const first = replies.indexOf(told[0]);
    for (const reply of replies.slice(0, first)) {
      assert(reply.isError === true && /could not be started|did not start/.test(text(reply)), `A reply before the notice: ${text(reply)}`);
    }
    for (const reply of replies.slice(first, -1)) {
      assert(/No browser is connected/.test(text(reply)), `A failed reply after the restart does not say why: ${text(reply)}`);
    }
    const newPid = JSON.parse(await readFile(home.statePath, 'utf8')).pid;
    assert(newPid !== oldPid, `The daemon did not restart (pid ${oldPid})`);

    const again = await client.callTool({ name: 'tabs', arguments: {} });
    assert(again.isError !== true && !text(again).includes(RESTARTED), `The notice was repeated or the call failed: ${text(again)}`);
    console.log(
      `Daemon restart: a running MCP client got a new session (daemon pid ${oldPid} -> ${newPid}), was told once in the first of ${replies.length} replies` +
        `${replies.length > 1 ? ' (the others said no browser was connected yet)' : ''}, and its tool call worked`,
    );
  } finally {
    await client.close().catch(() => undefined);
  }
}
