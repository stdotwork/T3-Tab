import { describe, expect, it } from 'vitest';

import { acceptFor, attachmentProblems, draftAttachment, fileBase64, t3Kind, type DraftAttachment } from '../entrypoints/sidepanel/lib/attachments';
import { DEFAULT_SPEECH, speechOptions } from '../entrypoints/sidepanel/lib/t3-client';
import { formatElapsed, insertDictation, micPermissionNote, voiceBlock, VoiceStream, type SocketLike } from '../entrypoints/sidepanel/lib/voice';

const MB = 1024 * 1024;
const item = (key: string, mimeType: string, size: number, name = `${key}.bin`): DraftAttachment => ({ key, file: new File([], name), name, mimeType, size });

describe('composer attachments', () => {
  it('sends images to T3 as images and everything else as files, within T3 limits', () => {
    expect(t3Kind({ mimeType: 'image/png' })).toBe('image');
    expect(t3Kind({ mimeType: 'image/svg+xml' })).toBe('file');
    expect(t3Kind({ mimeType: 'application/pdf' })).toBe('file');
    const problems = attachmentProblems(
      [item('a', 'image/png', 1), item('b', 'application/pdf', 49 * MB), item('c', 'image/jpeg', 11 * MB), item('d', 'text/plain', 51 * MB), item('e', 'text/plain', 0)],
      { kind: 't3' },
    );
    expect([...problems.keys()]).toEqual(['c', 'd', 'e']);
    expect(problems.get('c')).toContain('images up to 10 MB');
    expect(problems.get('d')).toContain('files up to 50 MB');
  });

  it('says why a file cannot go to a direct run rather than dropping it', () => {
    const problems = attachmentProblems([item('a', 'image/png', MB), item('b', 'application/pdf', 10, 'spec.pdf'), item('c', 'image/webp', 6 * MB)], { kind: 'direct', agent: 'Codex' });
    expect(problems.has('a')).toBe(false);
    expect(problems.get('b')).toBe("spec.pdf can't go to Codex: it takes PNG, JPEG, GIF and WebP images only.");
    expect(problems.get('c')).toContain('up to 5 MB');
  });

  it('holds a direct run to 6 MB of images a message', () => {
    const problems = attachmentProblems([item('a', 'image/png', 4 * MB), item('b', 'image/png', 3 * MB)], { kind: 'direct', agent: 'Claude Code' });
    expect([...problems.keys()]).toEqual(['b']);
  });

  it('offers only images in the file chooser of a direct run', () => {
    expect(acceptFor({ kind: 't3' })).toBeUndefined();
    expect(acceptFor({ kind: 'direct', agent: 'Codex' })).toBe('image/png,image/jpeg,image/gif,image/webp');
  });

  it('keeps control characters out of a name and gives a typeless file a type', () => {
    const draft = draftAttachment(new File(['x'], 'a\u0007b\nc.txt', { type: '' }), 'k');
    expect(draft.name).toBe('abc.txt');
    expect(draft.mimeType).toBe('application/octet-stream');
    expect(draftAttachment(new File(['x'], '\n'), 'k').name).toBe('pasted-file');
  });

  it('encodes a file as base64', async () => {
    expect(await fileBase64(new Blob([new Uint8Array([0, 1, 2, 250, 255])]))).toBe(Buffer.from([0, 1, 2, 250, 255]).toString('base64'));
  });
});

describe('dictation', () => {
  it('says why it cannot record, from T3 down to the voice model', () => {
    const ready = { t3: 'ready', capability: true, canRecord: true } as const;
    expect(voiceBlock({ ...ready, t3: 'off' })).toContain('Connect T3 Code');
    expect(voiceBlock({ ...ready, capability: false })).toBe('T3 Code cannot transcribe speech on this machine.');
    expect(voiceBlock({ ...ready, status: { supported: false, reason: 'voice transcription is not available on linux-riscv64' } })).toBe(
      'voice transcription is not available on linux-riscv64',
    );
    expect(voiceBlock({ ...ready, status: { supported: true, state: 'missing-model' } })).toContain('Settings → Voice');
    expect(voiceBlock({ ...ready, canRecord: false })).toBe('This browser page cannot record audio.');
    expect(voiceBlock({ ...ready, status: { supported: true, state: 'ready' } })).toBeUndefined();
    expect(voiceBlock(ready)).toBeUndefined();
  });

  it('explains the microphone permission the side panel cannot ask for itself', () => {
    expect(micPermissionNote('prompt')).toContain('opens a tab');
    expect(micPermissionNote('denied')).toContain('blocked');
    expect(micPermissionNote('granted')).toBeUndefined();
  });

  it('puts dictated text at the caret with spaces around it', () => {
    expect(insertDictation('', ' hello ')).toEqual({ value: 'hello', caret: 5 });
    expect(insertDictation('fix the', 'login bug')).toEqual({ value: 'fix the login bug', caret: 17 });
    expect(insertDictation('fix bug', 'the login', 4)).toEqual({ value: 'fix the login bug', caret: 13 });
    expect(insertDictation('a ', 'b', 2).value).toBe('a b');
    expect(insertDictation('keep', '   ').value).toBe('keep');
  });

  it('formats the recording time', () => {
    expect(formatElapsed(0)).toBe('0:00');
    expect(formatElapsed(65_400)).toBe('1:05');
  });

  it("takes the owner's speech settings from T3 and falls back to T3's defaults", () => {
    expect(speechOptions({})).toEqual(DEFAULT_SPEECH);
    expect(speechOptions({ speechLanguage: 'de', speechTranslateToEnglish: true, speechRemoveFillerWords: false, speechSilenceFiltering: false })).toEqual({
      ...DEFAULT_SPEECH,
      speechLanguage: 'de',
      speechTranslateToEnglish: true,
      speechRemoveFillerWords: false,
      speechSilenceFiltering: false,
    });
  });
});

class FakeVoiceSocket implements SocketLike {
  binaryType = 'blob';
  readyState = 0;
  readonly sent: Array<string | ArrayBuffer> = [];
  closed = false;
  private readonly listeners = new Map<string, Array<(event: { data: unknown }) => void>>();
  addEventListener(type: string, listener: (event: { data: unknown }) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  send(data: string | ArrayBuffer): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
  }
  emit(type: string, data?: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener({ data });
  }
  reply(value: unknown): void {
    this.emit('message', JSON.stringify(value));
  }
  get binary(): ArrayBuffer[] {
    return this.sent.filter((entry): entry is ArrayBuffer => entry instanceof ArrayBuffer);
  }
  get commands(): unknown[] {
    return this.sent.filter((entry): entry is string => typeof entry === 'string').map((entry) => JSON.parse(entry) as unknown);
  }
}

describe("T3's voice socket", () => {
  it('starts with the speech settings, keeps two chunks in flight, finishes once all were answered and returns the text', async () => {
    const socket = new FakeVoiceSocket();
    const heard: string[] = [];
    const stream = new VoiceStream(socket, DEFAULT_SPEECH, (text) => heard.push(text));
    expect(socket.binaryType).toBe('arraybuffer');
    socket.emit('open');
    expect(socket.commands).toEqual([{ type: 'start', options: DEFAULT_SPEECH }]);
    for (const value of [0.1, 0.2, 0.3]) stream.push(new Float32Array([value]));
    expect(socket.binary).toHaveLength(0);
    socket.reply({ type: 'ready' });
    expect(socket.binary).toHaveLength(2);
    const done = stream.finish();
    socket.reply({ type: 'update', revision: 1, text: { committed: 'hello', tentative: '' } });
    expect(socket.binary).toHaveLength(3);
    expect(new Float32Array(socket.binary[2] as ArrayBuffer)[0]).toBeCloseTo(0.3);
    expect(socket.commands).toHaveLength(1);
    socket.reply({ type: 'update', revision: 2, text: { committed: 'hello', tentative: ' wor' } });
    expect(socket.commands).toHaveLength(1);
    socket.reply({ type: 'update', revision: 3, text: { committed: 'hello world', tentative: '' } });
    expect(socket.commands.at(-1)).toEqual({ type: 'finish' });
    socket.reply({ type: 'finished', text: ' hello world ' });
    expect(await done).toBe('hello world');
    expect(heard).toEqual(['hello', 'hello wor', 'hello world']);
    expect(socket.closed).toBe(true);
  });

  it("fails with T3's own message, and on a closed connection", async () => {
    const socket = new FakeVoiceSocket();
    const stream = new VoiceStream(socket, DEFAULT_SPEECH);
    socket.emit('open');
    socket.reply({ type: 'error', message: 'Live transcription failed. Please try recording again.' });
    await expect(stream.finish()).rejects.toThrow('Live transcription failed.');
    const closing = new FakeVoiceSocket();
    const closed = new VoiceStream(closing, DEFAULT_SPEECH);
    closing.emit('close');
    await expect(closed.finish()).rejects.toThrow('T3 Code ended the voice connection.');
  });

  it('sends nothing more once cancelled', async () => {
    const socket = new FakeVoiceSocket();
    const stream = new VoiceStream(socket, DEFAULT_SPEECH);
    socket.emit('open');
    socket.reply({ type: 'ready' });
    stream.cancel();
    stream.push(new Float32Array([0.5]));
    expect(socket.binary).toHaveLength(0);
    expect(socket.closed).toBe(true);
    await expect(stream.finish()).rejects.toThrow('cancelled');
  });
});
