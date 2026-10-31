// Benchmarks the local speech stack: TTS a sentence, resample, run it back through VAD + ASR.
import { loadSpeech, ASR_SAMPLE_RATE } from "../server/speech.ts";
import { resample } from "../server/audio.ts";

const t0 = performance.now();
const speech = await loadSpeech();
console.log(`models loaded in ${((performance.now() - t0) / 1000).toFixed(1)}s`);

const samples: Record<"de" | "en", string> = {
  de: "Ich habe die Traefik-Konfiguration angepasst und den Container neu gestartet. Die Tests laufen jetzt durch, soll ich das committen?",
  en: "I updated the Traefik config and restarted the container. The tests pass now, should I commit it?",
};

for (const [lang, text] of Object.entries(samples) as ["de" | "en", string][]) {
  let t = performance.now();
  const audio = await speech.synthesize(text, lang);
  const ttsMs = performance.now() - t;
  const seconds = audio.samples.length / audio.sampleRate;
  console.log(`[${lang}] TTS ${ttsMs.toFixed(0)} ms for ${seconds.toFixed(1)} s audio (RTF ${(ttsMs / 1000 / seconds).toFixed(2)})`);

  const pcm16k = resample(audio.samples, audio.sampleRate, ASR_SAMPLE_RATE);
  const vad = speech.createVad();
  for (let i = 0; i < pcm16k.length; i += 1600) vad.accept(pcm16k.subarray(i, i + 1600));
  vad.accept(new Float32Array(ASR_SAMPLE_RATE)); // trailing silence
  vad.flush();
  const segments = vad.drain();

  t = performance.now();
  const transcript = await speech.transcribe(pcm16k);
  const asrMs = performance.now() - t;
  console.log(`[${lang}] ASR ${asrMs.toFixed(0)} ms (RTF ${(asrMs / 1000 / seconds).toFixed(2)}), VAD segments: ${segments.length}`);
  console.log(`[${lang}]   said: ${text}`);
  console.log(`[${lang}]  heard: ${transcript}`);
}
