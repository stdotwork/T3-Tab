import type { ChildProcess, SpawnOptions } from 'node:child_process';

// How long a stopped process gets after SIGTERM, then how long to wait for it to close after SIGKILL.
export const STOP_GRACE_MS = 5_000;
const KILL_WAIT_MS = 2_000;
const GROUP_POLL_MS = 25;
const MAX_OUTPUT_BYTES = 4 * 1_024 * 1_024;

export type Spawn = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid !== undefined && process.platform !== 'win32') {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
    }
  }
  child.kill(signal);
}

/** True while any process of the child's group is alive, the leader included. */
function groupAlive(child: ChildProcess): boolean {
  if (child.pid === undefined || process.platform === 'win32') return false;
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/**
 * SIGTERM to the child's process group, then SIGKILL to the group after `graceMs` if any of it is still alive, even
 * when the leader has already exited. Returns once the child has closed and its group is gone.
 */
export async function stopProcess(child: ChildProcess, graceMs: number): Promise<void> {
  let leaderClosed = false;
  const closed = new Promise<void>((resolve) => {
    child.once('close', () => {
      leaderClosed = true;
      resolve();
    });
  });
  const pause = async (ms: number): Promise<void> => await new Promise((resolve) => setTimeout(resolve, ms));
  const exited = (): boolean => leaderClosed || typeof child.exitCode === 'number' || typeof child.signalCode === 'string';
  const finished = async (): Promise<void> => {
    // The leader is gone; its `close` follows once its output has been read.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const limit = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, KILL_WAIT_MS);
    });
    await Promise.race([closed, limit]);
    clearTimeout(timer);
  };
  signalGroup(child, 'SIGTERM');
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (exited() && !groupAlive(child)) {
      await finished();
      return;
    }
    await pause(Math.min(GROUP_POLL_MS, Math.max(1, deadline - Date.now())));
  }
  if (exited() && !groupAlive(child)) {
    await finished();
    return;
  }
  signalGroup(child, 'SIGKILL');
  const killDeadline = Date.now() + KILL_WAIT_MS;
  while (Date.now() < killDeadline && !(leaderClosed && !groupAlive(child))) await pause(GROUP_POLL_MS);
}

/** Runs a short command with its input on stdin and collects what it prints. */
export async function run(
  spawn: Spawn,
  command: string,
  args: string[],
  options: {
    env: NodeJS.ProcessEnv;
    input?: string | undefined;
    timeoutMs: number;
    graceMs?: number;
    onSpawn?: (child: ChildProcess) => void;
  },
): Promise<RunResult> {
  return await new Promise<RunResult>((resolve, reject) => {
    const child = spawn(command, args, { env: options.env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    options.onSpawn?.(child);
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut: Error | undefined;
    const timer = setTimeout(() => {
      timedOut = new Error(`${command} did not finish within ${options.timeoutMs / 1_000} seconds`);
      void stopProcess(child, options.graceMs ?? STOP_GRACE_MS).finally(() => finish(timedOut));
    }, options.timeoutMs);
    const finish = (error: Error | undefined, code?: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error !== undefined) reject(error);
      else resolve({ code: code ?? null, stdout, stderr });
    };
    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < MAX_OUTPUT_BYTES) stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < MAX_OUTPUT_BYTES) stderr += chunk.toString();
    });
    child.once('error', (error) => finish(error));
    child.once('close', (code) => finish(timedOut, code));
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(options.input ?? '');
  });
}
