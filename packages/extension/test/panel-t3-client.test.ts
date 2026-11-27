import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fakes = vi.hoisted(() => {
  type Item = Record<string, unknown>;
  class FakeSocket {
    static instances: FakeSocket[] = [];
    /** `ready` answers both subscriptions with a snapshot; `hang` answers nothing. */
    static mode: 'ready' | 'hang' = 'ready';
    static threads: Array<{ id: string }> = [];
    readonly streams: Array<{ tag: string; onValue: (value: Item) => void; onEnd?: (error?: Error) => void }> = [];
    closeCalls = 0;
    private closed = false;
    readonly mode = FakeSocket.mode;
    constructor(
      readonly url: string,
      private readonly onClose: () => void,
    ) {}
    stream(tag: string, _payload: unknown, onValue: (value: Item) => void, onEnd?: (error?: Error) => void): () => void {
      this.streams.push({ tag, onValue, ...(onEnd === undefined ? {} : { onEnd }) });
      if (this.mode === 'ready') {
        queueMicrotask(() => {
          if (tag === 'subscribeServerConfig') onValue({ type: 'snapshot', config: { providers: [], settings: {} } });
          else if (tag === 'orchestration.subscribeShell') onValue({ kind: 'snapshot', snapshot: { threads: FakeSocket.threads, projects: [] } });
        });
      }
      return () => undefined;
    }
    request(): Promise<never> {
      return new Promise(() => undefined);
    }
    /** What the client's own close does: the browser reports the close to the socket's owner. */
    close(): void {
      this.closeCalls += 1;
      this.finish();
    }
    /** The connection dropped: pending streams fail first, then the owner hears of the close, as in `RpcSocket`. */
    drop(): void {
      for (const stream of this.streams) stream.onEnd?.(new Error('The connection to T3 Code closed.'));
      this.finish();
    }
    /** A stream ends with an error while the socket stays open. */
    failStreams(message: string): void {
      for (const stream of this.streams) stream.onEnd?.(new Error(message));
    }
    private finish(): void {
      if (this.closed) return;
      this.closed = true;
      this.onClose();
    }
    shell(item: Item): void {
      for (const stream of this.streams) if (stream.tag === 'orchestration.subscribeShell') stream.onValue(item);
    }
  }
  class SessionRefused extends Error {
    constructor(
      message: string,
      readonly status: number,
    ) {
      super(message);
    }
  }
  return {
    FakeSocket,
    SessionRefused,
    storedSession: vi.fn(),
    forgetSession: vi.fn(),
    pairWithT3: vi.fn(),
    socketUrl: vi.fn(),
  };
});

vi.mock('../entrypoints/sidepanel/lib/t3-rpc', () => ({
  RpcSocket: {
    open: async (url: string, onClose: () => void) => {
      const socket = new fakes.FakeSocket(url, onClose);
      fakes.FakeSocket.instances.push(socket);
      return socket;
    },
  },
}));
vi.mock('../entrypoints/sidepanel/lib/t3-session', () => ({
  SessionRefused: fakes.SessionRefused,
  storedSession: fakes.storedSession,
  forgetSession: fakes.forgetSession,
  pairWithT3: fakes.pairWithT3,
  socketUrl: fakes.socketUrl,
}));

import { T3Client } from '../entrypoints/sidepanel/lib/t3-client';

const { FakeSocket, SessionRefused } = fakes;
const session = (name: string) => ({ origin: `http://127.0.0.1:${name}`, accessToken: `token-${name}`, expiresAt: Date.now() + 3_600_000 });

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
const flush = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(0);
};

beforeEach(() => {
  vi.useFakeTimers();
  FakeSocket.instances = [];
  FakeSocket.mode = 'ready';
  FakeSocket.threads = [];
  fakes.storedSession.mockReset().mockResolvedValue(session('1'));
  fakes.forgetSession.mockReset().mockResolvedValue(undefined);
  fakes.pairWithT3.mockReset().mockResolvedValue(session('2'));
  let count = 0;
  fakes.socketUrl.mockReset().mockImplementation(async (current: { origin: string }) => ({ url: `ws://${current.origin}/${(count += 1)}`, session: current }));
});
afterEach(() => vi.useRealTimers());

describe('the panel\'s connection to T3', () => {
  it('shares one attempt between callers: a second connect during an attempt opens no second socket', async () => {
    const urlAnswer = deferred<{ url: string; session: ReturnType<typeof session> }>();
    fakes.socketUrl.mockReset().mockImplementation(() => urlAnswer.promise);
    const client = new T3Client();
    const first = client.start();
    const second = client.start();
    await flush();
    expect(fakes.socketUrl).toHaveBeenCalledTimes(1);
    urlAnswer.resolve({ url: 'ws://one', session: session('1') });
    await Promise.all([first, second]);
    expect(FakeSocket.instances).toHaveLength(1);
    expect(client.snapshot().status).toBe('ready');
  });

  it('ignores a failure of an attempt that a newer session replaced: no lost state, no retry', async () => {
    const stale = deferred<{ url: string; session: ReturnType<typeof session> }>();
    fakes.socketUrl.mockReset().mockImplementationOnce(() => stale.promise).mockImplementation(async (current: unknown) => ({ url: 'ws://new', session: current }));
    const client = new T3Client();
    const old = client.start();
    await flush();
    await client.pair();
    expect(client.snapshot().status).toBe('ready');
    expect(client.snapshot().origin).toBe(session('2').origin);
    const before = client.snapshot();
    stale.reject(new Error('Could not reach T3 Code.'));
    await old;
    await flush();
    expect(client.snapshot()).toBe(before);
    expect(client.snapshot().status).toBe('ready');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('ignores a subscribe failure of a superseded attempt\'s socket', async () => {
    FakeSocket.mode = 'hang';
    const client = new T3Client();
    const old = client.start();
    await flush();
    const [oldSocket] = FakeSocket.instances;
    expect(oldSocket).toBeDefined();
    FakeSocket.mode = 'ready';
    await client.pair();
    expect(client.snapshot().status).toBe('ready');
    const before = client.snapshot();
    oldSocket?.failStreams('T3 Code ended the connection.');
    await old;
    await flush();
    expect(client.snapshot()).toBe(before);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('ignores the close of an older socket once a newer one is connected', async () => {
    const client = new T3Client();
    await client.start();
    const [first] = FakeSocket.instances;
    await client.pair();
    expect(FakeSocket.instances).toHaveLength(2);
    expect(first?.closeCalls).toBeGreaterThan(0);
    const before = client.snapshot();
    first?.drop();
    await flush();
    expect(client.snapshot()).toBe(before);
    expect(client.snapshot().status).toBe('ready');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('ignores shell items from an older socket', async () => {
    FakeSocket.threads = [{ id: 'kept' }];
    const client = new T3Client();
    await client.start();
    const [first] = FakeSocket.instances;
    await client.pair();
    expect(client.snapshot().threads.map((thread) => thread.id)).toEqual(['kept']);
    first?.shell({ kind: 'thread.updated', location: 'active', thread: { id: 'stale', projectId: 'p', title: 'stale' } });
    first?.shell({ kind: 'thread.removed', threadId: 'kept' });
    expect(client.snapshot().threads.map((thread) => thread.id)).toEqual(['kept']);
    // The current socket's items still apply.
    FakeSocket.instances[1]?.shell({ kind: 'thread.updated', location: 'active', thread: { id: 'fresh', projectId: 'p', title: 'fresh' } });
    expect(client.snapshot().threads.map((thread) => thread.id)).toEqual(['fresh', 'kept']);
  });

  it('forgets the session and does not retry when T3 refuses it with 401 (also what an address that moved comes as)', async () => {
    fakes.socketUrl.mockReset().mockRejectedValue(new SessionRefused('T3 ended this session. Connect again.', 401));
    const client = new T3Client();
    await client.start();
    await flush();
    expect(fakes.forgetSession).toHaveBeenCalledTimes(1);
    expect(client.snapshot()).toMatchObject({ status: 'off', error: 'T3 ended this session. Connect again.' });
    expect(vi.getTimerCount()).toBe(0);
    expect(FakeSocket.instances).toHaveLength(0);
  });

  it('keeps the session and retries after another failure', async () => {
    fakes.socketUrl.mockReset().mockRejectedValueOnce(new SessionRefused('T3 refused the connection (HTTP 500).', 500)).mockImplementation(async (current: unknown) => ({ url: 'ws://ok', session: current }));
    const client = new T3Client();
    await client.start();
    expect(fakes.forgetSession).not.toHaveBeenCalled();
    expect(client.snapshot().status).toBe('lost');
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(500);
    expect(client.snapshot().status).toBe('ready');
  });

  it('retries once when the socket closes during subscribe', async () => {
    FakeSocket.mode = 'hang';
    const client = new T3Client();
    const starting = client.start();
    await flush();
    const [dropped] = FakeSocket.instances;
    FakeSocket.mode = 'ready';
    dropped?.drop();
    await starting;
    await flush();
    expect(client.snapshot().status).toBe('lost');
    expect(fakes.socketUrl).toHaveBeenCalledTimes(1);
    // One retry is scheduled, not two: the failed subscribe and the close do not each schedule one.
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(500);
    expect(fakes.socketUrl).toHaveBeenCalledTimes(2);
    expect(FakeSocket.instances).toHaveLength(2);
    expect(client.snapshot().status).toBe('ready');
    expect(vi.getTimerCount()).toBe(0);
  });
});
