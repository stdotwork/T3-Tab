import { describe, expect, it } from 'vitest';

import { provenT3Thread, type ControlPeer, type ProcessView } from '../src/agents/t3-thread-identity.js';

const T3_PID = 100;
const DAEMON_PID = 50;
const STARTED_AT = 1_000_000;
const peer: ControlPeer = { address: '127.0.0.1', port: 40_000, localAddress: '127.0.0.1', localPort: 8765 };

interface FakeProcess {
  parent: number;
  thread?: string | string[];
}

function view(processes: Record<number, FakeProcess>, options: { holder?: number; t3StartMs?: number } = {}): ProcessView {
  const known = (pid: number): FakeProcess => {
    const entry = processes[pid];
    if (entry === undefined) throw new Error(`no process ${pid}`);
    return entry;
  };
  return {
    holdsPeerSocket: async (pid) => pid === (options.holder ?? 300),
    environ: async (pid) => {
      const { thread } = known(pid);
      const ids = thread === undefined ? [] : Array.isArray(thread) ? thread : [thread];
      return ['PATH=/bin', ...ids.map((id) => `T3CODE_THREAD_ID=${id}`), ''].join('\0');
    },
    parent: async (pid) => known(pid).parent,
    startMs: async () => options.t3StartMs ?? STARTED_AT - 5_000,
  };
}

const prove = async (processes: Record<number, FakeProcess>, options?: { holder?: number; t3StartMs?: number }, pid = 300): Promise<string | undefined> =>
  await provenT3Thread({ pid, peer, daemonPid: DAEMON_PID, t3: { pid: T3_PID, startedAt: STARTED_AT } }, view(processes, options));

const t3: FakeProcess = { parent: 1 };

describe('proving which T3 thread a control connection runs for', () => {
  it('accepts an MCP server under a provider that carries the same thread', async () => {
    expect(await prove({ 300: { parent: 200, thread: 'th-a' }, 200: { parent: T3_PID, thread: 'th-a' }, [T3_PID]: t3 })).toBe('th-a');
  });

  it("accepts Codex's shared app-server, which carries no thread id", async () => {
    expect(await prove({ 300: { parent: 200, thread: 'th-a' }, 200: { parent: T3_PID }, [T3_PID]: t3 })).toBe('th-a');
  });

  it("ignores an id on the T3 server itself, as when T3 was started from another T3's thread", async () => {
    expect(await prove({ 300: { parent: T3_PID, thread: 'th-a' }, [T3_PID]: { parent: 1, thread: 'outer' } })).toBe('th-a');
  });

  it('refuses a command that claims another thread than its own shell', async () => {
    expect(
      await prove({ 300: { parent: 250, thread: 'th-full' }, 250: { parent: 200, thread: 'th-supervised' }, 200: { parent: T3_PID, thread: 'th-supervised' }, [T3_PID]: t3 }),
    ).toBeUndefined();
  });

  it('refuses a process that does not hold the socket', async () => {
    expect(await prove({ 300: { parent: T3_PID, thread: 'th-a' }, [T3_PID]: t3 }, { holder: 301 })).toBeUndefined();
  });

  it('refuses a process with no id, several ids or a malformed id', async () => {
    expect(await prove({ 300: { parent: T3_PID }, [T3_PID]: t3 })).toBeUndefined();
    expect(await prove({ 300: { parent: T3_PID, thread: ['a', 'b'] }, [T3_PID]: t3 })).toBeUndefined();
    expect(await prove({ 300: { parent: T3_PID, thread: 'bad id' }, [T3_PID]: t3 })).toBeUndefined();
  });

  it('refuses a chain that never reaches the T3 server', async () => {
    expect(await prove({ 300: { parent: 200, thread: 'th-a' }, 200: { parent: 1, thread: 'th-a' } })).toBeUndefined();
  });

  it("refuses a direct run under this daemon, even with the id the daemon inherited", async () => {
    expect(
      await prove({ 300: { parent: 200, thread: 'th-a' }, 200: { parent: DAEMON_PID, thread: 'th-a' }, [DAEMON_PID]: { parent: T3_PID, thread: 'th-a' }, [T3_PID]: t3 }),
    ).toBeUndefined();
  });

  it('refuses a T3 pid whose process started after the record', async () => {
    expect(await prove({ 300: { parent: T3_PID, thread: 'th-a' }, [T3_PID]: t3 }, { t3StartMs: STARTED_AT + 1 })).toBeUndefined();
  });

  it('refuses the T3 server or the daemon as the connection itself', async () => {
    expect(await prove({ [T3_PID]: { parent: 1, thread: 'th-a' } }, { holder: T3_PID }, T3_PID)).toBeUndefined();
    expect(await prove({ [DAEMON_PID]: { parent: T3_PID, thread: 'th-a' }, [T3_PID]: t3 }, { holder: DAEMON_PID }, DAEMON_PID)).toBeUndefined();
  });

  it('refuses when a process cannot be read, and on a parent loop', async () => {
    expect(await prove({ 300: { parent: 200, thread: 'th-a' } })).toBeUndefined();
    expect(await prove({ 300: { parent: 200, thread: 'th-a' }, 200: { parent: 300, thread: 'th-a' } })).toBeUndefined();
  });
});
