import type { T3VoiceStatus } from '@t3-tab/protocol';
import { Loader2, Mic, MicOff, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';

import { errorText } from './lib/api';
import { canRecord, micError, micPermission, startCapture, type Capture } from './lib/mic';
import { t3, type T3State } from './lib/t3-client';
import { formatElapsed, MAX_RECORDING_MS, micPermissionNote, voiceBlock, VoiceStream, type MicPermission } from './lib/voice';
import { ICON } from './ui';

const STATUS_TTL_MS = 60_000;
/** A note from the mic clears itself after this long. */
const NOTICE_MS = 8_000;

export type DictationPhase = 'idle' | 'starting' | 'recording' | 'finishing';

export interface Dictation {
  phase: DictationPhase;
  elapsedMs: number;
  level: number;
  /** Why the button cannot record now; the button still shows it on a press. */
  blocked?: string | undefined;
  permission: MicPermission;
  /** Starts, or finishes and inserts the text. */
  toggle: () => void;
  cancel: () => void;
}

/**
 * Dictation into the composer through T3 Code's own transcription. `onText` gets the transcript when a recording ends;
 * `onNotice` gets anything the owner should know, such as why it cannot record.
 */
export function useDictation(state: T3State, onText: (text: string) => void, onNotice: (text: string | undefined) => void): Dictation {
  const [phase, setPhase] = useState<DictationPhase>('idle');
  const [elapsedMs, setElapsed] = useState(0);
  const [level, setLevel] = useState(0);
  const [permission, setPermission] = useState<MicPermission>('unknown');
  const [status, setStatus] = useState<{ at: number; value: T3VoiceStatus }>();
  const session = useRef<{ capture?: Capture; stream?: VoiceStream; startedAt: number; cancelled: boolean } | undefined>(undefined);
  const noticeTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const say = (text: string | undefined): void => {
    clearTimeout(noticeTimer.current);
    onNotice(text);
    if (text !== undefined) noticeTimer.current = setTimeout(() => latest.current.onNotice(undefined), NOTICE_MS);
  };
  const latest = useRef({ onText, onNotice: say });
  latest.current = { onText, onNotice: say };
  useEffect(() => () => clearTimeout(noticeTimer.current), []);

  useEffect(() => {
    let stop: (() => void) | undefined;
    let live = true;
    void micPermission((next) => setPermission(next)).then((watch) => {
      if (!live) {
        watch.stop();
        return;
      }
      stop = watch.stop;
      setPermission(watch.permission);
    });
    return () => {
      live = false;
      stop?.();
    };
  }, []);

  useEffect(() => {
    if (phase !== 'recording') return;
    const timer = setInterval(() => {
      const started = session.current?.startedAt ?? Date.now();
      const elapsed = Date.now() - started;
      setElapsed(elapsed);
      if (elapsed >= MAX_RECORDING_MS) void finish();
    }, 250);
    return () => clearInterval(timer);
  });

  // Recording stops with the panel.
  useEffect(() => () => {
    const current = session.current;
    if (current === undefined) return;
    current.cancelled = true;
    current.capture?.cancel();
    current.stream?.cancel();
  }, []);

  const blocked = voiceBlock({ t3: state.status, capability: state.voice, status: status?.value, canRecord: canRecord() });

  const reset = (): void => {
    session.current = undefined;
    setPhase('idle');
    setElapsed(0);
    setLevel(0);
  };

  const finish = useCallback(async (): Promise<void> => {
    const current = session.current;
    if (current === undefined || current.stream === undefined || current.capture === undefined) return;
    setPhase('finishing');
    try {
      await current.capture.stop();
      const text = await current.stream.finish();
      if (!current.cancelled) {
        if (text === '') latest.current.onNotice('No speech was heard.');
        else latest.current.onText(text);
      }
    } catch (error) {
      if (!current.cancelled) latest.current.onNotice(errorText(error));
    } finally {
      if (session.current === current) reset();
    }
  }, []);

  const start = async (): Promise<void> => {
    latest.current.onNotice(undefined);
    if (blocked !== undefined) {
      latest.current.onNotice(blocked);
      return;
    }
    if (permission === 'denied') {
      latest.current.onNotice(micPermissionNote('denied'));
      return;
    }
    if (permission === 'prompt') {
      latest.current.onNotice('Allow the microphone in the tab that opened, then press the mic again.');
      await chrome.tabs.create({ url: chrome.runtime.getURL('/microphone.html') });
      return;
    }
    const current: NonNullable<typeof session.current> = { startedAt: Date.now(), cancelled: false };
    session.current = current;
    setPhase('starting');
    try {
      // Asked again before every recording only when the last answer is old: the model can be removed in T3.
      let voice = status?.value;
      if (status === undefined || Date.now() - status.at > STATUS_TTL_MS) {
        voice = await t3.voiceStatus();
        setStatus({ at: Date.now(), value: voice });
      }
      const why = voiceBlock({ t3: state.status, capability: state.voice, status: voice, canRecord: true });
      if (why !== undefined) throw new Error(why);
      const socket = new WebSocket(await t3.voiceSocket());
      const stream = new VoiceStream(socket, state.speech);
      current.stream = stream;
      let capture: Capture;
      try {
        capture = await startCapture(
          (samples) => stream.push(samples),
          (value) => setLevel(value),
        );
      } catch (error) {
        stream.cancel();
        throw new Error(micError(error));
      }
      if (current.cancelled) {
        capture.cancel();
        return;
      }
      current.capture = capture;
      current.startedAt = Date.now();
      setPhase('recording');
    } catch (error) {
      current.capture?.cancel();
      current.stream?.cancel();
      if (session.current === current) reset();
      latest.current.onNotice(errorText(error));
    }
  };

  const cancel = (): void => {
    const current = session.current;
    if (current === undefined) return;
    current.cancelled = true;
    current.capture?.cancel();
    current.stream?.cancel();
    reset();
  };

  return {
    phase,
    elapsedMs,
    level,
    blocked,
    permission,
    toggle: () => {
      if (phase === 'idle') void start();
      else if (phase === 'recording') void finish();
    },
    cancel,
  };
}

/** The mic button just left of send, as in T3 Code; while recording it shows the time and a cancel. */
export function MicButton({ dictation }: { dictation: Dictation }): ReactNode {
  const { phase, blocked, permission } = dictation;
  if (phase === 'recording' || phase === 'finishing') {
    return (
      <span className="mic-pill" data-ink="box" style={{ '--mic-level': String(dictation.level) } as CSSProperties}>
        <button type="button" className="mic-cancel" aria-label="Cancel voice input" title="Cancel voice input" onClick={dictation.cancel}>
          <X size={ICON.xs} aria-hidden="true" />
        </button>
        <span className="mic-time" aria-live="polite">
          {phase === 'finishing' ? 'Transcribing' : formatElapsed(dictation.elapsedMs)}
        </span>
        <button type="button" className="composer-icon mic-btn recording" aria-label="Finish voice input" title="Finish voice input" disabled={phase === 'finishing'} onClick={dictation.toggle}>
          {phase === 'finishing' ? <Loader2 size={ICON.md} className="spin" aria-hidden="true" /> : <Mic size={ICON.md} aria-hidden="true" />}
        </button>
      </span>
    );
  }
  const note = blocked ?? micPermissionNote(permission);
  const off = blocked !== undefined || permission === 'denied';
  return (
    <button
      type="button"
      className={off ? 'composer-icon mic-btn off' : 'composer-icon mic-btn'}
      aria-label={off ? `Voice input unavailable: ${note ?? ''}` : 'Start voice input'}
      title={note === undefined ? 'Start voice input' : note}
      onClick={dictation.toggle}
      disabled={phase === 'starting'}
    >
      {phase === 'starting' ? <Loader2 size={ICON.md} className="spin" aria-hidden="true" /> : off ? <MicOff size={ICON.md} aria-hidden="true" /> : <Mic size={ICON.md} aria-hidden="true" />}
    </button>
  );
}
