// Small PCM helpers shared by the call session and scripts.

/** Linear-interpolation resampler; good enough for speech going into ASR. */
export function resample(input: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return input;
  const ratio = from / to;
  const out = new Float32Array(Math.floor(input.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const pos = i * ratio;
    const j = Math.floor(pos);
    const frac = pos - j;
    out[i] = (input[j] ?? 0) * (1 - frac) + (input[j + 1] ?? input[j] ?? 0) * frac;
  }
  return out;
}

export function int16ToFloat32(buf: Buffer): Float32Array {
  const view = new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 2));
  const out = new Float32Array(view.length);
  for (let i = 0; i < view.length; i++) out[i] = view[i] / 32768;
  return out;
}

export function float32ToInt16(samples: Float32Array): Buffer {
  const out = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    out.writeInt16LE(Math.round(s < 0 ? s * 32768 : s * 32767), i * 2);
  }
  return out;
}

// Windowed-sinc kernels for `resampleSinc`, by cutoff; 512 phases × 32 taps (scaled for downsampling).
const PHASES = 512;
const kernels = new Map<number, { taps: number; table: Float32Array }>();

function kernel(cutoff: number) {
  let k = kernels.get(cutoff);
  if (k) return k;
  const half = Math.ceil(16 / cutoff);
  const taps = 2 * half;
  const table = new Float32Array(PHASES * taps);
  for (let p = 0; p < PHASES; p++) {
    const frac = p / PHASES;
    for (let t = 0; t < taps; t++) {
      const x = t - half + 1 - frac; // distance from the output position, in input samples
      const sinc = x === 0 ? 1 : Math.sin(Math.PI * x * cutoff) / (Math.PI * x * cutoff);
      const window = 0.5 * (1 + Math.cos((Math.PI * x) / half));
      table[p * taps + t] = cutoff * sinc * window;
    }
  }
  kernels.set(cutoff, (k = { taps, table }));
  return k;
}

/** Band-limited resampler (polyphase windowed sinc) for audio people listen to, e.g. TTS → 48 kHz Opus. */
export function resampleSinc(input: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return input;
  const ratio = from / to;
  const { taps, table } = kernel(Math.min(1, to / from) * 0.95);
  const half = taps / 2;
  const out = new Float32Array(Math.floor(input.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const pos = i * ratio;
    const base = Math.floor(pos);
    const row = Math.floor((pos - base) * PHASES) * taps;
    let sum = 0;
    for (let t = 0, j = base - half + 1; t < taps; t++, j++) if (j >= 0 && j < input.length) sum += input[j] * table[row + t];
    out[i] = sum;
  }
  return out;
}

/**
 * resampleSinc for audio that arrives in pieces (streamed TTS). Resampling each piece on its own treats the samples
 * beyond its edges as silence, which clicks at every boundary; this keeps the tail of the input and only emits output
 * whose whole kernel has arrived. end() emits the rest.
 */
export class SincStream {
  private readonly ratio: number;
  private readonly taps: number;
  private readonly table: Float32Array;
  private buf = new Float32Array(0);
  private bufStart = 0; // input index of buf[0]
  private received = 0; // input samples so far
  private nextOut = 0; // output index of the next sample to emit

  constructor(from: number, to: number) {
    this.ratio = from / to;
    const k = kernel(Math.min(1, to / from) * 0.95);
    this.taps = k.taps;
    this.table = k.table;
  }

  push(input: Float32Array): Float32Array {
    const merged = new Float32Array(this.buf.length + input.length);
    merged.set(this.buf);
    merged.set(input, this.buf.length);
    this.buf = merged;
    this.received += input.length;
    return this.emit(false);
  }

  end(): Float32Array {
    return this.emit(true);
  }

  private emit(final: boolean): Float32Array {
    const half = this.taps / 2;
    const total = Math.floor(this.received / this.ratio);
    const out: number[] = [];
    for (; this.nextOut < total; this.nextOut++) {
      const pos = this.nextOut * this.ratio;
      const base = Math.floor(pos);
      if (!final && base + half >= this.received) break; // kernel not complete yet
      const row = Math.floor((pos - base) * PHASES) * this.taps;
      let sum = 0;
      for (let t = 0, j = base - half + 1; t < this.taps; t++, j++) {
        const k = j - this.bufStart;
        if (k >= 0 && k < this.buf.length) sum += this.buf[k] * this.table[row + t];
      }
      out.push(sum);
    }
    // Keep what the next output's kernel still needs.
    const keepFrom = Math.max(this.bufStart, Math.floor(this.nextOut * this.ratio) - half + 1);
    this.buf = this.buf.slice(keepFrom - this.bufStart);
    this.bufStart = keepFrom;
    return Float32Array.from(out);
  }
}
