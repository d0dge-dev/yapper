// Local speech: Silero VAD, Parakeet TDT v3 ASR and Piper TTS through sherpa-onnx.
// Everything runs on the CPU of this machine; no audio leaves it.

import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { cpus } from "node:os";
import { azureTtsFromEnv } from "./tts-azure.ts";
import { gpuTtsFromEnv } from "./tts-gpu.ts";
import { gpuAsrFromEnv } from "./asr-gpu.ts";

const require = createRequire(import.meta.url);
const sherpa = require("sherpa-onnx-node");

export const ASR_SAMPLE_RATE = 16000;
const THREADS = Math.max(2, Math.min(8, cpus().length - 2));

export type Lang = "de" | "en";

export interface SpeechEngine {
  transcribe(samples: Float32Array): Promise<string>;
  /** Re-run recognition over a whole multi-segment utterance. Helps Parakeet (more context); with Whisper the
   *  per-segment text was better (2026-10-27: "Jellyfin, T3 Code, Proxmox" became "Delisim, K3 Code, Smogs"). */
  readonly retranscribe: boolean;
  synthesize(text: string, lang: Lang): Promise<{ samples: Float32Array; sampleRate: number }>;
  /** Like synthesize, but in pieces as they are made (GPU voice); other engines yield one piece. */
  synthesizeStream(text: string, lang: Lang, signal: AbortSignal): AsyncGenerator<{ samples: Float32Array; sampleRate: number }>;
  createVad(): VadStream;
}

export interface VadStream {
  accept(samples: Float32Array): void;
  /** True while the VAD currently hears speech. */
  speaking(): boolean;
  /** Completed speech segments since the last call. */
  drain(): Float32Array[];
  flush(): void;
  reset(): void;
}

const VOICES: Record<Lang, string> = {
  de: "vits-piper-de_DE-thorsten-high/de_DE-thorsten-high.onnx",
  en: "vits-piper-en_US-lessac-medium/en_US-lessac-medium.onnx",
};

export async function loadSpeech(): Promise<SpeechEngine> {
  // YAP_MODELS: model dir (scripts/fetch-models.sh); default ./models.
  const MODELS = process.env.YAP_MODELS ? `${resolve(process.env.YAP_MODELS)}/` : fileURLToPath(new URL("../models/", import.meta.url));
  const asrDir = `${MODELS}sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8/`;
  const recognizer = await sherpa.OfflineRecognizer.createAsync({
    featConfig: { sampleRate: ASR_SAMPLE_RATE, featureDim: 80 },
    modelConfig: {
      transducer: {
        encoder: `${asrDir}encoder.int8.onnx`,
        decoder: `${asrDir}decoder.int8.onnx`,
        joiner: `${asrDir}joiner.int8.onnx`,
      },
      tokens: `${asrDir}tokens.txt`,
      numThreads: THREADS,
      provider: "cpu",
      modelType: "nemo_transducer",
      debug: 0,
    },
  });

  const tts = new Map<Lang, any>();
  for (const [lang, model] of Object.entries(VOICES) as [Lang, string][]) {
    const dir = model.slice(0, model.indexOf("/") + 1);
    tts.set(
      lang,
      await sherpa.OfflineTts.createAsync({
        model: {
          vits: { model: `${MODELS}${model}`, tokens: `${MODELS}${dir}tokens.txt`, dataDir: `${MODELS}${dir}espeak-ng-data` },
          numThreads: THREADS,
          provider: "cpu",
          debug: 0,
        },
        maxNumSentences: 1,
      }),
    );
  }

  // ASR and TTS share the CPU; run one job at a time so neither starves the other.
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(job: () => Promise<T>): Promise<T> => {
    const next = queue.then(job, job);
    queue = next.catch(() => undefined);
    return next;
  };

  const piper = (text: string, lang: Lang) =>
    serial(async () => {
      const engine = tts.get(lang)!;
      const audio = await engine.generateAsync({ text, sid: 0, speed: 1.0 });
      return { samples: audio.samples as Float32Array, sampleRate: audio.sampleRate as number };
    });
  // YAP_TTS=azure or gpu; either one falls back to Piper per sentence.
  const gpu = gpuTtsFromEnv();
  const remote = azureTtsFromEnv() ?? gpu;
  if (remote) console.log(`${new Date().toISOString()} tts: ${process.env.YAP_TTS} (${remote.voice("de")}), piper as fallback`);

  const synthesize = async (text: string, lang: Lang) => {
    if (remote) {
      try {
        return await remote.synthesize(text, lang);
      } catch (e) {
        // Piper keeps the call talking; the log shows how often the remote voice failed.
        console.log(`${new Date().toISOString()} tts fallback to piper: ${(e as Error).message}`);
      }
    }
    return piper(text, lang);
  };

  const parakeet = (samples: Float32Array) =>
    serial(async () => {
      const stream = recognizer.createStream();
      stream.acceptWaveform({ sampleRate: ASR_SAMPLE_RATE, samples });
      await recognizer.decodeAsync(stream);
      return String(recognizer.getResult(stream).text ?? "").trim();
    });
  // YAP_ASR=gpu: Whisper on the GPU service, Parakeet per segment when it fails.
  const whisper = gpuAsrFromEnv();
  if (whisper) console.log(`${new Date().toISOString()} asr: gpu (whisper), parakeet as fallback`);

  return {
    retranscribe: !whisper,
    transcribe: async (samples) => {
      if (whisper) {
        try {
          return await whisper.transcribe(samples);
        } catch (e) {
          console.log(`${new Date().toISOString()} asr fallback to parakeet: ${(e as Error).message}`);
        }
      }
      return parakeet(samples);
    },
    synthesize,
    async *synthesizeStream(text, lang, signal) {
      if (gpu) {
        let started = false;
        try {
          for await (const piece of gpu.stream(text, lang, signal)) {
            started = true;
            yield piece;
          }
          return;
        } catch (e) {
          if (signal.aborted) return;
          console.log(`${new Date().toISOString()} tts stream ${started ? "cut off" : "fallback to piper"}: ${(e as Error).message}`);
          if (!started) yield await piper(text, lang); // after half a sentence, repeating it from the start would be worse
          return;
        }
      }
      yield await synthesize(text, lang);
    },
    createVad: () => {
      const vad = new sherpa.Vad(
        {
          sileroVad: {
            model: `${MODELS}silero_vad.onnx`,
            threshold: 0.5,
            minSpeechDuration: 0.25,
            minSilenceDuration: 0.6,
            maxSpeechDuration: 25,
            windowSize: 512,
          },
          sampleRate: ASR_SAMPLE_RATE,
          numThreads: 1,
          provider: "cpu",
          debug: 0,
        },
        60,
      );
      // Silero consumes fixed 512-sample windows; buffer whatever the browser sends.
      let pending = new Float32Array(0);
      return {
        accept(samples) {
          const merged = new Float32Array(pending.length + samples.length);
          merged.set(pending);
          merged.set(samples, pending.length);
          let offset = 0;
          for (; offset + 512 <= merged.length; offset += 512) vad.acceptWaveform(merged.subarray(offset, offset + 512));
          pending = merged.slice(offset);
        },
        speaking: () => vad.isDetected(),
        drain() {
          const out: Float32Array[] = [];
          while (!vad.isEmpty()) {
            out.push(Float32Array.from(vad.front(false).samples));
            vad.pop();
          }
          return out;
        },
        flush: () => vad.flush(),
        reset: () => {
          pending = new Float32Array(0);
          vad.reset();
        },
      };
    },
  };
}
