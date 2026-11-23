/**
 * T3's WebSocket RPC (Effect RPC with JSON frames): requests, streams acknowledged chunk by chunk, and pings.
 * The frame shapes follow Effect's RpcMessage as T3 Code uses it (see THIRD_PARTY_NOTICES.md); this client is T3-Tab's.
 */
const PING_MS = 5_000;
const SILENCE_MS = 15_000;

type Frame = { _tag: string; requestId?: string | number; values?: unknown[]; exit?: RpcExit; defect?: unknown };
type RpcExit = { _tag: 'Success'; value?: unknown } | { _tag: 'Failure'; cause?: Array<{ _tag: string; error?: unknown; defect?: unknown }> };

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  onValue?: (value: unknown) => void;
}

export function exitMessage(exit: RpcExit): string {
  if (exit._tag === 'Success') return '';
  const first = exit.cause?.[0];
  const error = first?.error as { message?: unknown } | undefined;
  if (typeof error?.message === 'string') return error.message;
  return first?._tag === 'Interrupt' ? 'Interrupted' : 'T3 could not do that.';
}

export class RpcSocket {
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private lastFrame = Date.now();
  private pinger: ReturnType<typeof setInterval> | undefined;
  private closed = false;

  private constructor(
    private readonly socket: WebSocket,
    private readonly onClose: () => void,
  ) {
    socket.addEventListener('message', (event) => this.receive(event.data));
    socket.addEventListener('close', () => this.shut());
    socket.addEventListener('error', () => socket.close());
    this.pinger = setInterval(() => {
      if (Date.now() - this.lastFrame > SILENCE_MS) socket.close();
      else this.write({ _tag: 'Ping' });
    }, PING_MS);
  }

  static open(url: string, onClose: () => void): Promise<RpcSocket> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      const failed = (): void => reject(new Error('Could not reach T3 Code.'));
      socket.addEventListener('error', failed, { once: true });
      socket.addEventListener(
        'open',
        () => {
          socket.removeEventListener('error', failed);
          resolve(new RpcSocket(socket, onClose));
        },
        { once: true },
      );
    });
  }

  close(): void {
    this.socket.close();
  }

  request<T>(tag: string, payload: unknown): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (this.closed) {
        reject(new Error('T3 Code is not connected.'));
        return;
      }
      const id = this.nextId++;
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      this.write({ _tag: 'Request', id, tag, payload, headers: [] });
    });
  }

  /** Delivers each item to `onValue`. The returned function stops the stream. */
  stream(tag: string, payload: unknown, onValue: (value: unknown) => void, onEnd?: (error?: Error) => void): () => void {
    const id = this.nextId++;
    this.pending.set(id, {
      onValue,
      resolve: () => onEnd?.(),
      reject: (error) => onEnd?.(error),
    });
    this.write({ _tag: 'Request', id, tag, payload, headers: [] });
    return () => {
      if (this.pending.delete(id)) this.write({ _tag: 'Interrupt', requestId: id });
    };
  }

  private write(frame: unknown): void {
    if (this.socket.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(frame));
  }

  private receive(data: unknown): void {
    if (typeof data !== 'string') return;
    this.lastFrame = Date.now();
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    for (const frame of (Array.isArray(parsed) ? parsed : [parsed]) as Frame[]) this.handle(frame);
  }

  private handle(frame: Frame): void {
    if (frame._tag === 'Defect') {
      this.failAll(new Error('T3 Code hit an internal error.'));
      return;
    }
    const id = Number(frame.requestId);
    if (frame._tag === 'Chunk') {
      // Every chunk is acknowledged, even for a stream just stopped, or the server's stream stalls.
      this.write({ _tag: 'Ack', requestId: frame.requestId });
      const entry = this.pending.get(id);
      if (entry?.onValue !== undefined) for (const value of frame.values ?? []) entry.onValue(value);
      return;
    }
    if (frame._tag !== 'Exit' || frame.exit === undefined) return;
    const entry = this.pending.get(id);
    if (entry === undefined) return;
    this.pending.delete(id);
    if (frame.exit._tag === 'Success') entry.resolve(frame.exit.value);
    else entry.reject(new Error(exitMessage(frame.exit)));
  }

  private failAll(error: Error): void {
    const entries = [...this.pending.values()];
    this.pending.clear();
    for (const entry of entries) entry.reject(error);
  }

  private shut(): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.pinger);
    this.failAll(new Error('The connection to T3 Code closed.'));
    this.onClose();
  }
}
