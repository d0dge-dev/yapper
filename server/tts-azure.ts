// Azure AI Speech text-to-speech (REST). Optional: on when YAP_TTS=azure and AZURE_SPEECH_KEY/REGION are set.
// Only the agent's reply text goes to Azure, never the caller's audio. Errors and timeouts (including an exhausted
// free tier) throw, and speech.ts falls back to Piper for that sentence.
import type { Lang } from "./speech.ts";

const SAMPLE_RATE = 24000;
// Multilingual voices read English terms inside German sentences (Traefik, steer, …) without switching accent.
const DEFAULT_VOICES: Record<Lang, string> = {
  de: "de-DE-FlorianMultilingualNeural",
  en: "de-DE-FlorianMultilingualNeural",
};
const XML_LANG: Record<Lang, string> = { de: "de-DE", en: "en-US" };

const escapeXml = (s: string) =>
  s.replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c]!);

export interface AzureTts {
  voice(lang: Lang): string;
  synthesize(text: string, lang: Lang): Promise<{ samples: Float32Array; sampleRate: number }>;
}

export function azureTtsFromEnv(env: NodeJS.ProcessEnv = process.env): AzureTts | null {
  if (env.YAP_TTS !== "azure") return null;
  const key = env.AZURE_SPEECH_KEY;
  const region = env.AZURE_SPEECH_REGION;
  if (!key || !region) throw new Error("YAP_TTS=azure needs AZURE_SPEECH_KEY and AZURE_SPEECH_REGION");
  const voices: Record<Lang, string> = {
    de: env.YAP_AZURE_VOICE_DE || DEFAULT_VOICES.de,
    en: env.YAP_AZURE_VOICE_EN || DEFAULT_VOICES.en,
  };
  const url = `https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`;
  return {
    voice: (lang) => voices[lang],
    async synthesize(text, lang) {
      const voice = voices[lang];
      const ssml =
        `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${XML_LANG[lang]}">` +
        `<voice name="${voice}"><lang xml:lang="${XML_LANG[lang]}">${escapeXml(text)}</lang></voice></speak>`;
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Ocp-Apim-Subscription-Key": key,
          "Content-Type": "application/ssml+xml",
          "X-Microsoft-OutputFormat": "raw-24khz-16bit-mono-pcm",
          "User-Agent": "yapper",
        },
        body: ssml,
        signal: AbortSignal.timeout(4000),
      });
      if (!res.ok) throw new Error(`azure tts: HTTP ${res.status} ${(await res.text()).slice(0, 120)}`);
      const pcm = new Int16Array(await res.arrayBuffer());
      const samples = new Float32Array(pcm.length);
      for (let i = 0; i < pcm.length; i++) samples[i] = pcm[i] / 32768;
      return { samples, sampleRate: SAMPLE_RATE };
    },
  };
}
