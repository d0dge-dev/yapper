// GPU speech recognition (Whisper large-v3-turbo via faster-whisper, see gpu-services/asr). Optional: on when
// YAP_ASR=gpu. Much better German than Parakeet (names like Jellyfin, Claude, T3 Code come out right). The caller's
// audio goes to YAP_GPU_ASR_URL (run it on your own machine). Errors and timeouts throw, and speech.ts falls back to
// Parakeet for that segment.
import { float32ToInt16 } from "./audio.ts";

const DEFAULT_URL = "http://127.0.0.1:8801";

export interface GpuAsr {
  transcribe(samples: Float32Array): Promise<string>;
}

export function gpuAsrFromEnv(env: NodeJS.ProcessEnv = process.env): GpuAsr | null {
  if (env.YAP_ASR !== "gpu") return null;
  const url = `${(env.YAP_GPU_ASR_URL || DEFAULT_URL).replace(/\/$/, "")}/v1/asr?lang=${env.YAP_GPU_ASR_LANG || "auto"}`;
  return {
    async transcribe(samples) {
      const pcm = float32ToInt16(samples);
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength) as ArrayBuffer,
        // ~0.35 s for a sentence, ~0.7 s for 30 s of audio (int8 on an RTX 3070).
        signal: AbortSignal.timeout(Math.round(2500 + (samples.length / 16000) * 40)),
      });
      if (!res.ok) throw new Error(`gpu asr: HTTP ${res.status} ${(await res.text()).slice(0, 120)}`);
      return String(((await res.json()) as { text?: string }).text ?? "").trim();
    },
  };
}
