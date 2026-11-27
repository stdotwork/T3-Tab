import { readFile } from 'node:fs/promises';

import { peerSocketInode, processHoldsSocket, processStartMs, type T3Process } from './t3-connection.js';
import { recordedT3Process } from './t3-environment.js';

/** The variable T3 Code sets for the provider processes of a thread, and through them their MCP servers. */
const THREAD_VARIABLE = 'T3CODE_THREAD_ID=';
const THREAD_ID = /^[A-Za-z0-9][A-Za-z0-9_.:%-]{0,255}$/;
/** Further than any real provider, wrapper and MCP server chain. */
const MAX_ANCESTORS = 32;

/** Both ends of a control connection, as the daemon's accepted socket reports them. */
export interface ControlPeer {
  address: string | undefined;
  port: number | undefined;
  localAddress: string | undefined;
  localPort: number | undefined;
}

/** What the check reads about processes. Tests pass their own. */
export interface ProcessView {
  holdsPeerSocket(pid: number, peer: ControlPeer): Promise<boolean>;
  environ(pid: number): Promise<string>;
  parent(pid: number): Promise<number>;
  startMs(pid: number): Promise<number>;
}

const procView: ProcessView = {
  holdsPeerSocket: async (pid, peer) => {
    const inode = await peerSocketInode(
      { address: peer.address, port: peer.port },
      { address: peer.localAddress, port: peer.localPort },
    );
    return inode !== undefined && (await processHoldsSocket(pid, inode));
  },
  environ: async (pid) => await readFile(`/proc/${pid}/environ`, 'latin1'),
  parent: async (pid) => {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
    // The command name, field 2, may hold spaces and brackets; the parent pid is the second field after it.
    return Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
  },
  startMs: processStartMs,
};

const threadIdsIn = (environ: string): string[] =>
  environ
    .split('\0')
    .filter((entry) => entry.startsWith(THREAD_VARIABLE))
    .map((entry) => entry.slice(THREAD_VARIABLE.length));

/**
 * The T3 thread a control connection's process runs for, or undefined when that cannot be shown.
 *
 * The process must hold the connection's socket and carry one valid `T3CODE_THREAD_ID`. Walking up its parents must
 * reach the T3 server T3 recorded, which must not have started after its record, without passing through this daemon
 * (a direct run from the panel inherits whatever the daemon was started with), and no process on the way may name
 * another thread. So a command an agent starts with another thread's id is refused: its own shell still names the
 * real one. Codex's shared app-server carries no id, which is why a process with none does not break the chain.
 */
export async function provenT3Thread(
  input: { pid: number; peer: ControlPeer; daemonPid: number; t3: T3Process },
  view: ProcessView = procView,
): Promise<string | undefined> {
  const { pid, peer, daemonPid, t3 } = input;
  if (pid <= 1 || pid === daemonPid || pid === t3.pid) return undefined;
  try {
    const own = threadIdsIn(await view.environ(pid));
    const thread = own[0];
    if (own.length !== 1 || thread === undefined || !THREAD_ID.test(thread)) return undefined;
    // Read after the environment, so a pid reused in between cannot lend its socket to another process's variables.
    if (!(await view.holdsPeerSocket(pid, peer))) return undefined;
    let current = await view.parent(pid);
    for (let depth = 0; depth < MAX_ANCESTORS; depth += 1) {
      if (!Number.isInteger(current) || current <= 1 || current === daemonPid) return undefined;
      if (current === t3.pid) return (await view.startMs(current)) <= t3.startedAt ? thread : undefined;
      if (threadIdsIn(await view.environ(current)).some((id) => id !== thread)) return undefined;
      current = await view.parent(current);
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** The check against the T3 server this daemon's T3 home records. Only Linux has the `/proc` it reads. */
export async function t3ThreadOfPeer(pid: number, peer: ControlPeer, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  if (process.platform !== 'linux') return undefined;
  const t3 = await recordedT3Process(env);
  return t3 === undefined ? undefined : await provenT3Thread({ pid, peer, daemonPid: process.pid, t3 });
}
