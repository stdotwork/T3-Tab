/**
 * Dictation the way T3 Code's composer does it: the microphone is recorded here as 16 kHz mono 32-bit float PCM and
 * streamed to T3's `/ws/voice` socket, where T3 transcribes it on this machine with the voice model chosen in its
 * Settings → Voice. Nothing goes to another service. The frames follow T3's `SpeechStreamCommand` and its replies.
 */
import type { T3VoiceStatus } from '@t3-tab/protocol';

import type { SpeechOptions } from './t3-client';

export const VOICE_SAMPLE_RATE = 16_000;
/** T3 refuses a recording longer than this. */
export const MAX_RECORDING_MS = 5 * 60_000;
/** T3 refuses a binary frame larger than 64,000 bytes; half a second of audio is 32,000. */
export const CHUNK_SAMPLES = 8_000;
const IN_FLIGHT = 2;
const ANSWER_TIMEOUT_MS = 120_000;

export type MicPermission = 'granted' | 'prompt' | 'denied' | 'unknown';

export interface VoiceBlockInput {
  t3: 'off' | 'connecting' | 'ready' | 'lost';
  /** T3's `voiceTranscription` capability. */
  capability: boolean;
  /** T3's last voice status, when it was asked. */
  status?: T3VoiceStatus | undefined;
  /** The page can record at all (a microphone API and audio worklets). */
  canRecord: boolean;
}

/** Why the mic button cannot record now, in words for its tooltip; undefined when it can. */
export function voiceBlock(input: VoiceBlockInput): string | undefined {
  if (!input.canRecord) return 'This browser page cannot record audio.';
  if (input.t3 !== 'ready') return 'Voice input uses T3 Code, which transcribes on this machine. Connect T3 Code in Settings to use it.';
  if (!input.capability) return 'T3 Code cannot transcribe speech on this machine.';
  if (input.status?.supported === false) return input.status.reason;
  if (input.status?.supported === true && input.status.state === 'missing-model') return 'T3 Code has no voice model yet. Download one in T3 Code, Settings → Voice.';
  return undefined;
}

/** What the mic button says about the microphone itself, once T3 can transcribe. */
export function micPermissionNote(permission: MicPermission): string | undefined {
  if (permission === 'denied') return "The microphone is blocked for T3-Tab. Allow it in the browser's settings for this extension, then try again.";
  if (permission === 'prompt') return 'T3-Tab needs the microphone once. This opens a tab where the browser can ask.';
  return undefined;
}

export interface SocketLike {
  binaryType: string;
  readyState: number;
  send(data: string | ArrayBuffer): void;
  close(code?: number): void;
  addEventListener(type: 'open' | 'close' | 'error', listener: () => void): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
}

type Reply = { type: 'ready' } | { type: 'update'; text?: { committed?: string; tentative?: string } } | { type: 'finished'; text: string } | { type: 'error'; message: string };

function parseReply(data: unknown): Reply | undefined {
  if (typeof data !== 'string') return undefined;
  try {
    const value = JSON.parse(data) as { type?: unknown; text?: unknown; message?: unknown };
    if (value.type === 'ready') return { type: 'ready' };
    if (value.type === 'update') return { type: 'update', ...(typeof value.text === 'object' && value.text !== null ? { text: value.text } : {}) };
    if (value.type === 'finished' && typeof value.text === 'string') return { type: 'finished', text: value.text };
    if (value.type === 'error' && typeof value.message === 'string') return { type: 'error', message: value.message };
  } catch {
    return undefined;
  }
  return undefined;
}

/**
 * One recording on T3's voice socket: `start` with the owner's speech settings, the audio as binary frames with at
 * most two awaiting T3's answer, then `finish`, which T3 answers with the whole transcript.
 */
export class VoiceStream {
  private readonly queue: ArrayBuffer[] = [];
  private inFlight = 0;
  private ready = false;
  private finishing = false;
  private finishSent = false;
  private ended = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly result: Promise<string>;
  private resolve!: (text: string) => void;
  private reject!: (error: Error) => void;

  constructor(
    private readonly socket: SocketLike,
    options: SpeechOptions,
    private readonly onText?: (text: string) => void,
  ) {
    this.result = new Promise<string>((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
    this.result.catch(() => undefined);
    socket.binaryType = 'arraybuffer';
    socket.addEventListener('open', () => {
      socket.send(JSON.stringify({ type: 'start', options }));
      this.arm();
    });
    socket.addEventListener('message', (event) => this.receive(event.data));
    socket.addEventListener('error', () => this.fail('T3 Code ended the voice connection.'));
    socket.addEventListener('close', () => this.fail('T3 Code ended the voice connection.'));
  }

  /** Half a second (or less, at the end) of 16 kHz mono audio. */
  push(samples: Float32Array): void {
    if (this.ended || this.finishing || samples.length === 0) return;
    const copy = new Float32Array(samples);
    this.queue.push(copy.buffer);
    this.pump();
  }

  /** Sends what is left and asks for the transcript. */
  finish(): Promise<string> {
    this.finishing = true;
    this.pump();
    return this.result;
  }

  cancel(): void {
    if (this.ended) return;
    this.ended = true;
    clearTimeout(this.timer);
    this.reject(new Error('Voice input was cancelled.'));
    this.socket.close(1000);
  }

  private receive(data: unknown): void {
    if (this.ended) return;
    const reply = parseReply(data);
    if (reply === undefined) return;
    if (reply.type === 'error') {
      this.fail(reply.message);
      return;
    }
    if (reply.type === 'ready') this.ready = true;
    if (reply.type === 'update') {
      this.inFlight = Math.max(0, this.inFlight - 1);
      const text = `${reply.text?.committed ?? ''}${reply.text?.tentative ?? ''}`;
      if (text !== '') this.onText?.(text);
    }
    if (reply.type === 'finished') {
      this.ended = true;
      clearTimeout(this.timer);
      this.resolve(reply.text.trim());
      this.socket.close(1000);
      return;
    }
    this.pump();
  }

  private pump(): void {
    if (!this.ready || this.ended) return;
    while (this.inFlight < IN_FLIGHT && this.queue.length > 0) {
      const chunk = this.queue.shift() as ArrayBuffer;
      this.inFlight += 1;
      this.socket.send(chunk);
      this.arm();
    }
    if (this.finishing && !this.finishSent && this.queue.length === 0 && this.inFlight === 0) {
      this.finishSent = true;
      this.socket.send(JSON.stringify({ type: 'finish' }));
      this.arm();
    }
  }

  /** T3 answers every frame; a long silence from it ends the recording. */
  private arm(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.fail('T3 Code stopped answering the recording.'), ANSWER_TIMEOUT_MS);
  }

  private fail(message: string): void {
    if (this.ended) return;
    this.ended = true;
    clearTimeout(this.timer);
    this.reject(new Error(message));
    this.socket.close(1000);
  }
}

/** Puts dictated text into the draft at the caret, with a space between it and the words around it. */
export function insertDictation(draft: string, text: string, caret: number = draft.length): { value: string; caret: number } {
  const spoken = text.trim();
  if (spoken === '') return { value: draft, caret };
  const at = Math.max(0, Math.min(caret, draft.length));
  const before = draft.slice(0, at);
  const after = draft.slice(at);
  const lead = before === '' || /\s$/.test(before) ? '' : ' ';
  const trail = after === '' || /^\s/.test(after) ? '' : ' ';
  const value = `${before}${lead}${spoken}${trail}${after}`;
  return { value, caret: before.length + lead.length + spoken.length };
}

export const formatElapsed = (ms: number): string => {
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
};
