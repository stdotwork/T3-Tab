/** The microphone for dictation: its permission, and a recording as 16 kHz mono PCM chunks. */
import { VOICE_SAMPLE_RATE, type MicPermission } from './voice';

export const canRecord = (): boolean => typeof navigator.mediaDevices?.getUserMedia === 'function' && typeof AudioWorkletNode === 'function';

/**
 * The extension's microphone permission. A side panel cannot show the browser's prompt, so `prompt` means the owner has
 * to allow it once in a tab (the `microphone` page); after that the panel records without asking.
 */
export async function micPermission(onChange?: (permission: MicPermission) => void): Promise<{ permission: MicPermission; stop: () => void }> {
  try {
    const status = await navigator.permissions.query({ name: 'microphone' as PermissionName });
    const read = (): MicPermission => (status.state === 'granted' || status.state === 'prompt' || status.state === 'denied' ? status.state : 'unknown');
    const listener = (): void => onChange?.(read());
    status.addEventListener('change', listener);
    return { permission: read(), stop: () => status.removeEventListener('change', listener) };
  } catch {
    return { permission: 'unknown', stop: () => undefined };
  }
}

export interface Capture {
  /** Stops recording; resolves once the last chunk was handed over. */
  stop(): Promise<void>;
  /** Stops at once and drops what is left. */
  cancel(): void;
}

/** Why the browser refused the microphone, in words. */
export function micError(error: unknown): string {
  const name = error instanceof DOMException ? error.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') return "The browser did not let T3-Tab use the microphone. Allow it for this extension in the browser's settings, then try again.";
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'No microphone was found.';
  if (name === 'NotReadableError') return 'The microphone is in use by something else, or the system did not let the browser use it.';
  return 'The microphone could not be started.';
}

export async function startCapture(onChunk: (samples: Float32Array) => void, onLevel: (level: number) => void): Promise<Capture> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  let context: AudioContext | undefined;
  const release = (): void => {
    for (const track of stream.getTracks()) track.stop();
    void context?.close().catch(() => undefined);
  };
  try {
    context = new AudioContext({ sampleRate: VOICE_SAMPLE_RATE });
    await context.audioWorklet.addModule(chrome.runtime.getURL('/pcm-capture.js'));
    const source = context.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(context, 't3-tab-pcm-capture', { numberOfInputs: 1, numberOfOutputs: 0, channelCount: 1, channelCountMode: 'explicit' });
    let stopped: (() => void) | undefined;
    node.port.onmessage = ({ data }: MessageEvent<unknown>) => {
      if (data instanceof Float32Array) onChunk(data);
      else if (data === 'stopped') stopped?.();
      else if (typeof data === 'object' && data !== null && typeof (data as { level?: unknown }).level === 'number') onLevel((data as { level: number }).level);
    };
    source.connect(node);
    if (context.state === 'suspended') await context.resume();
    return {
      stop: async () => {
        await new Promise<void>((resolve) => {
          stopped = resolve;
          node.port.postMessage('stop');
          setTimeout(resolve, 1_000);
        });
        source.disconnect();
        release();
      },
      cancel: () => {
        source.disconnect();
        release();
      },
    };
  } catch (error) {
    release();
    throw error;
  }
}
