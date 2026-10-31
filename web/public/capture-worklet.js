// Captures mic audio, resamples to 16 kHz mono and posts 100 ms Int16 chunks.
const TARGET_RATE = 16000;
const CHUNK = 1600;

class Capture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / TARGET_RATE;
    this.pos = 0;
    this.buf = new Int16Array(CHUNK);
    this.fill = 0;
    this.carry = new Float32Array(0);
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel) return true;
    // Prepend the previous block's tail so interpolation works across blocks.
    const input = new Float32Array(this.carry.length + channel.length);
    input.set(this.carry);
    input.set(channel, this.carry.length);
    let pos = this.pos;
    while (pos + 1 < input.length) {
      const i = Math.floor(pos);
      const frac = pos - i;
      const s = input[i] * (1 - frac) + input[i + 1] * frac;
      this.buf[this.fill++] = Math.max(-32768, Math.min(32767, Math.round(s * 32767)));
      if (this.fill === CHUNK) {
        this.port.postMessage(this.buf.buffer, [this.buf.buffer]);
        this.buf = new Int16Array(CHUNK);
        this.fill = 0;
      }
      pos += this.ratio;
    }
    const keep = Math.floor(pos);
    this.carry = input.slice(keep);
    this.pos = pos - keep;
    return true;
  }
}

registerProcessor("capture", Capture);
