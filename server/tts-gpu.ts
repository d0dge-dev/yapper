// GPU text-to-speech (Qwen3-TTS via faster-qwen3-tts, see gpu-services/tts). Optional: on when YAP_TTS=gpu.
// Only the agent's reply text goes to YAP_GPU_TTS_URL (run it on your own machine). Errors and timeouts throw, and speech.ts falls back to Piper
// for that sentence. By default every sentence goes as lang "auto": the server tells German from English and reads
// each with that language's own voice (design-m / en-m), so English replies don't get a German accent.
import type { Lang } from "./speech.ts";

const DEFAULT_URL = "http://127.0.0.1:8800";

export interface GpuTts {
  voice(lang: Lang): string;
  synthesize(text: string, lang: Lang): Promise<{ samples: Float32Array; sampleRate: number }>;
  /** PCM pieces while the server generates them (~0.35 s to the first); aborting `signal` stops the server too. */
  stream(text: string, lang: Lang, signal: AbortSignal): AsyncGenerator<{ samples: Float32Array; sampleRate: number }>;
}

const toFloat = (pcm: Int16Array) => {
  const out = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = pcm[i] / 32768;
  return out;
};

export function gpuTtsFromEnv(env: NodeJS.ProcessEnv = process.env): GpuTts | null {
  if (env.YAP_TTS !== "gpu") return null;
  const url = `${(env.YAP_GPU_TTS_URL || DEFAULT_URL).replace(/\/$/, "")}/v1/tts`;
  // Empty = the server's per-language default.
  const voices: Record<Lang, string> = {
    de: env.YAP_GPU_VOICE_DE || env.YAP_GPU_VOICE || "",
    en: env.YAP_GPU_VOICE_EN || env.YAP_GPU_VOICE || "",
  };
  const detect = env.YAP_GPU_LANG !== "fixed";
  const body = (text: string, lang: Lang) =>
    JSON.stringify({ text, lang: detect ? "auto" : lang, ...(voices[lang] ? { voice: voices[lang] } : {}) });
  return {
    voice: (lang) => voices[lang] || (detect ? "auto by language" : `server default (${lang})`),
    async synthesize(text, lang) {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: body(text, lang),
        // The model runs at ~0.4x real time (~25 ms per char); leave room for a queued sentence.
        signal: AbortSignal.timeout(4000 + 60 * text.length),
      });
      if (!res.ok) throw new Error(`gpu tts: HTTP ${res.status} ${(await res.text()).slice(0, 120)}`);
      const sampleRate = Number(res.headers.get("x-sample-rate") || 24000);
      return { samples: toFloat(new Int16Array(await res.arrayBuffer())), sampleRate };
    },
    async *stream(text, lang, signal) {
      const res = await fetch(`${url}/stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: body(text, lang),
        signal: AbortSignal.any([signal, AbortSignal.timeout(4000 + 60 * text.length)]),
      });
      if (!res.ok || !res.body) throw new Error(`gpu tts: HTTP ${res.status} ${(await res.text()).slice(0, 120)}`);
      const sampleRate = Number(res.headers.get("x-sample-rate") || 24000);
      let carry: Uint8Array | null = null; // network reads don't respect 16-bit sample boundaries
      for await (const piece of res.body as unknown as AsyncIterable<Uint8Array>) {
        let bytes = piece;
        if (carry) {
          bytes = new Uint8Array(carry.length + piece.length);
          bytes.set(carry);
          bytes.set(piece, carry.length);
          carry = null;
        }
        const even = bytes.length & ~1;
        if (even < bytes.length) carry = bytes.slice(even);
        if (even === 0) continue;
        const aligned = bytes.slice(0, even); // copy: Int16Array needs an even byte offset
        yield { samples: toFloat(new Int16Array(aligned.buffer, aligned.byteOffset, even / 2)), sampleRate };
      }
    },
  };
}
