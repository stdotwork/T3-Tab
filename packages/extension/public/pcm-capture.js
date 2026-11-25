// The side panel's microphone capture for dictation. It runs in an AudioContext created at 16 kHz, so the browser has
// already resampled the microphone; this mixes it to mono, posts half-second Float32 chunks and a level for the meter,
// and on 'stop' posts what is left, then 'stopped'.
const CHUNK = 8000;

class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.chunk = new Float32Array(CHUNK);
    this.length = 0;
    this.recording = true;
    this.energy = 0;
    this.counted = 0;
    this.port.onmessage = ({ data }) => {
      if (data !== 'stop' || !this.recording) return;
      this.recording = false;
      this.publish();
      this.port.postMessage('stopped');
    };
  }

  publish() {
    if (this.length === 0) return;
    const out = this.chunk.slice(0, this.length);
    this.port.postMessage(out, [out.buffer]);
    this.length = 0;
  }

  process(inputs) {
    if (!this.recording) return false;
    const channels = inputs[0];
    if (channels === undefined || channels.length === 0 || channels[0] === undefined) return true;
    const frames = channels[0].length;
    for (let index = 0; index < frames; index += 1) {
      let sample = 0;
      for (const channel of channels) sample += channel[index];
      sample = Math.max(-1, Math.min(1, sample / channels.length));
      this.chunk[this.length] = sample;
      this.length += 1;
      if (this.length === CHUNK) this.publish();
      this.energy += sample * sample;
      this.counted += 1;
    }
    // About twenty levels a second.
    if (this.counted >= sampleRate / 20) {
      this.port.postMessage({ level: Math.min(1, Math.sqrt(this.energy / this.counted) * 4) });
      this.energy = 0;
      this.counted = 0;
    }
    return true;
  }
}

registerProcessor('t3-tab-pcm-capture', PcmCapture);
